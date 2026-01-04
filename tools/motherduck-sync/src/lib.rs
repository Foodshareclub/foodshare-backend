//! # MotherDuck Sync
//!
//! A robust library for syncing data from PostgreSQL to MotherDuck.
//!
//! ## Features
//!
//! - **Incremental sync**: Only sync records that haven't been synced yet
//! - **Full sync**: Re-sync all records
//! - **Retry logic**: Automatic retries with exponential backoff
//! - **Schema management**: Automatic table creation and migrations
//! - **Batch processing**: Efficient batch inserts for large datasets
//! - **Progress tracking**: Real-time progress updates via callbacks
//! - **Metrics**: Built-in metrics for observability
//!
//! ## Quick Start
//!
//! ```rust,no_run
//! use motherduck_sync::{SyncClient, SyncConfig, SyncMode};
//!
//! #[tokio::main]
//! async fn main() -> Result<(), Box<dyn std::error::Error>> {
//!     let config = SyncConfig::builder()
//!         .postgres_url("postgres://user:pass@host:5432/db")
//!         .motherduck_token("your_token")
//!         .motherduck_database("analytics")
//!         .build()?;
//!
//!     let client = SyncClient::new(config).await?;
//!     let result = client.sync(SyncMode::Incremental).await?;
//!
//!     println!("Synced {} records", result.total_records());
//!     Ok(())
//! }
//! ```
//!
//! ## Custom Tables
//!
//! You can define custom table mappings:
//!
//! ```rust,no_run
//! use motherduck_sync::{SyncClient, SyncConfig, TableMapping};
//!
//! let mapping = TableMapping::builder()
//!     .source_table("my_source_table")
//!     .target_table("my_target_table")
//!     .primary_key("id")
//!     .sync_flag_column("synced")
//!     .build();
//! ```

#![cfg_attr(docsrs, feature(doc_cfg))]
#![warn(missing_docs)]
#![warn(rustdoc::missing_crate_level_docs)]
#![deny(unsafe_code)]

pub mod config;
pub mod error;
pub mod postgres;
pub mod motherduck;
pub mod sync;
pub mod schema;
pub mod metrics;

// Re-exports for convenience
pub use config::{SyncConfig, SyncConfigBuilder, TableMapping, TableMappingBuilder};
pub use error::{Error, Result};
pub use sync::{SyncClient, SyncMode, SyncResult, SyncProgress};
pub use schema::{Schema, Column, ColumnType};
pub use motherduck::MotherDuckClient;

/// Library version
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
