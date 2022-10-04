import throttle from 'lodash.throttle'

import { AuthState } from '../auth/index'
import { DatabaseAdapter } from '../electric/adapter'
import { Migrator } from '../migrators/index'
import { AuthStateNotification, Change, Notifier } from '../notifiers/index'
import { AckType, Client } from './index'
import { QualifiedTablename } from '../util/tablename'
import { DbName, Relation, RelationsCache, SatelliteError, SqlValue, Transaction } from '../util/types'

import { Satellite } from './index'
import { SatelliteOpts } from './config'
import { mergeChangesLastWriteWins, mergeOpTypesAddWins } from './merge'
import { OPTYPES, OplogEntry, OplogTableChanges, operationsToTableChanges, fromTransaction, toTransactions } from './oplog'
import { SatRelation_RelationType } from '../_generated/proto/satellite'

type ChangeAccumulator = {
  [key: string]: Change
}

export class SatelliteProcess implements Satellite {
  dbName: DbName
  adapter: DatabaseAdapter
  migrator: Migrator
  notifier: Notifier
  client: Client

  opts: SatelliteOpts

  _authState?: AuthState
  _authStateSubscription?: string

  _lastSnapshotTimestamp?: Date
  _pollingInterval?: any
  _potentialDataChangeSubscription?: string
  _throttledSnapshot: () => void

  _lastAckdRowId: number
  _lastSentRowId: number
  _lsn: string

  relations: RelationsCache

  constructor(dbName: DbName, adapter: DatabaseAdapter, migrator: Migrator, notifier: Notifier, client: Client, opts: SatelliteOpts) {
    this.dbName = dbName
    this.adapter = adapter
    this.migrator = migrator
    this.notifier = notifier
    this.client = client

    this.opts = opts

    this._lastAckdRowId = 0
    this._lastSentRowId = 0
    this._lsn = "0"

    // Create a throttled function that performs a snapshot at most every
    // `minSnapshotWindow` ms. This function runs immediately when you
    // first call it and then every `minSnapshotWindow` ms as long as
    // you keep calling it within the window. If you don't call it within
    // the window, it will then run immediately the next time you call it.
    const snapshot = this._performSnapshot.bind(this)
    const throttleOpts = {leading: true, trailing: true}
    this._throttledSnapshot = throttle(snapshot, opts.minSnapshotWindow, throttleOpts)

    this.relations = {}
  }

  // XXX kick off the satellite process
  //
  // - [x] poll the ops table
  // - [x] subscribe to data changes
  // - [ ] handle auth state
  // - [x] establish replication connection
  // - [ ] ...
  //
  async start(authState?: AuthState): Promise<void | Error> {
    await this.migrator.up()

    const isVerified = await this._verifyTableStructure()
    if (!isVerified) {
      throw new Error('Invalid database schema.')
    }

    if (authState !== undefined) {
      this._authState = authState
    }

    if (this._authStateSubscription === undefined) {
      const handler = this._updateAuthState.bind(this)
      this._authStateSubscription = this.notifier.subscribeToAuthStateChanges(handler)
    }

    // XXX establish replication connection,
    // validate auth state, etc here.

    // Request a snapshot whenever the data in our database potentially changes.
    this._potentialDataChangeSubscription = this.notifier.subscribeToPotentialDataChanges(this._throttledSnapshot)

    // Start polling to request a snapshot every `pollingInterval` ms.
    this._pollingInterval = setInterval(this._throttledSnapshot, this.opts.pollingInterval)

    // Starting now!
    setTimeout(this._throttledSnapshot, 0)

    // Need to reload primary keys after schema migration
    // For now, we do it only at initialization
    this.relations = await this._getLocalRelations()
    this.client.subscribeToTransactions(async (transaction: Transaction) => {
      this._applyTransaction(transaction)
    })

    // When a transaction is sent, or an acknowledgement is 
    // received, we update the rowid records.
    this.client.subscribeToAck(async (rowid, type) => {
      await this._ack(Number(rowid), type == AckType.PERSISTED)
    })

    const lastAckdRowId = await this._getMeta('lastAckdRowId')
    const lastSentRowId = await this._getMeta('lastSentRowId')
    this._lsn = await this._getMeta('lsn')

    this._lastSentRowId = Number(lastSentRowId)
    this._lastAckdRowId - Number(lastAckdRowId)
    this.client.setOutboundLogPositions(lastSentRowId, lastAckdRowId)

    return this.client.connect()
      .then(() => this.client.authenticate())
      .then(() => this.client.startReplication(this._lsn)) 
  }

  // Unsubscribe from data changes and stop polling
  async stop(): Promise<void> {
    if (this._pollingInterval !== undefined) {
      clearInterval(this._pollingInterval)
      this._pollingInterval = undefined
    }

    if (this._potentialDataChangeSubscription !== undefined) {
      this.notifier.unsubscribeFromPotentialDataChanges(this._potentialDataChangeSubscription)
      this._potentialDataChangeSubscription = undefined
    }

    await this.client.close();
  }

  async _verifyTableStructure(): Promise<boolean> {
    const meta = this.opts.metaTable.tablename
    const oplog = this.opts.oplogTable.tablename

    const tablesExist = `
      SELECT count(name) as numTables FROM sqlite_master
        WHERE type='table'
          AND name IN (?, ?)
    `

    const [{ numTables }] = await this.adapter.query(tablesExist, [meta, oplog])
    return numTables === 2
  }

  // Handle auth state changes.
  async _updateAuthState({ authState }: AuthStateNotification): Promise<void> {
    // XXX do whatever we need to stop/start or reconnect the replication
    // connection with the new auth state.

    // XXX Maybe we need to auto-start processing and/or replication
    // when we get the right authState?

    this._authState = authState
  }

  // Perform a snapshot and notify which data actually changed.
  async _performSnapshot(): Promise<void> {
    const oplog = this.opts.oplogTable.toString()
    const timestamp = new Date().toISOString()

    const updateTimestamps = `
      UPDATE ${oplog} set timestamp = '${timestamp}'
        WHERE rowid in (
          SELECT rowid FROM ${oplog}
            WHERE timestamp is NULL
              AND rowid > ${this._lastAckdRowId}
            ORDER BY rowid ASC
        )
    `

    const selectChanges = `
      SELECT * FROM ${oplog}
        WHERE timestamp = ?
        ORDER BY rowid ASC
    `

    await this.adapter.run(updateTimestamps)
    const rows = await this.adapter.query(selectChanges, [timestamp])
    const results = rows as unknown as OplogEntry[]

    if (results.length === 0) {
      return
    }

    await Promise.all([
      this._notifyChanges(results),
      this._replicateSnapshotChanges(results)
    ])
  }
  async _notifyChanges(results: OplogEntry[]): Promise<void> {
    const acc: ChangeAccumulator = {}

    // Would it be quicker to do this using a second SQL query that
    // returns results in `Change` format?!
    const reduceFn = (acc: ChangeAccumulator, entry: OplogEntry) => {
      const qt = new QualifiedTablename(entry.namespace, entry.tablename)
      const key = qt.toString()

      if (key in acc) {
        const change: Change = acc[key]

        if (change.rowids === undefined) {
          change.rowids = []
        }

        change.rowids.push(entry.rowid)
      }
      else {
        acc[key] = {
          qualifiedTablename: qt,
          rowids: [entry.rowid]
        }
      }

      return acc
    }

    const changes = Object.values(results.reduce(reduceFn, acc))
    this.notifier.actuallyChanged(this.dbName, changes)
  }
  async _replicateSnapshotChanges(results: OplogEntry[]): Promise<void | SatelliteError> {
    const transactions = toTransactions(results, this.relations)
    for (const txn of transactions) {
      return this.client.enqueueTransaction(txn);
    }
  }

  // Apply a set of incoming transactions against pending local operations,
  // applying conflict resolution rules. Takes all changes per each key
  // before merging, for local and remote operations.
  async _apply(incoming: OplogEntry[], _lsn: string = "0"): Promise<void> {
    // assign timestamp to pending operations before apply
    await this._performSnapshot()

    const local = await this._getEntries()
    const merged = this._mergeEntries(local, incoming)

    const stmts: string[] = []

    for (const [tablenameStr, mapping] of Object.entries(merged)) {
      for (const entryChanges of Object.values(mapping)) {
        const { changes, primaryKeyCols, optype } = entryChanges

        if (optype === OPTYPES.delete) {
          const clauses = Object.entries(primaryKeyCols).map(([key, value]) => {
            return typeof value === 'number'
              ? `${key} = ${value}`
              : `${key} = '${value}'`
          })

          const deleteStmt = `
            DELETE FROM ${tablenameStr}
              WHERE ${clauses.join(' AND ')}
          `

          stmts.push(deleteStmt)
        }
        else { // XXX Does this code need to handle types more reliably?
          const columnNames = Object.keys(changes)
          const columnValues = Object.values(changes).map(({ value }) => {
            return typeof value === 'number'
              ? `${value}`
              : `'${value}'`
          })
          const updateColumnStmts = columnNames.map((name, i) => `${name} = ${columnValues[i]}`)

          const insertStmt = `
            INSERT INTO ${tablenameStr}
              (${columnNames.join(', ')})
              VALUES (${columnValues.join(', ')})
              ON CONFLICT DO UPDATE SET ${updateColumnStmts.join(', ')}
          `

          stmts.push(insertStmt)
        }
      }
    }

    // TODO: finish storing LSN
    // const toHexString = (byteArray: string) => {
    //   var s = '';
    //   byteArray.split('').forEach(function (byte, i) {
    //     s += ('0' + (byte.charCodeAt(0) & 0xFF).toString(16)).slice(-2);
    //   });
    //   return s;
    // }

    const sql = `
      PRAGMA defer_foreign_keys = ON;
      BEGIN;
        ${stmts.join('; ')};
        UPDATE ${this.opts.metaTable.tablename} set value=x'0000' WHERE key='lsn';
      COMMIT;
      PRAGMA defer_foreign_keys = OFF;
    `

    const tablenames = Object.keys(merged)
    await this._disableTriggers(tablenames)
    await this.adapter.run(sql)
    await this._enableTriggers(tablenames)
  }

  async _getEntries(since?: number): Promise<OplogEntry[]> {
    if (since === undefined) {
      since = this._lastAckdRowId
    }
    const oplog = this.opts.oplogTable.toString()

    const selectEntries = `
      SELECT * FROM ${oplog}
        WHERE timestamp IS NOT NULL
          AND rowid > ?
        ORDER BY rowid ASC
    `

    const rows = await this.adapter.query(selectEntries, [since])
    return rows as unknown as OplogEntry[]
  }

  // Merge changes, with last-write-wins and add-wins semantics.
  _mergeEntries(local: OplogEntry[], incoming: OplogEntry[]): OplogTableChanges {
    const localTableChanges = operationsToTableChanges(local)
    const incomingTableChanges = operationsToTableChanges(incoming)

    for (const [tablename, incomingMapping] of Object.entries(incomingTableChanges)) {
      const localMapping = localTableChanges[tablename]

      if (localMapping === undefined) {
        continue
      }

      for (const [primaryKey, incomingChanges] of Object.entries(incomingMapping)) {
        const localChanges = localMapping[primaryKey]

        if (localChanges === undefined) {
          continue
        }

        const changes = mergeChangesLastWriteWins(localChanges.changes, incomingChanges.changes)
        const optype = mergeOpTypesAddWins(localChanges.optype, incomingChanges.optype)

        Object.assign(incomingChanges, { changes, optype })
      }
    }

    return incomingTableChanges
  }

  async _applyTransaction(transaction: Transaction) {
    const opLogEntries = fromTransaction(transaction, this.relations)

    await this._apply(opLogEntries, transaction.lsn)
    this._notifyChanges(opLogEntries)
  }

  async _disableTriggers(tablenames: string[]): Promise<void> {
    return this._updateTriggerSettings(tablenames, 0)
  }
  async _enableTriggers(tablenames: string[]): Promise<void> {
    return this._updateTriggerSettings(tablenames, 1)
  }
  async _updateTriggerSettings(tablenames: string[], flag: 0 | 1): Promise<void> {
    const triggers = this.opts.triggersTable.toString()
    const stmts = tablenames.map((tablenameStr) => `
      UPDATE ${triggers}
         SET flag = ${flag}
       WHERE tablename = '${tablenameStr}'
    `)

    await this.adapter.run(stmts.join('; '))
  }

  // Clean up the oplog and update `this._lastAckdRowId`.
  async _sent(rowId: number,): Promise<void> {
    const meta = this.opts.metaTable.toString()

    const sql = `
      UPDATE ${meta}
         SET value=${rowId}
       WHERE key='lastSentRowId'
    `

    await this.adapter.run(sql)
    this._lastAckdRowId = rowId
  }

  async _ack(rowId: number, isAckRowId: boolean): Promise<void> {
    const lastAckd = this._lastAckdRowId
    const lastSent = this._lastSentRowId

    if (rowId < lastAckd || (rowId > lastSent && isAckRowId)) {
      throw new Error('Invalid position')
    }

    const meta = this.opts.metaTable.toString()

    let sql = `
      UPDATE ${meta} 
        SET value='${rowId}' 
      WHERE key='${ isAckRowId ? 'lastAckdRowId' : 'lastSentRowId'}'`

    if (isAckRowId) {
      const oplog = this.opts.oplogTable.toString()
      sql = `DELETE 
              FROM ${oplog}
            WHERE rowid <= ${rowId}; ${sql}`
    }

    await this.adapter.run(sql)
    this._lastAckdRowId = rowId
  }

  async _setMeta(key: string, value: SqlValue): Promise<void> {
    const meta = this.opts.metaTable.toString()

    const sql = `
      UPDATE ${meta}
         SET value='${value}'
       WHERE key='${key}'
    `

    await this.adapter.run(sql)
  }

  // TODO: need to support different value types
  async _getMeta(key: string): Promise<string> {
    const meta = this.opts.metaTable.toString()
    const sql = `SELECT value from ${meta} WHERE key='${key}';`

    return await this.adapter.query(sql).then(rows => {
      return rows[0]!.value!.toString()
    })
  }

  // Fetch primary keys from local store and use them to identify incoming ops.
  // TODO: Improve this code once with Migrator and consider simplifying oplog.
  private async _getLocalRelations(): Promise<{ [k: string]: Relation }> {
    const notIn = [
      `'${this.opts.metaTable.tablename.toString()}'`,
      `'${this.opts.migrationsTable.tablename.toString()}'`,
      `'${this.opts.oplogTable.tablename.toString()}'`,
      `'${this.opts.triggersTable.tablename.toString()}'`,
      `'sqlite_schema'`,
      `'sqlite_sequence'`,
      `'sqlite_temp_schema'`,
    ]

    const tables = `SELECT name FROM pragma_table_list() 
                      WHERE name NOT IN (${notIn.join(",")})
                    `
    const columnsFor = (table: string) =>
      `SELECT * FROM pragma_table_info('${table}')`
    const tableNames = await this.adapter.query(tables)

    const relations: RelationsCache = {}

    let id = 0
    const schema = 'public' // TODO
    for (const table of tableNames) {
      const tableName = table.name as any
      const sql = columnsFor(tableName)
      const columnsForTable = await this.adapter.query(sql)
      if (columnsForTable.length == 0) {
        continue
      }
      const relation: Relation = {
        id: id++,
        schema: schema,
        table: tableName,
        tableType: SatRelation_RelationType.TABLE,
        columns: []
      }
      for (const c of columnsForTable) {
        relation.columns.push({ name: c.name!.toString(), type: c.type!.toString(), primaryKey: Boolean(c.pk!.valueOf()) })
      }
      relations[`${tableName}`] = relation
    }    

    return Promise.resolve(relations)
  }
}