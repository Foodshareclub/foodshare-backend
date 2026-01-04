//! Configuration types and builders for motherduck-sync.

use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;
use url::Url;
use validator::Validate;

/// Main configuration for the sync client.
#[derive(Debug, Clone, Serialize, Deserialize, Validate)]
pub struct SyncConfig {
    /// PostgreSQL connection configuration
    #[validate(nested)]
    pub postgres: PostgresConfig,

    /// MotherDuck connection configuration
    #[validate(nested)]
    pub motherduck: MotherDuckConfig,

    /// Sync behavior configuration
    #[validate(nested)]
    pub sync: SyncBehaviorConfig,

    /// Table mappings (source -> target)
    #[validate(nested)]
    pub tables: Vec<TableMapping>,

    /// Retry configuration
    #[validate(nested)]
    pub retry: RetryConfig,

    /// Logging configuration
    pub logging: LoggingConfig,
}

impl SyncConfig {
    /// Create a new configuration builder.
    pub fn builder() -> SyncConfigBuilder {
        SyncConfigBuilder::default()
    }

    /// Load configuration from environment variables.
    pub fn from_env() -> Result<Self> {
        let postgres_url = std::env::var("DATABASE_URL")
            .or_else(|_| std::env::var("POSTGRES_URL"))
            .map_err(|_| Error::config("DATABASE_URL or POSTGRES_URL not set"))?;

        let motherduck_token = std::env::var("MOTHERDUCK_TOKEN")
            .map_err(|_| Error::config("MOTHERDUCK_TOKEN not set"))?;

        let motherduck_database = std::env::var("MOTHERDUCK_DATABASE")
            .unwrap_or_else(|_| "analytics".to_string());

        Self::builder()
            .postgres_url(&postgres_url)
            .motherduck_token(&motherduck_token)
            .motherduck_database(&motherduck_database)
            .build()
    }

    /// Load configuration from a TOML file.
    pub fn from_file(path: &str) -> Result<Self> {
        let content = std::fs::read_to_string(path)
            .map_err(|e| Error::config(format!("Failed to read {}: {}", path, e)))?;
        
        let config: Self = toml::from_str(&content)
            .map_err(|e| Error::config(format!("Failed to parse {}: {}", path, e)))?;
        
        config.validate()?;
        Ok(config)
    }

    /// Validate the configuration.
    pub fn validate(&self) -> Result<()> {
        Validate::validate(self)
            .map_err(|e| Error::validation(format!("Config validation failed: {}", e)))
    }
}


/// PostgreSQL connection configuration.
#[derive(Debug, Clone, Serialize, Deserialize, Validate)]
pub struct PostgresConfig {
    /// Connection URL
    #[validate(length(min = 1))]
    pub url: String,

    /// Connection pool size
    #[validate(range(min = 1, max = 100))]
    #[serde(default = "default_pool_size")]
    pub pool_size: u32,

    /// Connection timeout in seconds
    #[serde(default = "default_timeout_secs")]
    pub connect_timeout_secs: u64,

    /// SSL mode
    #[serde(default)]
    pub ssl_mode: SslMode,
}

impl Default for PostgresConfig {
    fn default() -> Self {
        Self {
            url: String::new(),
            pool_size: default_pool_size(),
            connect_timeout_secs: default_timeout_secs(),
            ssl_mode: SslMode::default(),
        }
    }
}

/// SSL mode for PostgreSQL.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SslMode {
    Disable,
    #[default]
    Prefer,
    Require,
}

/// MotherDuck connection configuration.
#[derive(Debug, Clone, Serialize, Deserialize, Validate)]
pub struct MotherDuckConfig {
    /// Access token
    #[validate(length(min = 1))]
    #[serde(skip_serializing)]
    pub token: String,

    /// Database name
    #[validate(length(min = 1, max = 128))]
    #[serde(default = "default_database")]
    pub database: String,

    /// Schema name
    #[serde(default = "default_schema")]
    pub schema: String,

    /// Create database if not exists
    #[serde(default = "default_true")]
    pub create_database: bool,
}

impl Default for MotherDuckConfig {
    fn default() -> Self {
        Self {
            token: String::new(),
            database: default_database(),
            schema: default_schema(),
            create_database: true,
        }
    }
}

/// Sync behavior configuration.
#[derive(Debug, Clone, Serialize, Deserialize, Validate)]
pub struct SyncBehaviorConfig {
    /// Batch size for inserts
    #[validate(range(min = 1, max = 100000))]
    #[serde(default = "default_batch_size")]
    pub batch_size: usize,

    /// Use transactions
    #[serde(default = "default_true")]
    pub use_transactions: bool,

    /// Mark records as synced
    #[serde(default = "default_true")]
    pub mark_synced: bool,

    /// Sync flag column name
    #[serde(default = "default_sync_flag")]
    pub sync_flag_column: String,

    /// Auto-create target tables
    #[serde(default = "default_true")]
    pub auto_create_tables: bool,

    /// Max records per sync (0 = unlimited)
    #[serde(default)]
    pub max_records: usize,
}

impl Default for SyncBehaviorConfig {
    fn default() -> Self {
        Self {
            batch_size: default_batch_size(),
            use_transactions: true,
            mark_synced: true,
            sync_flag_column: default_sync_flag(),
            auto_create_tables: true,
            max_records: 0,
        }
    }
}


/// Table mapping configuration.
#[derive(Debug, Clone, Serialize, Deserialize, Validate)]
pub struct TableMapping {
    /// Source table in PostgreSQL
    #[validate(length(min = 1, max = 128))]
    pub source_table: String,

    /// Target table in MotherDuck
    #[validate(length(min = 1, max = 128))]
    pub target_table: String,

    /// Primary key column(s)
    #[validate(length(min = 1))]
    pub primary_key: Vec<String>,

    /// Sync flag column
    #[serde(default = "default_sync_flag")]
    pub sync_flag_column: String,

    /// Columns to sync (empty = all)
    #[serde(default)]
    pub columns: Vec<String>,

    /// Column mappings (source -> target)
    #[serde(default)]
    pub column_mappings: HashMap<String, String>,

    /// Filter clause
    #[serde(default)]
    pub filter: Option<String>,

    /// Order by clause
    #[serde(default)]
    pub order_by: Option<String>,

    /// Enabled
    #[serde(default = "default_true")]
    pub enabled: bool,
}

impl TableMapping {
    /// Create a builder.
    pub fn builder() -> TableMappingBuilder {
        TableMappingBuilder::default()
    }

    /// Get target column name.
    pub fn target_column<'a>(&'a self, source: &'a str) -> &'a str {
        self.column_mappings.get(source).map(|s| s.as_str()).unwrap_or(source)
    }
}

/// Builder for TableMapping.
#[derive(Debug, Default)]
pub struct TableMappingBuilder {
    source_table: Option<String>,
    target_table: Option<String>,
    primary_key: Vec<String>,
    sync_flag_column: Option<String>,
    columns: Vec<String>,
    column_mappings: HashMap<String, String>,
    filter: Option<String>,
    order_by: Option<String>,
    enabled: bool,
}

impl TableMappingBuilder {
    pub fn source_table(mut self, name: impl Into<String>) -> Self {
        self.source_table = Some(name.into());
        self
    }

    pub fn target_table(mut self, name: impl Into<String>) -> Self {
        self.target_table = Some(name.into());
        self
    }

    pub fn primary_key(mut self, cols: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.primary_key = cols.into_iter().map(|c| c.into()).collect();
        self
    }

    pub fn primary_key_column(mut self, col: impl Into<String>) -> Self {
        self.primary_key = vec![col.into()];
        self
    }

    pub fn sync_flag_column(mut self, col: impl Into<String>) -> Self {
        self.sync_flag_column = Some(col.into());
        self
    }

    pub fn columns(mut self, cols: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.columns = cols.into_iter().map(|c| c.into()).collect();
        self
    }

    pub fn map_column(mut self, src: impl Into<String>, tgt: impl Into<String>) -> Self {
        self.column_mappings.insert(src.into(), tgt.into());
        self
    }

    pub fn filter(mut self, f: impl Into<String>) -> Self {
        self.filter = Some(f.into());
        self
    }

    pub fn order_by(mut self, o: impl Into<String>) -> Self {
        self.order_by = Some(o.into());
        self
    }

    pub fn enabled(mut self, e: bool) -> Self {
        self.enabled = e;
        self
    }

    pub fn build(self) -> Result<TableMapping> {
        let source = self.source_table.ok_or_else(|| Error::config("source_table required"))?;
        let target = self.target_table.unwrap_or_else(|| source.clone());

        if self.primary_key.is_empty() {
            return Err(Error::config("primary_key required"));
        }

        Ok(TableMapping {
            source_table: source,
            target_table: target,
            primary_key: self.primary_key,
            sync_flag_column: self.sync_flag_column.unwrap_or_else(default_sync_flag),
            columns: self.columns,
            column_mappings: self.column_mappings,
            filter: self.filter,
            order_by: self.order_by,
            enabled: self.enabled,
        })
    }
}


/// Retry configuration.
#[derive(Debug, Clone, Serialize, Deserialize, Validate)]
pub struct RetryConfig {
    /// Max retry attempts
    #[validate(range(min = 0, max = 10))]
    #[serde(default = "default_max_retries")]
    pub max_retries: u32,

    /// Initial backoff in milliseconds
    #[serde(default = "default_initial_backoff_ms")]
    pub initial_backoff_ms: u64,

    /// Max backoff in milliseconds
    #[serde(default = "default_max_backoff_ms")]
    pub max_backoff_ms: u64,

    /// Backoff multiplier
    #[serde(default = "default_multiplier")]
    pub multiplier: f64,

    /// Add jitter
    #[serde(default = "default_true")]
    pub jitter: bool,
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            max_retries: default_max_retries(),
            initial_backoff_ms: default_initial_backoff_ms(),
            max_backoff_ms: default_max_backoff_ms(),
            multiplier: default_multiplier(),
            jitter: true,
        }
    }
}

impl RetryConfig {
    pub fn initial_backoff(&self) -> Duration {
        Duration::from_millis(self.initial_backoff_ms)
    }

    pub fn max_backoff(&self) -> Duration {
        Duration::from_millis(self.max_backoff_ms)
    }
}

/// Logging configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoggingConfig {
    /// Log level
    #[serde(default = "default_log_level")]
    pub level: String,

    /// Log format
    #[serde(default)]
    pub format: LogFormat,

    /// Include timestamps
    #[serde(default = "default_true")]
    pub timestamps: bool,
}

impl Default for LoggingConfig {
    fn default() -> Self {
        Self {
            level: default_log_level(),
            format: LogFormat::Text,
            timestamps: true,
        }
    }
}

/// Log format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum LogFormat {
    #[default]
    Text,
    Json,
}

/// Builder for SyncConfig.
#[derive(Debug, Default)]
pub struct SyncConfigBuilder {
    postgres_url: Option<String>,
    postgres_pool_size: Option<u32>,
    motherduck_token: Option<String>,
    motherduck_database: Option<String>,
    motherduck_schema: Option<String>,
    batch_size: Option<usize>,
    max_retries: Option<u32>,
    tables: Vec<TableMapping>,
    log_level: Option<String>,
}

impl SyncConfigBuilder {
    pub fn postgres_url(mut self, url: impl Into<String>) -> Self {
        self.postgres_url = Some(url.into());
        self
    }

    pub fn postgres_pool_size(mut self, size: u32) -> Self {
        self.postgres_pool_size = Some(size);
        self
    }

    pub fn motherduck_token(mut self, token: impl Into<String>) -> Self {
        self.motherduck_token = Some(token.into());
        self
    }

    pub fn motherduck_database(mut self, db: impl Into<String>) -> Self {
        self.motherduck_database = Some(db.into());
        self
    }

    pub fn motherduck_schema(mut self, schema: impl Into<String>) -> Self {
        self.motherduck_schema = Some(schema.into());
        self
    }

    pub fn batch_size(mut self, size: usize) -> Self {
        self.batch_size = Some(size);
        self
    }

    pub fn max_retries(mut self, retries: u32) -> Self {
        self.max_retries = Some(retries);
        self
    }

    pub fn table(mut self, mapping: TableMapping) -> Self {
        self.tables.push(mapping);
        self
    }

    pub fn log_level(mut self, level: impl Into<String>) -> Self {
        self.log_level = Some(level.into());
        self
    }

    pub fn build(self) -> Result<SyncConfig> {
        let pg_url = self.postgres_url.ok_or_else(|| Error::config("postgres_url required"))?;
        Url::parse(&pg_url).map_err(|e| Error::config(format!("Invalid PostgreSQL URL: {}", e)))?;

        let md_token = self.motherduck_token.ok_or_else(|| Error::config("motherduck_token required"))?;

        let config = SyncConfig {
            postgres: PostgresConfig {
                url: pg_url,
                pool_size: self.postgres_pool_size.unwrap_or_else(default_pool_size),
                ..Default::default()
            },
            motherduck: MotherDuckConfig {
                token: md_token,
                database: self.motherduck_database.unwrap_or_else(default_database),
                schema: self.motherduck_schema.unwrap_or_else(default_schema),
                ..Default::default()
            },
            sync: SyncBehaviorConfig {
                batch_size: self.batch_size.unwrap_or_else(default_batch_size),
                ..Default::default()
            },
            tables: if self.tables.is_empty() { default_tables() } else { self.tables },
            retry: RetryConfig {
                max_retries: self.max_retries.unwrap_or_else(default_max_retries),
                ..Default::default()
            },
            logging: LoggingConfig {
                level: self.log_level.unwrap_or_else(default_log_level),
                ..Default::default()
            },
        };

        config.validate()?;
        Ok(config)
    }
}

// Defaults
fn default_pool_size() -> u32 { 5 }
fn default_timeout_secs() -> u64 { 30 }
fn default_database() -> String { "analytics".into() }
fn default_schema() -> String { "main".into() }
fn default_batch_size() -> usize { 1000 }
fn default_sync_flag() -> String { "synced_to_motherduck".into() }
fn default_max_retries() -> u32 { 3 }
fn default_initial_backoff_ms() -> u64 { 1000 }
fn default_max_backoff_ms() -> u64 { 60000 }
fn default_multiplier() -> f64 { 2.0 }
fn default_log_level() -> String { "info".into() }
fn default_true() -> bool { true }

fn default_tables() -> Vec<TableMapping> {
    vec![
        // Raw data tables for analytics queries (using staging tables)
        TableMapping {
            source_table: "analytics_staging_users".into(),
            target_table: "full_users".into(),
            primary_key: vec!["id".into()],
            sync_flag_column: default_sync_flag(),
            columns: vec![],
            column_mappings: HashMap::new(),
            filter: None,
            order_by: Some("created_at".into()),
            enabled: true,
        },
        TableMapping {
            source_table: "analytics_staging_listings".into(),
            target_table: "full_listings".into(),
            primary_key: vec!["id".into()],
            sync_flag_column: default_sync_flag(),
            columns: vec![],
            column_mappings: HashMap::new(),
            filter: None,
            order_by: Some("created_at".into()),
            enabled: true,
        },
        // Aggregated analytics tables
        TableMapping {
            source_table: "analytics_daily_stats".into(),
            target_table: "daily_stats".into(),
            primary_key: vec!["date".into()],
            sync_flag_column: default_sync_flag(),
            columns: vec![],
            column_mappings: HashMap::new(),
            filter: None,
            order_by: Some("date".into()),
            enabled: true,
        },
        TableMapping {
            source_table: "analytics_user_activity".into(),
            target_table: "user_activity_summary".into(),
            primary_key: vec!["user_id".into()],
            sync_flag_column: default_sync_flag(),
            columns: vec![],
            column_mappings: HashMap::new(),
            filter: None,
            order_by: Some("updated_at".into()),
            enabled: true,
        },
        TableMapping {
            source_table: "analytics_post_activity".into(),
            target_table: "post_activity_daily_stats".into(),
            primary_key: vec!["id".into()],
            sync_flag_column: default_sync_flag(),
            columns: vec![],
            column_mappings: HashMap::new(),
            filter: None,
            order_by: Some("date".into()),
            enabled: true,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_builder() {
        let config = SyncConfig::builder()
            .postgres_url("postgres://user:pass@localhost:5432/db")
            .motherduck_token("test_token")
            .motherduck_database("test_db")
            .batch_size(500)
            .build()
            .unwrap();

        assert_eq!(config.motherduck.database, "test_db");
        assert_eq!(config.sync.batch_size, 500);
    }

    #[test]
    fn test_table_mapping_builder() {
        let mapping = TableMapping::builder()
            .source_table("source")
            .target_table("target")
            .primary_key_column("id")
            .build()
            .unwrap();

        assert_eq!(mapping.source_table, "source");
        assert_eq!(mapping.target_table, "target");
    }
}
