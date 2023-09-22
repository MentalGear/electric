defmodule Electric.Postgres.Extension.Functions do
  @moduledoc """
  This module organizes SQL functions that are to be defined in Electric's internal database schema.
  """

  require EEx

  sql_files =
    "functions/*.sql*"
    |> Path.expand(__DIR__)
    |> Path.wildcard()

  for path <- sql_files, do: @external_resource(path)

  @function_defs Map.new(sql_files, fn path ->
                   filename = Path.basename(path)
                   name_sans_extension = String.replace(filename, ~r/\.sql(\.eex)?$/, "")
                   {name_sans_extension, {filename, File.read!(path)}}
                 end)

  @typep name :: String.t()
  @typep sql :: String.t()
  @type function_list :: [{name, sql}]

  @doc """
  Get a list of `{name, SQL}` pairs where the the SQL code contains the definition of a function that has to be created
  prior to applying extension migrations.

  Every function in the list is defined as `CREATE OR REPLACE FUNCTION`.
  """
  @spec before_migrations :: function_list
  def before_migrations do
    for {name, args} <- [{"validate_table_column_types", []}] do
      {name, by_name(name, args)}
    end
  end

  @doc """
  Get a list of `{name, SQL}` pairs where the the SQL code contains the definition of a function (or multiple functions)
  that has to be created after all extension migrations have been applied to the database.

  Every function in the list is defined as `CREATE OR REPLACE FUNCTION`.
  """
  @spec after_migrations :: function_list
  def after_migrations do
    for {name, args} <- [{"perform_reordered_op_installer_function", []}] do
      {name, by_name(name, args)}
    end
  end

  @doc """
  Look up the SQL code for a function by its extension-less filename.

  We catalog all function definitions as files inside the `functions/` subdirectory. A single file usually contains a
  single function definition but may have more than one if they are all meant to be evaluated as a unit. Some of those
  files may be EEx templates, in which case their extension is `.sql.eex`. Others may contain plain SQL code, in which
  case the file extension is just `.sql`.

  The `name` argument is the file name without extension.
  """
  @spec by_name(String.t(), list()) :: sql
  def by_name(name, args \\ []) do
    {filename, sql} = Map.fetch!(@function_defs, name)
    eval_sql_template(sql, args, filename)
  end

  ###

  defp eval_sql_template(sql, args, filename) do
    case Path.extname(filename) do
      ".eex" -> EEx.eval_string(sql, args, file: filename)
      ".sql" -> sql
    end
  end
end
