//! MotherDuck client and operations for motherduck-sync.

use crate::config::{MotherDuckConfig, TableMapping};
use crate::error::{Error, Result};
use crate::schema::Table;
use duckdb::Connection;
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use tracing::{debug, info, instrument, warn};

/// MotherDuck client wrapper.
pub struct MotherDuckClient {
    conn: Connection,
    config: MotherDuckConfig,
}

impl MotherDuckClient {
    /// Connect to MotherDuck.
    #[instrument(skip(config), fields(database = %config.database))]
    pub fn connect(config: MotherDuckConfig) -> Result<Self> {
        info!("Connecting to MotherDuck...");

        // First connect without specifying database to create it if needed
        if config.create_database {
            let init_conn_str = format!("md:?motherduck_token={}", config.token);
            let init_conn = Connection::open(&init_conn_str)
                .map_err(|e| Error::motherduck_connection("Failed to connect to MotherDuck", e))?;
            
            // Create database if it doesn't exist
            let create_db = format!("CREATE DATABASE IF NOT EXISTS {}", config.database);
            init_conn.execute(&create_db, [])
                .map_err(|e| Error::motherduck_query("", "Failed to create database", e))?;
            
            info!("Ensured database exists: {}", config.database);
        }

        // Now connect to the specific database
        let conn_str = format!(
            "md:{}?motherduck_token={}",
            config.database, config.token
        );

        let conn = Connection::open(&conn_str)
            .map_err(|e| Error::motherduck_connection("Failed to connect to database", e))?;

        info!("Connected to MotherDuck database: {}", config.database);
        Ok(Self { conn, config })
    }

    /// Test connectivity.
    pub fn ping(&self) -> Result<()> {
        self.conn
            .execute("SELECT 1", [])
            .map_err(|e| Error::motherduck_query("", "Ping failed", e))?;
        Ok(())
    }

    /// Ensure schema exists.
    pub fn ensure_schema(&self) -> Result<()> {
        if self.config.schema != "main" {
            let query = format!("CREATE SCHEMA IF NOT EXISTS {}", self.config.schema);
            self.conn
                .execute(&query, [])
                .map_err(|e| Error::motherduck_query("", "Create schema failed", e))?;
        }
        Ok(())
    }

    /// Create table if not exists.
    #[instrument(skip(self), fields(table = %table.name))]
    pub fn create_table(&self, table: &Table) -> Result<()> {
        let ddl = table.to_duckdb_ddl();
        debug!("Creating table with DDL: {}", ddl);

        self.conn
            .execute(&ddl, [])
            .map_err(|e| Error::motherduck_query(&table.name, "Create table failed", e))?;

        info!("Created/verified table: {}", table.name);
        Ok(())
    }

    /// Create default analytics tables.
    pub fn create_analytics_tables(&self) -> Result<()> {
        self.conn.execute_batch(r#"
            -- Raw data tables for analytics queries
            CREATE TABLE IF NOT EXISTS full_users (
                id VARCHAR PRIMARY KEY,
                nickname VARCHAR,
                email VARCHAR,
                avatar_url VARCHAR,
                bio TEXT,
                is_active BOOLEAN DEFAULT true,
                is_verified BOOLEAN DEFAULT false,
                last_seen_at TIMESTAMP,
                created_at TIMESTAMP,
                updated_at TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS full_listings (
                id INTEGER PRIMARY KEY,
                profile_id VARCHAR,
                post_name VARCHAR,
                post_description TEXT,
                post_type VARCHAR,
                post_address VARCHAR,
                latitude DOUBLE,
                longitude DOUBLE,
                is_active BOOLEAN DEFAULT true,
                is_arranged BOOLEAN DEFAULT false,
                post_arranged_to VARCHAR,
                post_arranged_at TIMESTAMP,
                post_views INTEGER DEFAULT 0,
                post_like_counter INTEGER DEFAULT 0,
                created_at TIMESTAMP,
                updated_at TIMESTAMP
            );

            -- Events table for tracking
            CREATE TABLE IF NOT EXISTS events (
                id VARCHAR PRIMARY KEY,
                event_name VARCHAR,
                user_id VARCHAR,
                properties JSON,
                timestamp TIMESTAMP
            );

            -- Sync metadata
            CREATE TABLE IF NOT EXISTS sync_metadata (
                table_name VARCHAR PRIMARY KEY,
                last_sync_at TIMESTAMP,
                records_synced INTEGER,
                sync_mode VARCHAR
            );

            -- Aggregated analytics tables
            CREATE TABLE IF NOT EXISTS daily_stats (
                date DATE PRIMARY KEY,
                new_users INTEGER,
                active_users INTEGER,
                returning_users INTEGER,
                new_listings INTEGER,
                completed_shares INTEGER,
                messages_sent INTEGER,
                top_categories JSON,
                computed_at TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS user_activity_summary (
                user_id VARCHAR PRIMARY KEY,
                listings_viewed INTEGER,
                listings_saved INTEGER,
                messages_initiated INTEGER,
                shares_completed INTEGER,
                last_activity_at TIMESTAMP,
                updated_at TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS post_activity_daily_stats (
                id VARCHAR PRIMARY KEY,
                date DATE,
                post_type VARCHAR,
                posts_viewed INTEGER,
                posts_arranged INTEGER,
                total_likes INTEGER,
                updated_at TIMESTAMP
            );
        "#).map_err(|e| Error::motherduck_query("", "Create analytics tables failed", e))?;

        info!("Created/verified analytics tables");
        Ok(())
    }

    /// Insert or replace rows using bulk VALUES syntax for better performance.
    #[instrument(skip(self, rows), fields(table = %mapping.target_table, count = rows.len()))]
    pub fn upsert_rows(
        &self,
        mapping: &TableMapping,
        rows: &[HashMap<String, JsonValue>],
    ) -> Result<usize> {
        if rows.is_empty() {
            return Ok(0);
        }

        // Get column names from first row (sorted for consistency)
        let mut columns: Vec<&String> = rows[0].keys().collect();
        columns.sort();
        let col_names = columns.iter().map(|c| c.as_str()).collect::<Vec<_>>().join(", ");

        // Build bulk VALUES clause for all rows
        let mut values_parts: Vec<String> = Vec::with_capacity(rows.len());
        for row in rows {
            let row_values: Vec<String> = columns
                .iter()
                .map(|col| {
                    let value = row.get(*col).unwrap_or(&JsonValue::Null);
                    json_to_sql_literal(value)
                })
                .collect();
            values_parts.push(format!("({})", row_values.join(", ")));
        }

        let query = format!(
            "INSERT OR REPLACE INTO {} ({}) VALUES {}",
            mapping.target_table, col_names, values_parts.join(", ")
        );

        self.conn
            .execute(&query, [])
            .map_err(|e| Error::motherduck_query(&mapping.target_table, "Bulk insert failed", e))?;

        debug!("Bulk upserted {} rows to {}", rows.len(), mapping.target_table);
        Ok(rows.len())
    }

    /// Batch upsert with transaction.
    #[instrument(skip(self, rows), fields(table = %mapping.target_table, count = rows.len()))]
    pub fn batch_upsert(
        &self,
        mapping: &TableMapping,
        rows: &[HashMap<String, JsonValue>],
        batch_size: usize,
    ) -> Result<usize> {
        if rows.is_empty() {
            return Ok(0);
        }

        let mut total = 0;

        // Process in batches
        for chunk in rows.chunks(batch_size) {
            // Start transaction
            self.conn
                .execute("BEGIN TRANSACTION", [])
                .map_err(|e| Error::motherduck_query(&mapping.target_table, "Begin transaction failed", e))?;

            match self.upsert_rows(mapping, chunk) {
                Ok(count) => {
                    self.conn
                        .execute("COMMIT", [])
                        .map_err(|e| Error::motherduck_query(&mapping.target_table, "Commit failed", e))?;
                    total += count;
                }
                Err(e) => {
                    let _ = self.conn.execute("ROLLBACK", []);
                    return Err(e);
                }
            }
        }

        info!("Batch upserted {} rows to {}", total, mapping.target_table);
        Ok(total)
    }

    /// Get row count for a table.
    pub fn count_rows(&self, table: &str) -> Result<i64> {
        let query = format!("SELECT COUNT(*) FROM {}", table);
        let mut stmt = self.conn
            .prepare(&query)
            .map_err(|e| Error::motherduck_query(table, "Prepare count failed", e))?;

        let count: i64 = stmt
            .query_row([], |row| row.get(0))
            .map_err(|e| Error::motherduck_query(table, "Count failed", e))?;

        Ok(count)
    }

    /// Check if table exists.
    pub fn table_exists(&self, table: &str) -> Result<bool> {
        let query = format!(
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = '{}'",
            table
        );

        let mut stmt = self.conn
            .prepare(&query)
            .map_err(|e| Error::motherduck_query(table, "Check table exists failed", e))?;

        let count: i64 = stmt
            .query_row([], |row| row.get(0))
            .map_err(|e| Error::motherduck_query(table, "Check table exists failed", e))?;

        Ok(count > 0)
    }

    /// Execute raw SQL.
    pub fn execute(&self, sql: &str) -> Result<usize> {
        self.conn
            .execute(sql, [])
            .map_err(|e| Error::motherduck_query("", "Execute failed", e))
    }

    /// Execute batch SQL.
    pub fn execute_batch(&self, sql: &str) -> Result<()> {
        self.conn
            .execute_batch(sql)
            .map_err(|e| Error::motherduck_query("", "Execute batch failed", e))
    }

    /// Get a reference to the underlying connection for advanced queries.
    pub fn connection(&self) -> &Connection {
        &self.conn
    }
}

/// Convert JSON value to SQL string representation.
fn json_to_sql_string(value: &JsonValue) -> String {
    match value {
        JsonValue::Null => "NULL".to_string(),
        JsonValue::Bool(b) => b.to_string(),
        JsonValue::Number(n) => n.to_string(),
        JsonValue::String(s) => s.clone(),
        JsonValue::Array(_) | JsonValue::Object(_) => value.to_string(),
    }
}

/// Convert JSON value to SQL literal (properly escaped for direct SQL insertion).
fn json_to_sql_literal(value: &JsonValue) -> String {
    match value {
        JsonValue::Null => "NULL".to_string(),
        JsonValue::Bool(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
        JsonValue::Number(n) => n.to_string(),
        JsonValue::String(s) => {
            // Escape single quotes by doubling them
            let escaped = s.replace('\'', "''");
            format!("'{}'", escaped)
        }
        JsonValue::Array(_) | JsonValue::Object(_) => {
            // JSON values need to be escaped and quoted
            let json_str = value.to_string().replace('\'', "''");
            format!("'{}'", json_str)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_json_to_sql_string() {
        assert_eq!(json_to_sql_string(&JsonValue::Null), "NULL");
        assert_eq!(json_to_sql_string(&JsonValue::Bool(true)), "true");
        assert_eq!(json_to_sql_string(&JsonValue::Number(42.into())), "42");
        assert_eq!(json_to_sql_string(&JsonValue::String("test".into())), "test");
    }
}
