# MotherDuck Sync

A robust Rust library and CLI for syncing data from PostgreSQL (including Supabase) to [MotherDuck](https://motherduck.com/) - the serverless analytics platform built on DuckDB.

[![Crates.io](https://img.shields.io/crates/v/motherduck-sync.svg)](https://crates.io/crates/motherduck-sync)
[![Documentation](https://docs.rs/motherduck-sync/badge.svg)](https://docs.rs/motherduck-sync)
[![License](https://img.shields.io/crates/l/motherduck-sync.svg)](LICENSE)

## Why MotherDuck Sync?

Moving analytics data from your production PostgreSQL/Supabase database to MotherDuck enables:

- **Fast analytics queries** without impacting production performance
- **Cost-effective storage** for historical data
- **SQL-based analytics** with DuckDB's powerful analytical engine
- **Serverless scaling** - no infrastructure to manage

## Features

- 🔄 **Incremental sync** - Only sync records that haven't been synced yet
- 🔁 **Full sync** - Re-sync all records when needed
- 📦 **Batch processing** - Efficient batch inserts for large datasets
- 🔒 **TLS support** - Secure connections to PostgreSQL/Supabase
- 🔁 **Retry logic** - Automatic retries with exponential backoff
- 📊 **Schema management** - Automatic table creation in MotherDuck
- 📈 **Progress tracking** - Real-time progress updates
- 📉 **Metrics** - Built-in observability
- ⚙️ **Flexible configuration** - TOML config file or environment variables

## Installation

### From crates.io

```bash
cargo install motherduck-sync
```

### From source

```bash
git clone https://github.com/Foodshareclub/motherduck-sync
cd motherduck-sync
cargo install --path .
```

### Pre-built binaries

Download from [GitHub Releases](https://github.com/Foodshareclub/motherduck-sync/releases).

## Quick Start

### 1. Set environment variables

```bash
export DATABASE_URL="postgres://user:pass@host:5432/database"
export MOTHERDUCK_TOKEN="your_motherduck_token"
```

### 2. Run sync

```bash
# Incremental sync (only unsynced records)
motherduck-sync

# Full sync (all records)
motherduck-sync --full

# Test connectivity
motherduck-sync test

# Check unsynced counts
motherduck-sync status
```

---

## PostgreSQL Setup

### Connection String

Standard PostgreSQL connection:

```bash
export DATABASE_URL="postgres://username:password@localhost:5432/mydb"
```

### With SSL/TLS

```bash
export DATABASE_URL="postgres://username:password@host:5432/mydb?sslmode=require"
```

### Prepare Source Tables

Add a sync tracking column to tables you want to sync:

```sql
-- Add sync flag column
ALTER TABLE analytics_daily_stats 
ADD COLUMN synced_to_motherduck BOOLEAN DEFAULT FALSE;

-- Create partial index for efficient queries
CREATE INDEX idx_analytics_daily_stats_unsynced 
ON analytics_daily_stats (synced_to_motherduck) 
WHERE NOT synced_to_motherduck;
```

---

## Supabase Setup

Supabase uses PostgreSQL under the hood, but requires specific connection settings.

### Connection String

Use the **Supabase Pooler** connection (recommended for external connections):

```bash
# Format: postgres://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres?sslmode=require
export DATABASE_URL="postgres://postgres.abcdefghijklmnop:YourPassword@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require"
```

**Finding your connection string:**
1. Go to Supabase Dashboard → Project Settings → Database
2. Copy the "Connection string" under "Connection pooling" (port 6543)
3. Replace `[YOUR-PASSWORD]` with your database password

### Supabase Vault Integration

Store your MotherDuck token securely in Supabase Vault:

```sql
-- Store token in Vault
SELECT vault.create_secret('your_motherduck_token', 'MOTHERDUCK_TOKEN');

-- Retrieve token (for Edge Functions)
SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'MOTHERDUCK_TOKEN';
```

### Example: Analytics Staging Tables

For syncing raw data from `profiles` and `posts` tables, create staging tables with transformed columns:

```sql
-- Create views to transform data into analytics-friendly format
CREATE OR REPLACE VIEW analytics_full_users AS
SELECT
    id::text as id,
    nickname,
    email,
    avatar_url,
    COALESCE(bio, about_me) as bio,
    COALESCE(is_active, true) as is_active,
    COALESCE(is_verified, false) as is_verified,
    last_seen_at,
    created_time as created_at,
    updated_at,
    synced_to_motherduck
FROM profiles;

CREATE OR REPLACE VIEW analytics_full_listings AS
SELECT
    id::integer as id,
    profile_id::text as profile_id,
    post_name,
    post_description,
    post_type,
    post_address,
    -- Extract lat/lon from GeoJSON location_json
    (location_json->'coordinates'->>1)::double precision as latitude,
    (location_json->'coordinates'->>0)::double precision as longitude,
    is_active,
    is_arranged,
    post_arranged_to::text as post_arranged_to,
    post_arranged_at,
    COALESCE(post_views, 0) as post_views,
    COALESCE(post_like_counter, 0) as post_like_counter,
    created_at,
    updated_at,
    synced_to_motherduck
FROM posts;

-- Create staging tables that can track sync status
CREATE TABLE analytics_staging_users (
    id text PRIMARY KEY,
    nickname text,
    email text,
    avatar_url text,
    bio text,
    is_active boolean DEFAULT true,
    is_verified boolean DEFAULT false,
    last_seen_at timestamp with time zone,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    synced_to_motherduck boolean DEFAULT false
);

CREATE TABLE analytics_staging_listings (
    id integer PRIMARY KEY,
    profile_id text,
    post_name text,
    post_description text,
    post_type text,
    post_address text,
    latitude double precision,
    longitude double precision,
    is_active boolean DEFAULT true,
    is_arranged boolean DEFAULT false,
    post_arranged_to text,
    post_arranged_at timestamp with time zone,
    post_views integer DEFAULT 0,
    post_like_counter integer DEFAULT 0,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    synced_to_motherduck boolean DEFAULT false
);

-- Populate staging tables from views
INSERT INTO analytics_staging_users 
SELECT id, nickname, email, avatar_url, bio, is_active, is_verified, 
       last_seen_at, created_at, updated_at, false
FROM analytics_full_users
ON CONFLICT (id) DO UPDATE SET
    nickname = EXCLUDED.nickname,
    updated_at = EXCLUDED.updated_at;

INSERT INTO analytics_staging_listings
SELECT id, profile_id, post_name, post_description, post_type, post_address,
       latitude, longitude, is_active, is_arranged, post_arranged_to, 
       post_arranged_at, post_views, post_like_counter, created_at, updated_at, false
FROM analytics_full_listings
ON CONFLICT (id) DO UPDATE SET
    post_name = EXCLUDED.post_name,
    updated_at = EXCLUDED.updated_at;

-- Create indexes for efficient sync queries
CREATE INDEX idx_staging_users_synced ON analytics_staging_users(synced_to_motherduck);
CREATE INDEX idx_staging_listings_synced ON analytics_staging_listings(synced_to_motherduck);
```

### Aggregated Analytics Tables

For pre-computed analytics:

```sql
-- Daily statistics
CREATE TABLE analytics_daily_stats (
    date DATE PRIMARY KEY,
    new_users INTEGER DEFAULT 0,
    active_users INTEGER DEFAULT 0,
    new_listings INTEGER DEFAULT 0,
    completed_shares INTEGER DEFAULT 0,
    messages_sent INTEGER DEFAULT 0,
    top_categories JSONB,
    computed_at TIMESTAMPTZ DEFAULT NOW(),
    synced_to_motherduck BOOLEAN DEFAULT FALSE
);

-- User activity summary
CREATE TABLE analytics_user_activity (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id),
    listings_viewed INTEGER DEFAULT 0,
    listings_saved INTEGER DEFAULT 0,
    messages_initiated INTEGER DEFAULT 0,
    shares_completed INTEGER DEFAULT 0,
    last_activity_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    synced_to_motherduck BOOLEAN DEFAULT FALSE
);

-- Create indexes for efficient sync queries
CREATE INDEX idx_daily_stats_unsynced ON analytics_daily_stats (synced_to_motherduck) WHERE NOT synced_to_motherduck;
CREATE INDEX idx_user_activity_unsynced ON analytics_user_activity (synced_to_motherduck) WHERE NOT synced_to_motherduck;
```

### Supabase Edge Function to Populate Analytics

Create an Edge Function to compute and store analytics:

```typescript
// supabase/functions/sync-analytics/index.ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const today = new Date().toISOString().split('T')[0]

  // Compute daily stats
  const { data: stats } = await supabase.rpc('compute_daily_stats', { target_date: today })

  // Upsert to staging table
  await supabase.from('analytics_daily_stats').upsert({
    date: today,
    ...stats,
    synced_to_motherduck: false
  })

  return new Response(JSON.stringify({ success: true }))
})
```

---

## Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | PostgreSQL/Supabase connection string | Yes |
| `MOTHERDUCK_TOKEN` | MotherDuck access token | Yes |
| `MOTHERDUCK_DATABASE` | Target database name | No (default: `analytics`) |
| `LOG_LEVEL` | Log level (trace/debug/info/warn/error) | No (default: `info`) |

### Config File

Generate a sample config:

```bash
motherduck-sync init
```

This creates `motherduck-sync.toml`:

```toml
[postgres]
url = "postgres://user:password@localhost:5432/database"
pool_size = 5

[motherduck]
token = "your_motherduck_token"
database = "analytics"
schema = "main"
create_database = true

[sync]
batch_size = 1000
mark_synced = true
auto_create_tables = true

[retry]
max_retries = 3
initial_backoff_ms = 1000
max_backoff_ms = 60000

[[tables]]
source_table = "analytics_daily_stats"
target_table = "daily_stats"
primary_key = ["date"]
order_by = "date"
enabled = true

[[tables]]
source_table = "analytics_user_activity"
target_table = "user_activity_summary"
primary_key = ["user_id"]
order_by = "updated_at"
enabled = true
```

---

## Library Usage

### Basic Example

```rust
use motherduck_sync::{SyncClient, SyncConfig, SyncMode};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Load config from environment
    let config = SyncConfig::from_env()?;

    // Create client and sync
    let client = SyncClient::new(config).await?;
    let result = client.sync(SyncMode::Incremental).await?;

    println!("Synced {} records in {}ms", result.total_records(), result.duration_ms);
    Ok(())
}
```

### Builder Pattern

```rust
use motherduck_sync::{SyncConfig, SyncMode, TableMapping};

let config = SyncConfig::builder()
    .postgres_url("postgres://user:pass@host:5432/db")
    .motherduck_token("your_token")
    .motherduck_database("analytics")
    .batch_size(1000)
    .table(
        TableMapping::builder()
            .source_table("my_source_table")
            .target_table("my_target_table")
            .primary_key_column("id")
            .sync_flag_column("synced_to_motherduck")
            .filter("status = 'active'")
            .order_by("created_at")
            .build()?
    )
    .build()?;

let client = SyncClient::new(config).await?;
let result = client.sync(SyncMode::Full).await?;
```

### Progress Tracking

```rust
let client = SyncClient::new(config)
    .await?
    .with_progress(|progress| {
        println!(
            "[{}] {}: {}% ({}/{} records)",
            progress.phase,
            progress.table,
            progress.percent,
            progress.records_processed,
            progress.total_records.unwrap_or(0)
        );
    });
```

---

## GitHub Actions

### Daily Sync Workflow

```yaml
name: Sync to MotherDuck

on:
  schedule:
    - cron: '0 3 * * *'  # Daily at 3 AM UTC
  workflow_dispatch:
    inputs:
      full_sync:
        description: 'Full sync (resync all records)'
        type: boolean
        default: false

jobs:
  sync:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    
    steps:
      - uses: actions/checkout@v4

      - name: Install Rust
        uses: dtolnay/rust-toolchain@stable

      - name: Cache Cargo
        uses: actions/cache@v4
        with:
          path: |
            ~/.cargo/bin/
            ~/.cargo/registry/
            ~/.cargo/git/
            target/
          key: ${{ runner.os }}-cargo-${{ hashFiles('**/Cargo.lock') }}

      - name: Build
        run: cargo build --release

      - name: Test connectivity
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          MOTHERDUCK_TOKEN: ${{ secrets.MOTHERDUCK_TOKEN }}
        run: ./target/release/motherduck-sync test

      - name: Run sync
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          MOTHERDUCK_TOKEN: ${{ secrets.MOTHERDUCK_TOKEN }}
        run: |
          ARGS=""
          if [ "${{ inputs.full_sync }}" = "true" ]; then
            ARGS="--full"
          fi
          ./target/release/motherduck-sync $ARGS --json | tee sync-result.json

      - name: Upload results
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: sync-result
          path: sync-result.json
```

### Required Secrets

Add these secrets to your GitHub repository:

| Secret | Description |
|--------|-------------|
| `DATABASE_URL` | PostgreSQL/Supabase connection string |
| `MOTHERDUCK_TOKEN` | MotherDuck access token |

---

## CLI Reference

```
motherduck-sync [OPTIONS] [COMMAND]

Commands:
  sync    Run sync (default)
  test    Test connectivity to PostgreSQL and MotherDuck
  status  Show unsynced record counts
  query   Query MotherDuck tables
  clean   Clean/reset MotherDuck tables
  init    Generate sample config file

Options:
      --full              Full sync (resync all records)
  -c, --config <FILE>     Config file path
      --log-level <LEVEL> Log level [default: info]
      --json              JSON output format
  -q, --quiet             Quiet mode (minimal output)
  -h, --help              Print help
  -V, --version           Print version
```

### Query Command

Query and inspect MotherDuck tables:

```bash
# List all tables
motherduck-sync query --tables

# Show row counts for synced tables
motherduck-sync query --counts

# Execute custom SQL
motherduck-sync query --sql "SELECT * FROM daily_stats ORDER BY date DESC LIMIT 10"

# JSON output for scripting
motherduck-sync query --counts --json
```

### Clean Command

Clean or reset MotherDuck tables:

```bash
# Truncate all tables (keep structure, delete data)
motherduck-sync clean --truncate

# Truncate specific table
motherduck-sync clean --truncate -t daily_stats

# Drop and recreate tables
motherduck-sync clean --reset

# JSON output
motherduck-sync clean --truncate --json
```

### Examples

```bash
# Run incremental sync
motherduck-sync

# Run full sync with debug logging
motherduck-sync --full --log-level debug

# Test connectivity
motherduck-sync test

# Generate config file
motherduck-sync init -o my-config.toml

# Use custom config
motherduck-sync -c my-config.toml

# JSON output for scripting
motherduck-sync --json | jq '.total_records'

# Full workflow: clean, sync, verify
motherduck-sync clean --truncate
motherduck-sync sync --full
motherduck-sync query --counts
```

---

## Architecture

```
┌─────────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  PostgreSQL/Supabase│────▶│  motherduck-sync │────▶│   MotherDuck    │
│   (Source Data)     │     │   (Rust Binary)  │     │  (Analytics DB) │
└─────────────────────┘     └──────────────────┘     └─────────────────┘
         │                          │                        │
         │                          ▼                        │
         │                  ┌──────────────┐                 │
         └─────────────────▶│ Mark Synced  │                 │
                            └──────────────┘                 │
                                                             ▼
                                                    ┌─────────────────┐
                                                    │  Query with SQL │
                                                    │  (DuckDB/BI)    │
                                                    └─────────────────┘
```

### Data Flow

1. **Fetch**: Query PostgreSQL for unsynced records (`WHERE NOT synced_to_motherduck`)
2. **Transform**: Convert rows to DuckDB-compatible format
3. **Load**: Batch upsert to MotherDuck tables
4. **Mark**: Update source records as synced

---

## Performance

| Metric | Value |
|--------|-------|
| Batch size | 1,000 records (configurable) |
| Typical throughput | 10,000+ records/second |
| Memory usage | ~50MB for 100K records |
| Connection pooling | 5 connections (configurable) |

### Optimization Tips

- Use partial indexes on the sync flag column
- Increase batch size for large datasets
- Run during off-peak hours
- Use connection pooling (Supabase Pooler)

---

## Error Handling

- ✅ Automatic retries with exponential backoff
- ✅ Per-table error isolation (one failure doesn't stop others)
- ✅ Detailed error messages with context
- ✅ Transaction rollback on failure
- ✅ Graceful handling of connection timeouts

---

## Troubleshooting

### Connection Issues

**Supabase "prepared statement already exists"**
- Use the Supabase Pooler connection (port 6543)
- The library uses simple query mode to avoid this issue

**SSL/TLS errors**
- Ensure `?sslmode=require` is in your connection string
- The library accepts Supabase's certificates by default

### Sync Issues

**"Fetch failed" errors**
- Check that source tables exist
- Verify the sync flag column exists
- Check PostgreSQL logs for query errors

**Slow performance**
- Increase batch size
- Add indexes on sync flag column
- Use connection pooling

---

## Contributing

Contributions welcome! Please read our contributing guidelines first.

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests: `cargo test`
5. Submit a pull request

---

## License

Licensed under either of:

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT License ([LICENSE-MIT](LICENSE-MIT))

at your option.

---

## Related Projects

- [DuckDB](https://duckdb.org/) - The analytical database engine
- [MotherDuck](https://motherduck.com/) - Serverless DuckDB in the cloud
- [Supabase](https://supabase.com/) - Open source Firebase alternative
- [tokio-postgres](https://github.com/sfackler/rust-postgres) - PostgreSQL client for Rust
