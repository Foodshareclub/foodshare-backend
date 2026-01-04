//! Core sync logic for motherduck-sync.

use crate::config::{SyncConfig, TableMapping};
use crate::error::Result;
use crate::motherduck::MotherDuckClient;
use crate::postgres::PostgresClient;
use backoff::{ExponentialBackoff, ExponentialBackoffBuilder};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tracing::{debug, error, info, instrument, warn};

/// Sync mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SyncMode {
    /// Only sync records not yet synced
    #[default]
    Incremental,
    /// Sync all records
    Full,
}

impl std::fmt::Display for SyncMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SyncMode::Incremental => write!(f, "incremental"),
            SyncMode::Full => write!(f, "full"),
        }
    }
}

/// Sync result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncResult {
    /// Whether sync was successful
    pub success: bool,
    /// Sync mode used
    pub mode: String,
    /// Per-table results
    pub tables: HashMap<String, TableSyncResult>,
    /// Total duration in milliseconds
    pub duration_ms: u64,
    /// Timestamp when sync completed
    pub completed_at: String,
    /// Error message if failed
    pub error: Option<String>,
}

impl SyncResult {
    /// Get total records synced.
    pub fn total_records(&self) -> usize {
        self.tables.values().map(|t| t.records_synced).sum()
    }

    /// Get total records failed.
    pub fn total_failed(&self) -> usize {
        self.tables.values().map(|t| t.records_failed).sum()
    }

    /// Check if all tables synced successfully.
    pub fn all_tables_success(&self) -> bool {
        self.tables.values().all(|t| t.success)
    }
}

/// Per-table sync result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableSyncResult {
    /// Source table name
    pub source_table: String,
    /// Target table name
    pub target_table: String,
    /// Whether sync was successful
    pub success: bool,
    /// Records synced
    pub records_synced: usize,
    /// Records failed
    pub records_failed: usize,
    /// Duration in milliseconds
    pub duration_ms: u64,
    /// Error message if failed
    pub error: Option<String>,
}

/// Sync progress callback.
pub type ProgressCallback = Box<dyn Fn(SyncProgress) + Send + Sync>;

/// Sync progress update.
#[derive(Debug, Clone)]
pub struct SyncProgress {
    /// Current table being synced
    pub table: String,
    /// Current phase
    pub phase: SyncPhase,
    /// Records processed so far
    pub records_processed: usize,
    /// Total records to process (if known)
    pub total_records: Option<usize>,
    /// Percentage complete (0-100)
    pub percent: u8,
}

/// Sync phase.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncPhase {
    /// Connecting to databases
    Connecting,
    /// Fetching data from PostgreSQL
    Fetching,
    /// Inserting data to MotherDuck
    Inserting,
    /// Marking records as synced
    Marking,
    /// Completed
    Completed,
    /// Failed
    Failed,
}

impl std::fmt::Display for SyncPhase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SyncPhase::Connecting => write!(f, "connecting"),
            SyncPhase::Fetching => write!(f, "fetching"),
            SyncPhase::Inserting => write!(f, "inserting"),
            SyncPhase::Marking => write!(f, "marking"),
            SyncPhase::Completed => write!(f, "completed"),
            SyncPhase::Failed => write!(f, "failed"),
        }
    }
}

/// Main sync client.
pub struct SyncClient {
    config: SyncConfig,
    pg_client: PostgresClient,
    md_client: MotherDuckClient,
    progress_callback: Option<Arc<ProgressCallback>>,
}

impl SyncClient {
    /// Create a new sync client.
    #[instrument(skip(config))]
    pub async fn new(config: SyncConfig) -> Result<Self> {
        info!("Initializing sync client...");

        let pg_client = PostgresClient::connect(config.postgres.clone()).await?;
        let md_client = MotherDuckClient::connect(config.motherduck.clone())?;

        Ok(Self {
            config,
            pg_client,
            md_client,
            progress_callback: None,
        })
    }

    /// Set progress callback.
    pub fn with_progress<F>(mut self, callback: F) -> Self
    where
        F: Fn(SyncProgress) + Send + Sync + 'static,
    {
        self.progress_callback = Some(Arc::new(Box::new(callback)));
        self
    }

    /// Test connectivity to both databases.
    pub async fn test_connectivity(&self) -> Result<()> {
        info!("Testing connectivity...");

        self.pg_client.ping().await?;
        info!("PostgreSQL: OK");

        self.md_client.ping()?;
        info!("MotherDuck: OK");

        Ok(())
    }

    /// Run sync.
    #[instrument(skip(self), fields(mode = %mode))]
    pub async fn sync(&self, mode: SyncMode) -> Result<SyncResult> {
        let start = Instant::now();
        let full_sync = mode == SyncMode::Full;

        info!("Starting {} sync...", mode);

        // Ensure MotherDuck schema and tables exist
        if self.config.sync.auto_create_tables {
            self.md_client.ensure_schema()?;
            self.md_client.create_analytics_tables()?;
        }

        let mut table_results = HashMap::new();
        let mut overall_success = true;

        // Sync each enabled table
        for mapping in &self.config.tables {
            if !mapping.enabled {
                debug!("Skipping disabled table: {}", mapping.source_table);
                continue;
            }

            let table_start = Instant::now();
            let result = self.sync_table(mapping, full_sync).await;

            let table_result = match result {
                Ok((synced, failed)) => TableSyncResult {
                    source_table: mapping.source_table.clone(),
                    target_table: mapping.target_table.clone(),
                    success: true,
                    records_synced: synced,
                    records_failed: failed,
                    duration_ms: table_start.elapsed().as_millis() as u64,
                    error: None,
                },
                Err(e) => {
                    overall_success = false;
                    error!("Failed to sync table {}: {}", mapping.source_table, e);
                    TableSyncResult {
                        source_table: mapping.source_table.clone(),
                        target_table: mapping.target_table.clone(),
                        success: false,
                        records_synced: 0,
                        records_failed: 0,
                        duration_ms: table_start.elapsed().as_millis() as u64,
                        error: Some(e.to_string()),
                    }
                }
            };

            table_results.insert(mapping.source_table.clone(), table_result);
        }

        let duration_ms = start.elapsed().as_millis() as u64;

        let result = SyncResult {
            success: overall_success,
            mode: mode.to_string(),
            tables: table_results,
            duration_ms,
            completed_at: chrono::Utc::now().to_rfc3339(),
            error: if overall_success { None } else { Some("Some tables failed to sync".into()) },
        };

        if overall_success {
            info!(
                "Sync completed successfully in {}ms. Total records: {}",
                duration_ms,
                result.total_records()
            );
        } else {
            warn!(
                "Sync completed with errors in {}ms. Synced: {}, Failed tables: {}",
                duration_ms,
                result.total_records(),
                result.tables.values().filter(|t| !t.success).count()
            );
        }

        Ok(result)
    }

    /// Sync a single table.
    #[instrument(skip(self), fields(table = %mapping.source_table))]
    async fn sync_table(
        &self,
        mapping: &TableMapping,
        full_sync: bool,
    ) -> Result<(usize, usize)> {
        self.report_progress(SyncProgress {
            table: mapping.source_table.clone(),
            phase: SyncPhase::Fetching,
            records_processed: 0,
            total_records: None,
            percent: 0,
        });

        // Fetch rows from PostgreSQL
        let limit = if self.config.sync.max_records > 0 {
            Some(self.config.sync.max_records)
        } else {
            None
        };

        let rows = self.pg_client.fetch_rows(mapping, full_sync, limit).await?;
        let total = rows.len();

        if total == 0 {
            info!("No rows to sync for {}", mapping.source_table);
            return Ok((0, 0));
        }

        info!("Fetched {} rows from {}", total, mapping.source_table);

        self.report_progress(SyncProgress {
            table: mapping.source_table.clone(),
            phase: SyncPhase::Inserting,
            records_processed: 0,
            total_records: Some(total),
            percent: 25,
        });

        // Insert to MotherDuck
        let synced = if self.config.sync.use_transactions {
            self.md_client.batch_upsert(mapping, &rows, self.config.sync.batch_size)?
        } else {
            self.md_client.upsert_rows(mapping, &rows)?
        };

        let failed = total - synced;

        // Mark as synced in PostgreSQL
        if self.config.sync.mark_synced && !full_sync && synced > 0 {
            self.report_progress(SyncProgress {
                table: mapping.source_table.clone(),
                phase: SyncPhase::Marking,
                records_processed: synced,
                total_records: Some(total),
                percent: 75,
            });

            let pk_col = &mapping.primary_key[0];
            let ids: Vec<String> = rows
                .iter()
                .filter_map(|r| r.get(pk_col))
                .map(|v| match v {
                    serde_json::Value::String(s) => s.clone(),
                    other => other.to_string().trim_matches('"').to_string(),
                })
                .collect();

            self.pg_client.mark_synced(mapping, &ids).await?;
        }

        self.report_progress(SyncProgress {
            table: mapping.source_table.clone(),
            phase: SyncPhase::Completed,
            records_processed: synced,
            total_records: Some(total),
            percent: 100,
        });

        info!(
            "Synced {} rows to {} ({} failed)",
            synced, mapping.target_table, failed
        );

        Ok((synced, failed))
    }

    /// Report progress via callback.
    fn report_progress(&self, progress: SyncProgress) {
        if let Some(ref callback) = self.progress_callback {
            callback(progress);
        }
    }

    /// Get unsynced counts for all tables.
    pub async fn get_unsynced_counts(&self) -> Result<HashMap<String, i64>> {
        let mut counts = HashMap::new();

        for mapping in &self.config.tables {
            if mapping.enabled {
                let count = self.pg_client.unsynced_count(mapping).await?;
                counts.insert(mapping.source_table.clone(), count);
            }
        }

        Ok(counts)
    }
}

/// Create exponential backoff from config.
pub fn create_backoff(config: &crate::config::RetryConfig) -> ExponentialBackoff {
    ExponentialBackoffBuilder::new()
        .with_initial_interval(config.initial_backoff())
        .with_max_interval(config.max_backoff())
        .with_multiplier(config.multiplier)
        .with_max_elapsed_time(Some(Duration::from_secs(300)))
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sync_mode_display() {
        assert_eq!(SyncMode::Incremental.to_string(), "incremental");
        assert_eq!(SyncMode::Full.to_string(), "full");
    }

    #[test]
    fn test_sync_result_totals() {
        let mut tables = HashMap::new();
        tables.insert(
            "table1".to_string(),
            TableSyncResult {
                source_table: "table1".to_string(),
                target_table: "table1".to_string(),
                success: true,
                records_synced: 100,
                records_failed: 5,
                duration_ms: 1000,
                error: None,
            },
        );
        tables.insert(
            "table2".to_string(),
            TableSyncResult {
                source_table: "table2".to_string(),
                target_table: "table2".to_string(),
                success: true,
                records_synced: 50,
                records_failed: 0,
                duration_ms: 500,
                error: None,
            },
        );

        let result = SyncResult {
            success: true,
            mode: "incremental".to_string(),
            tables,
            duration_ms: 1500,
            completed_at: "2024-01-01T00:00:00Z".to_string(),
            error: None,
        };

        assert_eq!(result.total_records(), 150);
        assert_eq!(result.total_failed(), 5);
        assert!(result.all_tables_success());
    }
}
