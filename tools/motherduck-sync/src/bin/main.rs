//! MotherDuck Sync CLI

use clap::{Parser, Subcommand};
use motherduck_sync::{SyncClient, SyncConfig, SyncMode};
use std::process::ExitCode;
use tracing::{error, info};
use tracing_subscriber::{fmt, EnvFilter};

#[derive(Parser)]
#[command(name = "motherduck-sync")]
#[command(author, version, about = "Sync data from PostgreSQL to MotherDuck")]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    /// Full sync (resync all records)
    #[arg(long, global = true)]
    full: bool,

    /// Config file path
    #[arg(short, long, global = true)]
    config: Option<String>,

    /// Log level
    #[arg(long, default_value = "info", global = true, env = "LOG_LEVEL")]
    log_level: String,

    /// JSON output
    #[arg(long, global = true)]
    json: bool,

    /// Quiet mode
    #[arg(short, long, global = true)]
    quiet: bool,
}

#[derive(Subcommand)]
enum Commands {
    /// Run sync (default)
    Sync,
    /// Test connectivity
    Test,
    /// Show unsynced counts
    Status,
    /// Generate sample config
    Init {
        #[arg(short, long, default_value = "motherduck-sync.toml")]
        output: String,
    },
    /// Query MotherDuck tables
    Query {
        /// SQL query to execute
        #[arg(short, long)]
        sql: Option<String>,
        /// Show table counts
        #[arg(long)]
        counts: bool,
        /// List tables
        #[arg(long)]
        tables: bool,
    },
    /// Clean/reset MotherDuck tables
    Clean {
        /// Drop and recreate tables
        #[arg(long)]
        reset: bool,
        /// Truncate tables (keep structure)
        #[arg(long)]
        truncate: bool,
        /// Specific table to clean
        #[arg(short, long)]
        table: Option<String>,
    },
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    init_logging(&cli.log_level, cli.quiet);

    match run(cli).await {
        Ok(_) => ExitCode::SUCCESS,
        Err(e) => {
            error!("Error: {}", e);
            ExitCode::FAILURE
        }
    }
}

async fn run(cli: Cli) -> Result<(), Box<dyn std::error::Error>> {
    // Handle init command first - it doesn't need config
    if let Some(Commands::Init { output }) = cli.command {
        return run_init(&output);
    }

    let config = load_config(cli.config.as_deref())?;

    match cli.command {
        None | Some(Commands::Sync) => run_sync(config, cli.full, cli.json, cli.quiet).await,
        Some(Commands::Test) => run_test(config, cli.json).await,
        Some(Commands::Status) => run_status(config, cli.json).await,
        Some(Commands::Query { sql, counts, tables }) => {
            run_query(config, sql, counts, tables, cli.json).await
        }
        Some(Commands::Clean { reset, truncate, table }) => {
            run_clean(config, reset, truncate, table, cli.json, cli.quiet).await
        }
        Some(Commands::Init { .. }) => unreachable!(), // Handled above
    }
}

fn load_config(path: Option<&str>) -> Result<SyncConfig, Box<dyn std::error::Error>> {
    if let Some(p) = path {
        info!("Loading config from: {}", p);
        return Ok(SyncConfig::from_file(p)?);
    }

    for default in &["motherduck-sync.toml", ".motherduck-sync.toml"] {
        if std::path::Path::new(default).exists() {
            info!("Loading config from: {}", default);
            return Ok(SyncConfig::from_file(default)?);
        }
    }

    info!("Loading config from environment");
    Ok(SyncConfig::from_env()?)
}


async fn run_sync(
    config: SyncConfig,
    full: bool,
    json: bool,
    quiet: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let mode = if full { SyncMode::Full } else { SyncMode::Incremental };

    if !quiet && !json {
        println!("MotherDuck Sync v{}", motherduck_sync::VERSION);
        println!("Mode: {}\n", mode);
    }

    let client = SyncClient::new(config).await?;
    let result = client.sync(mode).await?;

    if json {
        println!("{}", serde_json::to_string_pretty(&result)?);
    } else if !quiet {
        if result.success {
            println!("✓ Sync completed successfully");
        } else {
            println!("✗ Sync completed with errors");
        }
        println!("\nDuration: {}ms", result.duration_ms);
        println!("Total records: {}\n", result.total_records());

        for (_, tr) in &result.tables {
            let icon = if tr.success { "✓" } else { "✗" };
            println!(
                "  {} {} → {}: {} records ({}ms)",
                icon, tr.source_table, tr.target_table, tr.records_synced, tr.duration_ms
            );
            if let Some(ref e) = tr.error {
                println!("      Error: {}", e);
            }
        }
    }

    if result.success { Ok(()) } else { Err("Sync failed".into()) }
}

async fn run_test(config: SyncConfig, json: bool) -> Result<(), Box<dyn std::error::Error>> {
    if !json {
        println!("Testing connectivity...\n");
    }

    let client = SyncClient::new(config).await?;
    client.test_connectivity().await?;

    if json {
        println!(r#"{{"postgres":"ok","motherduck":"ok"}}"#);
    } else {
        println!("\n✓ All connectivity tests passed!");
    }
    Ok(())
}

async fn run_status(config: SyncConfig, json: bool) -> Result<(), Box<dyn std::error::Error>> {
    let client = SyncClient::new(config).await?;
    let counts = client.get_unsynced_counts().await?;

    if json {
        println!("{}", serde_json::to_string_pretty(&counts)?);
    } else {
        println!("Unsynced Records\n");
        for (table, count) in &counts {
            println!("  {}: {} records", table, count);
        }
        let total: i64 = counts.values().sum();
        println!("\nTotal: {} unsynced", total);
    }
    Ok(())
}

async fn run_query(
    config: SyncConfig,
    sql: Option<String>,
    counts: bool,
    tables: bool,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    use motherduck_sync::MotherDuckClient;

    let md_client = MotherDuckClient::connect(config.motherduck)?;

    // List tables
    if tables {
        let query = "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name";
        let conn = md_client.connection();
        let mut stmt = conn.prepare(query)?;
        let table_names: Vec<String> = stmt
            .query_map([], |row| row.get(0))?
            .filter_map(|r| r.ok())
            .collect();

        if json {
            println!("{}", serde_json::to_string_pretty(&table_names)?);
        } else {
            println!("Tables in MotherDuck\n");
            for name in &table_names {
                println!("  • {}", name);
            }
            println!("\nTotal: {} tables", table_names.len());
        }
        return Ok(());
    }

    // Show counts for all tables
    if counts {
        let target_tables = ["daily_stats", "user_activity_summary", "post_activity_daily_stats"];
        let mut results: std::collections::HashMap<String, i64> = std::collections::HashMap::new();

        for table in &target_tables {
            match md_client.count_rows(table) {
                Ok(count) => {
                    results.insert(table.to_string(), count);
                }
                Err(_) => {
                    results.insert(table.to_string(), -1); // Table doesn't exist
                }
            }
        }

        if json {
            println!("{}", serde_json::to_string_pretty(&results)?);
        } else {
            println!("MotherDuck Table Counts\n");
            for (table, count) in &results {
                if *count >= 0 {
                    println!("  {} → {} records", table, count);
                } else {
                    println!("  {} → (table not found)", table);
                }
            }
            let total: i64 = results.values().filter(|&&c| c >= 0).sum();
            println!("\nTotal: {} records", total);
        }
        return Ok(());
    }

    // Execute custom SQL
    if let Some(sql_query) = sql {
        let conn = md_client.connection();
        
        // Use query() directly and iterate
        let mut stmt = conn.prepare(&sql_query)?;
        let mut rows_result = stmt.query([])?;
        
        let mut rows: Vec<Vec<String>> = Vec::new();
        let mut column_count = 0;
        
        while let Some(row) = rows_result.next()? {
            if column_count == 0 {
                // Detect column count from first row by trying to access columns
                for i in 0..100 {
                    match row.get::<_, duckdb::types::Value>(i) {
                        Ok(_) => column_count = i + 1,
                        Err(_) => break,
                    }
                }
            }
            
            let mut values = Vec::new();
            for i in 0..column_count {
                let val: String = match row.get::<_, duckdb::types::Value>(i) {
                    Ok(v) => match v {
                        duckdb::types::Value::Null => "NULL".to_string(),
                        duckdb::types::Value::Text(s) => s,
                        duckdb::types::Value::Int(n) => n.to_string(),
                        duckdb::types::Value::BigInt(n) => n.to_string(),
                        duckdb::types::Value::Float(n) => n.to_string(),
                        duckdb::types::Value::Double(n) => n.to_string(),
                        duckdb::types::Value::Boolean(b) => b.to_string(),
                        duckdb::types::Value::Date32(d) => format!("{}", d),
                        duckdb::types::Value::Timestamp(_, t) => format!("{}", t),
                        other => format!("{:?}", other),
                    },
                    Err(_) => "?".to_string(),
                };
                values.push(val);
            }
            rows.push(values);
        }
        
        // Generate column names
        let column_names: Vec<String> = (0..column_count)
            .map(|i| format!("col{}", i))
            .collect();

        if json {
            let json_rows: Vec<serde_json::Value> = rows
                .iter()
                .map(|row| {
                    let mut obj = serde_json::Map::new();
                    for (i, col) in column_names.iter().enumerate() {
                        if i < row.len() {
                            obj.insert(col.clone(), serde_json::Value::String(row[i].clone()));
                        }
                    }
                    serde_json::Value::Object(obj)
                })
                .collect();
            println!("{}", serde_json::to_string_pretty(&json_rows)?);
        } else {
            if column_names.is_empty() {
                println!("Query executed successfully (no results)");
            } else {
                // Print header
                println!("{}", column_names.join(" | "));
                println!("{}", "-".repeat(column_names.iter().map(|c| c.len() + 3).sum::<usize>()));
                
                // Print rows
                for row in &rows {
                    println!("{}", row.join(" | "));
                }
                println!("\n{} rows returned", rows.len());
            }
        }
        return Ok(());
    }

    // Default: show help
    println!("Query MotherDuck tables\n");
    println!("Usage:");
    println!("  motherduck-sync query --tables      # List all tables");
    println!("  motherduck-sync query --counts      # Show row counts");
    println!("  motherduck-sync query --sql \"SELECT * FROM daily_stats LIMIT 5\"");
    Ok(())
}

async fn run_clean(
    config: SyncConfig,
    reset: bool,
    truncate: bool,
    table: Option<String>,
    json: bool,
    quiet: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    use motherduck_sync::MotherDuckClient;

    let md_client = MotherDuckClient::connect(config.motherduck)?;
    let target_tables = ["daily_stats", "user_activity_summary", "post_activity_daily_stats"];

    // Determine which tables to clean
    let tables_to_clean: Vec<&str> = if let Some(ref t) = table {
        vec![t.as_str()]
    } else {
        target_tables.to_vec()
    };

    if !quiet && !json {
        if reset {
            println!("Resetting MotherDuck tables (drop and recreate)...\n");
        } else if truncate {
            println!("Truncating MotherDuck tables...\n");
        } else {
            println!("Clean MotherDuck tables\n");
            println!("Usage:");
            println!("  motherduck-sync clean --truncate           # Clear all data, keep structure");
            println!("  motherduck-sync clean --reset              # Drop and recreate tables");
            println!("  motherduck-sync clean --truncate -t daily_stats  # Truncate specific table");
            return Ok(());
        }
    }

    let mut results: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    for table_name in &tables_to_clean {
        if reset {
            // Drop and recreate
            let drop_sql = format!("DROP TABLE IF EXISTS {}", table_name);
            match md_client.execute(&drop_sql) {
                Ok(_) => {
                    if !quiet && !json {
                        println!("  ✓ Dropped: {}", table_name);
                    }
                    results.insert(table_name.to_string(), "dropped".to_string());
                }
                Err(e) => {
                    if !quiet && !json {
                        println!("  ✗ Failed to drop {}: {}", table_name, e);
                    }
                    results.insert(table_name.to_string(), format!("error: {}", e));
                }
            }
        } else if truncate {
            // Truncate (DELETE all rows)
            let truncate_sql = format!("DELETE FROM {}", table_name);
            match md_client.execute(&truncate_sql) {
                Ok(count) => {
                    if !quiet && !json {
                        println!("  ✓ Truncated: {} ({} rows deleted)", table_name, count);
                    }
                    results.insert(table_name.to_string(), format!("truncated: {} rows", count));
                }
                Err(e) => {
                    if !quiet && !json {
                        println!("  ✗ Failed to truncate {}: {}", table_name, e);
                    }
                    results.insert(table_name.to_string(), format!("error: {}", e));
                }
            }
        }
    }

    // Recreate tables if reset
    if reset {
        if !quiet && !json {
            println!("\nRecreating tables...");
        }
        md_client.create_analytics_tables()?;
        if !quiet && !json {
            println!("  ✓ Tables recreated");
        }
    }

    if json {
        println!("{}", serde_json::to_string_pretty(&results)?);
    } else if !quiet {
        println!("\n✓ Clean completed");
    }

    Ok(())
}

fn run_init(output: &str) -> Result<(), Box<dyn std::error::Error>> {
    let config = r#"# MotherDuck Sync Configuration

[postgres]
url = "postgres://user:password@localhost:5432/database"
pool_size = 5

[motherduck]
token = "your_motherduck_token"
database = "analytics"

[sync]
batch_size = 1000
mark_synced = true

[[tables]]
source_table = "analytics_daily_stats"
target_table = "daily_stats"
primary_key = ["date"]
enabled = true

[[tables]]
source_table = "analytics_user_activity"
target_table = "user_activity_summary"
primary_key = ["user_id"]
enabled = true

[[tables]]
source_table = "analytics_post_activity"
target_table = "post_activity_daily_stats"
primary_key = ["id"]
enabled = true
"#;

    std::fs::write(output, config)?;
    println!("✓ Created: {}", output);
    println!("\nEdit the file or use environment variables:");
    println!("  DATABASE_URL, MOTHERDUCK_TOKEN");
    Ok(())
}

fn init_logging(level: &str, quiet: bool) {
    if quiet { return; }
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(level));
    fmt().with_env_filter(filter).with_target(false).init();
}
