//! Metrics and observability for motherduck-sync.

use std::sync::atomic::{AtomicU64, Ordering};

use std::time::Instant;

/// Metrics collector for sync operations.
#[derive(Debug, Default)]
pub struct Metrics {
    /// Total syncs attempted
    pub syncs_total: AtomicU64,
    /// Successful syncs
    pub syncs_success: AtomicU64,
    /// Failed syncs
    pub syncs_failed: AtomicU64,
    /// Total records synced
    pub records_synced: AtomicU64,
    /// Total records failed
    pub records_failed: AtomicU64,
    /// Total sync duration in milliseconds
    pub sync_duration_ms: AtomicU64,
    /// PostgreSQL query count
    pub pg_queries: AtomicU64,
    /// MotherDuck query count
    pub md_queries: AtomicU64,
    /// Retry count
    pub retries: AtomicU64,
}

impl Metrics {
    /// Create new metrics collector.
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a sync attempt.
    pub fn record_sync(&self, success: bool, records: u64, failed: u64, duration_ms: u64) {
        self.syncs_total.fetch_add(1, Ordering::Relaxed);
        if success {
            self.syncs_success.fetch_add(1, Ordering::Relaxed);
        } else {
            self.syncs_failed.fetch_add(1, Ordering::Relaxed);
        }
        self.records_synced.fetch_add(records, Ordering::Relaxed);
        self.records_failed.fetch_add(failed, Ordering::Relaxed);
        self.sync_duration_ms.fetch_add(duration_ms, Ordering::Relaxed);
    }

    /// Record a PostgreSQL query.
    pub fn record_pg_query(&self) {
        self.pg_queries.fetch_add(1, Ordering::Relaxed);
    }

    /// Record a MotherDuck query.
    pub fn record_md_query(&self) {
        self.md_queries.fetch_add(1, Ordering::Relaxed);
    }

    /// Record a retry.
    pub fn record_retry(&self) {
        self.retries.fetch_add(1, Ordering::Relaxed);
    }

    /// Get snapshot of current metrics.
    pub fn snapshot(&self) -> MetricsSnapshot {
        MetricsSnapshot {
            syncs_total: self.syncs_total.load(Ordering::Relaxed),
            syncs_success: self.syncs_success.load(Ordering::Relaxed),
            syncs_failed: self.syncs_failed.load(Ordering::Relaxed),
            records_synced: self.records_synced.load(Ordering::Relaxed),
            records_failed: self.records_failed.load(Ordering::Relaxed),
            sync_duration_ms: self.sync_duration_ms.load(Ordering::Relaxed),
            pg_queries: self.pg_queries.load(Ordering::Relaxed),
            md_queries: self.md_queries.load(Ordering::Relaxed),
            retries: self.retries.load(Ordering::Relaxed),
        }
    }

    /// Reset all metrics.
    pub fn reset(&self) {
        self.syncs_total.store(0, Ordering::Relaxed);
        self.syncs_success.store(0, Ordering::Relaxed);
        self.syncs_failed.store(0, Ordering::Relaxed);
        self.records_synced.store(0, Ordering::Relaxed);
        self.records_failed.store(0, Ordering::Relaxed);
        self.sync_duration_ms.store(0, Ordering::Relaxed);
        self.pg_queries.store(0, Ordering::Relaxed);
        self.md_queries.store(0, Ordering::Relaxed);
        self.retries.store(0, Ordering::Relaxed);
    }
}

/// Snapshot of metrics at a point in time.
#[derive(Debug, Clone, serde::Serialize)]
pub struct MetricsSnapshot {
    pub syncs_total: u64,
    pub syncs_success: u64,
    pub syncs_failed: u64,
    pub records_synced: u64,
    pub records_failed: u64,
    pub sync_duration_ms: u64,
    pub pg_queries: u64,
    pub md_queries: u64,
    pub retries: u64,
}

impl MetricsSnapshot {
    /// Calculate success rate.
    pub fn success_rate(&self) -> f64 {
        if self.syncs_total == 0 {
            0.0
        } else {
            self.syncs_success as f64 / self.syncs_total as f64
        }
    }

    /// Calculate average sync duration.
    pub fn avg_sync_duration_ms(&self) -> f64 {
        if self.syncs_total == 0 {
            0.0
        } else {
            self.sync_duration_ms as f64 / self.syncs_total as f64
        }
    }

    /// Calculate records per second.
    pub fn records_per_second(&self) -> f64 {
        if self.sync_duration_ms == 0 {
            0.0
        } else {
            (self.records_synced as f64 * 1000.0) / self.sync_duration_ms as f64
        }
    }
}

/// Timer for measuring operation duration.
pub struct Timer {
    start: Instant,
    label: String,
}

impl Timer {
    /// Start a new timer.
    pub fn start(label: impl Into<String>) -> Self {
        Self {
            start: Instant::now(),
            label: label.into(),
        }
    }

    /// Get elapsed time in milliseconds.
    pub fn elapsed_ms(&self) -> u64 {
        self.start.elapsed().as_millis() as u64
    }

    /// Stop timer and log duration.
    pub fn stop(self) -> u64 {
        let elapsed = self.elapsed_ms();
        tracing::debug!("{} completed in {}ms", self.label, elapsed);
        elapsed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_metrics_recording() {
        let metrics = Metrics::new();
        
        metrics.record_sync(true, 100, 5, 1000);
        metrics.record_sync(false, 0, 0, 500);
        metrics.record_pg_query();
        metrics.record_md_query();
        metrics.record_retry();

        let snapshot = metrics.snapshot();
        assert_eq!(snapshot.syncs_total, 2);
        assert_eq!(snapshot.syncs_success, 1);
        assert_eq!(snapshot.syncs_failed, 1);
        assert_eq!(snapshot.records_synced, 100);
        assert_eq!(snapshot.records_failed, 5);
        assert_eq!(snapshot.pg_queries, 1);
        assert_eq!(snapshot.md_queries, 1);
        assert_eq!(snapshot.retries, 1);
    }

    #[test]
    fn test_metrics_calculations() {
        let snapshot = MetricsSnapshot {
            syncs_total: 10,
            syncs_success: 8,
            syncs_failed: 2,
            records_synced: 1000,
            records_failed: 50,
            sync_duration_ms: 5000,
            pg_queries: 20,
            md_queries: 30,
            retries: 3,
        };

        assert!((snapshot.success_rate() - 0.8).abs() < 0.001);
        assert!((snapshot.avg_sync_duration_ms() - 500.0).abs() < 0.001);
        assert!((snapshot.records_per_second() - 200.0).abs() < 0.001);
    }
}
