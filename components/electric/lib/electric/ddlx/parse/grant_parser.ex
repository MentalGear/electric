defmodule Electric.DDLX.Parse.GrantParser do
  alias Electric.DDLX.Parse.Element
  alias Electric.DDLX.Command.Grant
  import Electric.DDLX.Parse.Common

  @keywords [
    "electric",
    "grant",
    "select",
    "insert",
    "update",
    "delete",
    "all",
    "read",
    "write",
    "on",
    "to",
    "using",
    "check"
  ]

  @elements [
    %Element{required: true, type: "keyword", options: ["electric"], name: nil},
    %Element{required: true, type: "keyword", options: ["grant"], name: "command"},
    %Element{
      required: true,
      type: "keyword",
      options: ["select", "insert", "update", "delete", "all", "read", "write"],
      name: "privilege"
    },
    %Element{
      required: false,
      type: "value",
      options: nil,
      name: "columns",
      valueType: :collection
    },
    %Element{required: true, type: "kv", options: ["on"], name: "table", valueType: :name},
    %Element{required: true, type: "kv", options: ["to"], name: "role", valueType: :string},
    %Element{
      required: false,
      type: "kv",
      options: ["using"],
      name: "using",
      valueType: [:name, :path]
    },
    %Element{
      required: false,
      type: "kv",
      options: ["check"],
      name: "check",
      valueType: :collection
    }
  ]

  use Electric.DDLX.Parse.Common

  def matches(statement) do
    String.starts_with?(statement, "electric grant")
  end

  def make_from_values(values) do
    privilege = get_value(values, "privilege")
    columns = get_value(values, "columns")
    scope_role = get_value(values, "role")
    privileges = expand_privileges(privilege)

    columns_names =
      if columns == nil do
        ["*"]
      else
        for part <- String.split(columns, ",") do
          String.trim(part)
        end
      end

    {scope, role} = scope_and_role(scope_role)
    {schema_name, table_name} = schema_and_table(get_value(values, "table"), @default_schema)

    {
      :ok,
      for priv <- privileges do
        %Grant{
          privilege: priv,
          on_table: "#{schema_name}.#{table_name}",
          role: role,
          scope: scope,
          column_names: columns_names,
          using_path: get_value(values, "using"),
          check_fn: get_value(values, "check")
        }
      end
    }
  end
end
