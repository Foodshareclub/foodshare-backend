//! Schema types and DDL generation for motherduck-sync.


use serde::{Deserialize, Serialize};
use std::fmt;

/// Database schema definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Schema {
    /// Schema name
    pub name: String,
    /// Tables in this schema
    pub tables: Vec<Table>,
}

impl Schema {
    /// Create a new schema.
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            tables: Vec::new(),
        }
    }

    /// Add a table to the schema.
    pub fn add_table(&mut self, table: Table) {
        self.tables.push(table);
    }

    /// Get a table by name.
    pub fn get_table(&self, name: &str) -> Option<&Table> {
        self.tables.iter().find(|t| t.name == name)
    }
}

/// Table definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Table {
    /// Table name
    pub name: String,
    /// Columns
    pub columns: Vec<Column>,
    /// Primary key columns
    pub primary_key: Vec<String>,
    /// Indexes
    pub indexes: Vec<Index>,
}

impl Table {
    /// Create a new table.
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            columns: Vec::new(),
            primary_key: Vec::new(),
            indexes: Vec::new(),
        }
    }

    /// Add a column.
    pub fn add_column(&mut self, column: Column) {
        self.columns.push(column);
    }

    /// Set primary key.
    pub fn set_primary_key(&mut self, columns: Vec<String>) {
        self.primary_key = columns;
    }

    /// Add an index.
    pub fn add_index(&mut self, index: Index) {
        self.indexes.push(index);
    }

    /// Generate CREATE TABLE DDL for DuckDB/MotherDuck.
    pub fn to_duckdb_ddl(&self) -> String {
        let mut ddl = format!("CREATE TABLE IF NOT EXISTS {} (\n", self.name);

        let col_defs: Vec<String> = self
            .columns
            .iter()
            .map(|c| format!("    {} {}{}", c.name, c.column_type.to_duckdb(), c.constraints_ddl()))
            .collect();

        ddl.push_str(&col_defs.join(",\n"));

        if !self.primary_key.is_empty() {
            ddl.push_str(&format!(",\n    PRIMARY KEY ({})", self.primary_key.join(", ")));
        }

        ddl.push_str("\n)");
        ddl
    }

    /// Get column by name.
    pub fn get_column(&self, name: &str) -> Option<&Column> {
        self.columns.iter().find(|c| c.name == name)
    }
}

/// Column definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Column {
    /// Column name
    pub name: String,
    /// Column type
    pub column_type: ColumnType,
    /// Is nullable
    pub nullable: bool,
    /// Default value
    pub default: Option<String>,
    /// Is unique
    pub unique: bool,
}

impl Column {
    /// Create a new column.
    pub fn new(name: impl Into<String>, column_type: ColumnType) -> Self {
        Self {
            name: name.into(),
            column_type,
            nullable: true,
            default: None,
            unique: false,
        }
    }

    /// Set nullable.
    pub fn nullable(mut self, nullable: bool) -> Self {
        self.nullable = nullable;
        self
    }

    /// Set default value.
    pub fn default(mut self, default: impl Into<String>) -> Self {
        self.default = Some(default.into());
        self
    }

    /// Set unique.
    pub fn unique(mut self, unique: bool) -> Self {
        self.unique = unique;
        self
    }

    /// Generate constraint DDL.
    fn constraints_ddl(&self) -> String {
        let mut constraints = Vec::new();

        if !self.nullable {
            constraints.push("NOT NULL".to_string());
        }

        if self.unique {
            constraints.push("UNIQUE".to_string());
        }

        if let Some(ref default) = self.default {
            constraints.push(format!("DEFAULT {}", default));
        }

        if constraints.is_empty() {
            String::new()
        } else {
            format!(" {}", constraints.join(" "))
        }
    }
}

/// Column types supported by both PostgreSQL and DuckDB.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ColumnType {
    /// Boolean
    Boolean,
    /// Small integer (2 bytes)
    SmallInt,
    /// Integer (4 bytes)
    Integer,
    /// Big integer (8 bytes)
    BigInt,
    /// Single precision float
    Real,
    /// Double precision float
    Double,
    /// Decimal/Numeric with precision and scale
    Decimal { precision: u8, scale: u8 },
    /// Variable-length string
    Varchar { max_length: Option<u32> },
    /// Text (unlimited length)
    Text,
    /// Date
    Date,
    /// Time
    Time,
    /// Timestamp without timezone
    Timestamp,
    /// Timestamp with timezone
    TimestampTz,
    /// UUID
    Uuid,
    /// JSON
    Json,
    /// Binary data
    Blob,
}

impl ColumnType {
    /// Convert to DuckDB type string.
    pub fn to_duckdb(&self) -> &'static str {
        match self {
            ColumnType::Boolean => "BOOLEAN",
            ColumnType::SmallInt => "SMALLINT",
            ColumnType::Integer => "INTEGER",
            ColumnType::BigInt => "BIGINT",
            ColumnType::Real => "REAL",
            ColumnType::Double => "DOUBLE",
            ColumnType::Decimal { .. } => "DECIMAL",
            ColumnType::Varchar { .. } => "VARCHAR",
            ColumnType::Text => "VARCHAR",
            ColumnType::Date => "DATE",
            ColumnType::Time => "TIME",
            ColumnType::Timestamp => "TIMESTAMP",
            ColumnType::TimestampTz => "TIMESTAMPTZ",
            ColumnType::Uuid => "VARCHAR",
            ColumnType::Json => "JSON",
            ColumnType::Blob => "BLOB",
        }
    }

    /// Parse from PostgreSQL type name.
    pub fn from_postgres(pg_type: &str) -> Self {
        let normalized = pg_type.to_lowercase();
        match normalized.as_str() {
            "boolean" | "bool" => ColumnType::Boolean,
            "smallint" | "int2" => ColumnType::SmallInt,
            "integer" | "int" | "int4" => ColumnType::Integer,
            "bigint" | "int8" => ColumnType::BigInt,
            "real" | "float4" => ColumnType::Real,
            "double precision" | "float8" => ColumnType::Double,
            "date" => ColumnType::Date,
            "time" | "time without time zone" => ColumnType::Time,
            "timestamp" | "timestamp without time zone" => ColumnType::Timestamp,
            "timestamp with time zone" | "timestamptz" => ColumnType::TimestampTz,
            "uuid" => ColumnType::Uuid,
            "json" | "jsonb" => ColumnType::Json,
            "bytea" => ColumnType::Blob,
            "text" => ColumnType::Text,
            s if s.starts_with("character varying") || s.starts_with("varchar") => {
                ColumnType::Varchar { max_length: None }
            }
            s if s.starts_with("numeric") || s.starts_with("decimal") => {
                ColumnType::Decimal { precision: 38, scale: 9 }
            }
            _ => ColumnType::Text, // Default fallback
        }
    }
}

impl fmt::Display for ColumnType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.to_duckdb())
    }
}

/// Index definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Index {
    /// Index name
    pub name: String,
    /// Columns in the index
    pub columns: Vec<String>,
    /// Is unique index
    pub unique: bool,
}

impl Index {
    /// Create a new index.
    pub fn new(name: impl Into<String>, columns: Vec<String>) -> Self {
        Self {
            name: name.into(),
            columns,
            unique: false,
        }
    }

    /// Set unique.
    pub fn unique(mut self, unique: bool) -> Self {
        self.unique = unique;
        self
    }

    /// Generate CREATE INDEX DDL.
    pub fn to_ddl(&self, table_name: &str) -> String {
        let unique = if self.unique { "UNIQUE " } else { "" };
        format!(
            "CREATE {}INDEX IF NOT EXISTS {} ON {} ({})",
            unique,
            self.name,
            table_name,
            self.columns.join(", ")
        )
    }
}

/// Schema introspection result.
#[derive(Debug, Clone)]
pub struct IntrospectedColumn {
    /// Column name
    pub name: String,
    /// PostgreSQL type
    pub pg_type: String,
    /// Is nullable
    pub nullable: bool,
    /// Default value
    pub default: Option<String>,
    /// Is primary key
    pub is_primary_key: bool,
}

impl IntrospectedColumn {
    /// Convert to Column.
    pub fn to_column(&self) -> Column {
        Column {
            name: self.name.clone(),
            column_type: ColumnType::from_postgres(&self.pg_type),
            nullable: self.nullable,
            default: self.default.clone(),
            unique: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_table_ddl() {
        let mut table = Table::new("test_table");
        table.add_column(Column::new("id", ColumnType::Integer).nullable(false));
        table.add_column(Column::new("name", ColumnType::Varchar { max_length: Some(255) }));
        table.add_column(Column::new("created_at", ColumnType::TimestampTz));
        table.set_primary_key(vec!["id".to_string()]);

        let ddl = table.to_duckdb_ddl();
        assert!(ddl.contains("CREATE TABLE IF NOT EXISTS test_table"));
        assert!(ddl.contains("id INTEGER NOT NULL"));
        assert!(ddl.contains("PRIMARY KEY (id)"));
    }

    #[test]
    fn test_column_type_from_postgres() {
        assert_eq!(ColumnType::from_postgres("integer"), ColumnType::Integer);
        assert_eq!(ColumnType::from_postgres("timestamptz"), ColumnType::TimestampTz);
        assert_eq!(ColumnType::from_postgres("jsonb"), ColumnType::Json);
    }
}
