//! PostgreSQL client and operations for motherduck-sync.

use crate::config::{PostgresConfig, TableMapping};
use crate::error::{Error, Result};
use crate::schema::IntrospectedColumn;
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use tokio_postgres::{Client, Row};
use tracing::{debug, info, instrument};

#[cfg(feature = "tls-native")]
use native_tls::TlsConnector;
#[cfg(feature = "tls-native")]
use postgres_native_tls::MakeTlsConnector;

/// PostgreSQL client wrapper.
pub struct PostgresClient {
    client: Client,
    #[allow(dead_code)]
    config: PostgresConfig,
}

impl PostgresClient {
    /// Connect to PostgreSQL.
    #[instrument(skip(config), fields(url = %mask_url(&config.url)))]
    pub async fn connect(config: PostgresConfig) -> Result<Self> {
        info!("Connecting to PostgreSQL...");

        #[cfg(feature = "tls-native")]
        let (client, connection) = {
            let connector = TlsConnector::builder()
                .danger_accept_invalid_certs(true) // Supabase pooler uses self-signed certs
                .build()
                .map_err(|e| Error::postgres_connection("TLS setup failed", e))?;
            let connector = MakeTlsConnector::new(connector);
            tokio_postgres::connect(&config.url, connector)
                .await
                .map_err(|e| Error::postgres_connection("Failed to connect", e))?
        };

        #[cfg(not(feature = "tls-native"))]
        let (client, connection) = {
            tokio_postgres::connect(&config.url, tokio_postgres::NoTls)
                .await
                .map_err(|e| Error::postgres_connection("Failed to connect", e))?
        };

        // Spawn connection handler
        tokio::spawn(async move {
            if let Err(e) = connection.await {
                tracing::error!("PostgreSQL connection error: {}", e);
            }
        });

        info!("Connected to PostgreSQL");
        Ok(Self { client, config })
    }

    /// Test connectivity.
    pub async fn ping(&self) -> Result<()> {
        self.client
            .query_one("SELECT 1", &[])
            .await
            .map_err(|e| Error::postgres_query("", "Ping failed", e))?;
        Ok(())
    }

    /// Get table row count.
    pub async fn count_rows(&self, table: &str, filter: Option<&str>) -> Result<i64> {
        let query = match filter {
            Some(f) => format!("SELECT COUNT(*) FROM {} WHERE {}", table, f),
            None => format!("SELECT COUNT(*) FROM {}", table),
        };

        let row = self.client
            .query_one(&query, &[])
            .await
            .map_err(|e| Error::postgres_query(table, "Count failed", e))?;

        Ok(row.get(0))
    }

    /// Fetch rows from a table.
    #[instrument(skip(self), fields(table = %mapping.source_table))]
    pub async fn fetch_rows(
        &self,
        mapping: &TableMapping,
        full_sync: bool,
        limit: Option<usize>,
    ) -> Result<Vec<HashMap<String, JsonValue>>> {
        let mut conditions = Vec::new();

        if !full_sync {
            conditions.push(format!("NOT {}", mapping.sync_flag_column));
        }

        if let Some(ref filter) = mapping.filter {
            conditions.push(filter.clone());
        }

        let where_clause = if conditions.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", conditions.join(" AND "))
        };

        let order_clause = mapping
            .order_by
            .as_ref()
            .map(|o| format!(" ORDER BY {}", o))
            .unwrap_or_default();

        let limit_clause = limit
            .map(|l| format!(" LIMIT {}", l))
            .unwrap_or_default();

        let query = format!(
            "SELECT * FROM {}{}{}{}",
            mapping.source_table, where_clause, order_clause, limit_clause
        );

        debug!("Executing query: {}", query);

        let rows = self.client
            .simple_query(&query)
            .await
            .map_err(|e| Error::postgres_query(&mapping.source_table, format!("Fetch failed: {}", e), e))?;

        // Convert SimpleQueryMessage to rows
        let mut results = Vec::new();
        for msg in rows {
            if let tokio_postgres::SimpleQueryMessage::Row(row) = msg {
                results.push(simple_row_to_json(&row, &mapping.sync_flag_column));
            }
        }

        debug!("Fetched {} rows from {}", results.len(), mapping.source_table);
        Ok(results)
    }

    /// Mark rows as synced.
    #[instrument(skip(self, ids), fields(table = %mapping.source_table, count = ids.len()))]
    pub async fn mark_synced(
        &self,
        mapping: &TableMapping,
        ids: &[String],
    ) -> Result<u64> {
        if ids.is_empty() {
            return Ok(0);
        }

        let pk_col = &mapping.primary_key[0];
        let placeholders: Vec<String> = (1..=ids.len()).map(|i| format!("${}", i)).collect();

        // Use text comparison for flexibility with different PK types
        let query = format!(
            "UPDATE {} SET {} = TRUE WHERE {}::text = ANY($1)",
            mapping.source_table,
            mapping.sync_flag_column,
            pk_col,
        );

        let affected = self.client
            .execute(&query, &[&ids])
            .await
            .map_err(|e| Error::postgres_query(&mapping.source_table, "Mark synced failed", e))?;

        debug!("Marked {} rows as synced in {}", affected, mapping.source_table);
        Ok(affected)
    }

    /// Introspect table schema.
    pub async fn introspect_table(&self, table: &str) -> Result<Vec<IntrospectedColumn>> {
        let query = r#"
            SELECT 
                c.column_name,
                c.data_type,
                c.is_nullable = 'YES' as nullable,
                c.column_default,
                COALESCE(pk.is_pk, false) as is_primary_key
            FROM information_schema.columns c
            LEFT JOIN (
                SELECT kcu.column_name, true as is_pk
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu 
                    ON tc.constraint_name = kcu.constraint_name
                WHERE tc.table_name = $1 AND tc.constraint_type = 'PRIMARY KEY'
            ) pk ON c.column_name = pk.column_name
            WHERE c.table_name = $1
            ORDER BY c.ordinal_position
        "#;

        let rows = self.client
            .query(query, &[&table])
            .await
            .map_err(|e| Error::postgres_query(table, "Introspection failed", e))?;

        let columns: Vec<IntrospectedColumn> = rows
            .iter()
            .map(|row| IntrospectedColumn {
                name: row.get("column_name"),
                pg_type: row.get("data_type"),
                nullable: row.get("nullable"),
                default: row.get("column_default"),
                is_primary_key: row.get("is_primary_key"),
            })
            .collect();

        Ok(columns)
    }

    /// Get unsynced count for a table.
    pub async fn unsynced_count(&self, mapping: &TableMapping) -> Result<i64> {
        let filter = format!("NOT {}", mapping.sync_flag_column);
        self.count_rows(&mapping.source_table, Some(&filter)).await
    }
}

/// Convert a PostgreSQL row to JSON map.
fn row_to_json(row: &Row, skip_column: &str) -> HashMap<String, JsonValue> {
    let mut map = HashMap::new();

    for (i, column) in row.columns().iter().enumerate() {
        let name = column.name();
        
        // Skip the sync flag column
        if name == skip_column {
            continue;
        }

        let type_name = column.type_().name();
        let value = match type_name {
            "bool" => row.get::<_, Option<bool>>(i).map(JsonValue::Bool),
            "int2" => row.get::<_, Option<i16>>(i).map(|v| JsonValue::Number(v.into())),
            "int4" => row.get::<_, Option<i32>>(i).map(|v| JsonValue::Number(v.into())),
            "int8" => row.get::<_, Option<i64>>(i).map(|v| JsonValue::Number(v.into())),
            "float4" => row.get::<_, Option<f32>>(i)
                .and_then(|v| serde_json::Number::from_f64(v as f64))
                .map(JsonValue::Number),
            "float8" | "numeric" => row.get::<_, Option<f64>>(i)
                .and_then(|v| serde_json::Number::from_f64(v))
                .map(JsonValue::Number),
            "text" | "varchar" | "char" | "name" | "bpchar" => {
                row.get::<_, Option<String>>(i).map(JsonValue::String)
            }
            "date" => row.get::<_, Option<chrono::NaiveDate>>(i)
                .map(|d| JsonValue::String(d.to_string())),
            "timestamp" => row.get::<_, Option<chrono::NaiveDateTime>>(i)
                .map(|d| JsonValue::String(d.to_string())),
            "timestamptz" => row.get::<_, Option<chrono::DateTime<chrono::Utc>>>(i)
                .map(|d| JsonValue::String(d.to_rfc3339())),
            "uuid" => row.get::<_, Option<uuid::Uuid>>(i)
                .map(|u| JsonValue::String(u.to_string())),
            "json" | "jsonb" => row.get::<_, Option<JsonValue>>(i),
            "_text" | "_varchar" => {
                // Array types - convert to JSON array
                row.get::<_, Option<Vec<String>>>(i)
                    .map(|arr| JsonValue::Array(arr.into_iter().map(JsonValue::String).collect()))
            }
            _ => {
                // Try to get as string for unknown types
                debug!("Unknown type '{}' for column '{}', trying as string", type_name, name);
                row.try_get::<_, Option<String>>(i)
                    .ok()
                    .flatten()
                    .map(JsonValue::String)
            }
        };

        map.insert(name.to_string(), value.unwrap_or(JsonValue::Null));
    }

    map
}

/// Convert a SimpleQueryRow to JSON map (for simple_query mode).
fn simple_row_to_json(row: &tokio_postgres::SimpleQueryRow, skip_column: &str) -> HashMap<String, JsonValue> {
    let mut map = HashMap::new();

    for (i, column) in row.columns().iter().enumerate() {
        let name = column.name();
        
        // Skip the sync flag column
        if name == skip_column {
            continue;
        }

        // In simple query mode, all values come as strings
        let value = row.get(i)
            .map(|s: &str| JsonValue::String(s.to_string()))
            .unwrap_or(JsonValue::Null);

        map.insert(name.to_string(), value);
    }

    map
}

/// Mask sensitive parts of URL for logging.
fn mask_url(url: &str) -> String {
    if let Ok(mut parsed) = url::Url::parse(url) {
        if parsed.password().is_some() {
            let _ = parsed.set_password(Some("***"));
        }
        parsed.to_string()
    } else {
        "[invalid url]".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mask_url() {
        let url = "postgres://user:secret@localhost:5432/db";
        let masked = mask_url(url);
        assert!(masked.contains("***"));
        assert!(!masked.contains("secret"));
    }
}
