# Post Coordinates Geocoding System

Robust, queue-based automatic geocoding system for converting post addresses to geographic coordinates.

## Overview

This system automatically geocodes post addresses when posts are created or updated, using:

1. **Database Queue** (`location_update_queue`) - Tracks geocoding requests with retry logic
2. **Database Triggers** - Automatically queues posts when address is set/changed
3. **Edge Function** - Processes queue items via Nominatim geocoding API
4. **pg_cron Job** - Runs batch processing every 5 minutes (if enabled)

## Architecture

```
Post Created/Updated with Address
         ↓
Database Trigger (queue_location_update)
         ↓
Insert into location_update_queue (status: pending)
         ↓
Edge Function processes queue (every 5 min via pg_cron)
         ↓
Geocode via Nominatim → Update posts.location
         ↓
Mark queue item as completed/failed
```

## Key Features

- **Automatic Queueing**: New posts with addresses are automatically queued
- **Retry Logic**: Failed geocoding attempts are retried (max 3 times)
- **Rate Limiting**: Respects Nominatim's 1 request/second limit
- **Concurrent Safe**: Uses `FOR UPDATE SKIP LOCKED` to prevent race conditions
- **Status Tracking**: Monitor pending, processing, failed, and completed items
- **Cleanup**: Automatic cleanup of old completed queue entries

## Database Schema

### `location_update_queue` Table

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL | Primary key |
| `post_id` | BIGINT | Reference to posts table |
| `post_address` | TEXT | Address to geocode |
| `status` | TEXT | `pending`, `processing`, `completed`, `failed` |
| `retry_count` | INTEGER | Number of attempts made (0-3) |
| `max_retries` | INTEGER | Max retry attempts (default: 3) |
| `error_message` | TEXT | Last error message (if failed) |
| `last_attempt_at` | TIMESTAMPTZ | Last processing timestamp |
| `completed_at` | TIMESTAMPTZ | Success timestamp |
| `created_at` | TIMESTAMPTZ | Queue entry creation time |
| `updated_at` | TIMESTAMPTZ | Last update time |

### Queue Status Flow

```
pending → processing → completed (success)
                    ↓
                  failed (retry_count < max_retries) → pending (retry)
                    ↓
                  failed (retry_count >= max_retries) → permanently failed
```

## Edge Function Operations

### 1. BATCH_UPDATE (Default)

Process a batch of pending queue items.

```bash
# Via curl
curl -X POST https://***REMOVED***/functions/v1/update-post-coordinates \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"operation": "BATCH_UPDATE", "batch_size": 10}'

# Response
{
  "message": "Processed 5 items: 4 successful, 1 failed",
  "processed": 5,
  "successful": 4,
  "failed": 1,
  "results": [...]
}
```

### 2. STATS

Get queue statistics.

```bash
curl -X POST https://***REMOVED***/functions/v1/update-post-coordinates \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"operation": "STATS"}'

# Response
{
  "message": "Queue statistics",
  "stats": {
    "pending": 12,
    "processing": 0,
    "failed_retryable": 2,
    "failed_permanent": 1,
    "completed_today": 45
  }
}
```

### 3. SINGLE

Process a single post directly (legacy, bypasses queue).

```bash
curl -X POST https://***REMOVED***/functions/v1/update-post-coordinates \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "operation": "SINGLE",
    "id": 123,
    "post_address": "1600 Amphitheatre Parkway, Mountain View, CA"
  }'
```

### 4. CLEANUP

Remove old completed queue entries.

```bash
curl -X POST https://***REMOVED***/functions/v1/update-post-coordinates \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"operation": "CLEANUP", "days_old": 30}'

# Response
{
  "message": "Cleaned up 150 old queue entries",
  "deleted": 150
}
```

## Database Functions

### `get_pending_geocode_queue(batch_size INTEGER)`

Fetch next batch of pending items with row-level locking.

```sql
SELECT * FROM get_pending_geocode_queue(10);
```

### `mark_geocode_processing(queue_id BIGINT)`

Mark queue item as being processed.

```sql
SELECT mark_geocode_processing(123);
```

### `mark_geocode_completed(queue_id BIGINT)`

Mark queue item as successfully completed.

```sql
SELECT mark_geocode_completed(123);
```

### `mark_geocode_failed(queue_id BIGINT, error_msg TEXT)`

Mark queue item as failed. Automatically retries if under `max_retries`.

```sql
SELECT mark_geocode_failed(123, 'Geocoding service unavailable');
```

### `cleanup_old_geocode_queue(days_old INTEGER)`

Delete completed entries older than specified days.

```sql
SELECT cleanup_old_geocode_queue(30); -- Returns: number deleted
```

## Database Trigger

The `trigger_queue_location_update` trigger automatically runs on `posts` table:

- **ON INSERT**: Queues post if `post_address` is provided and `location` is NULL
- **ON UPDATE**: Re-queues if `post_address` changes (clears existing `location`)

## pg_cron Job

If `pg_cron` extension is enabled, a job runs every 5 minutes:

```sql
-- View cron jobs
SELECT * FROM cron.job WHERE jobname = 'geocode-posts-batch';

-- Disable job
SELECT cron.unschedule('geocode-posts-batch');

-- Re-enable job (re-run migration)
```

## Manual Operations

### Query Queue Status

```sql
-- Pending items
SELECT * FROM location_update_queue
WHERE status = 'pending'
ORDER BY created_at;

-- Failed items (retryable)
SELECT * FROM location_update_queue
WHERE status = 'failed' AND retry_count < max_retries
ORDER BY retry_count, created_at;

-- Permanently failed
SELECT * FROM location_update_queue
WHERE status = 'failed' AND retry_count >= max_retries;

-- Today's completed
SELECT COUNT(*) FROM location_update_queue
WHERE status = 'completed'
AND completed_at >= CURRENT_DATE;
```

### Manually Queue a Post

```sql
INSERT INTO location_update_queue (post_id, post_address, status)
VALUES (123, '1600 Amphitheatre Parkway, Mountain View, CA', 'pending')
ON CONFLICT (post_id, status) WHERE status IN ('pending', 'processing')
DO NOTHING;
```

### Retry Failed Items

Failed items with `retry_count < max_retries` are automatically retried. To manually reset:

```sql
UPDATE location_update_queue
SET status = 'pending', retry_count = 0, error_message = NULL
WHERE status = 'failed' AND id = 123;
```

### Reset Stuck Processing Items

If items are stuck in "processing" status (e.g., function crashed):

```sql
UPDATE location_update_queue
SET status = 'pending'
WHERE status = 'processing'
AND last_attempt_at < NOW() - INTERVAL '1 hour';
```

## Monitoring

### Key Metrics to Track

1. **Queue Length**: Number of pending items
2. **Processing Rate**: Completed items per hour/day
3. **Failure Rate**: Percentage of permanent failures
4. **Average Processing Time**: Time from queue → completion
5. **Stuck Items**: Processing items older than 1 hour

### Example Monitoring Query

```sql
SELECT
  status,
  COUNT(*) as count,
  AVG(retry_count) as avg_retries,
  MIN(created_at) as oldest,
  MAX(created_at) as newest
FROM location_update_queue
GROUP BY status
ORDER BY status;
```

## Troubleshooting

### Posts Not Being Geocoded

1. **Check if queued**:
   ```sql
   SELECT * FROM location_update_queue WHERE post_id = 123;
   ```

2. **Check trigger exists**:
   ```sql
   SELECT tgname FROM pg_trigger WHERE tgrelid = 'posts'::regclass AND tgname = 'trigger_queue_location_update';
   ```

3. **Manually queue**:
   ```sql
   INSERT INTO location_update_queue (post_id, post_address, status)
   SELECT id, post_address, 'pending' FROM posts WHERE id = 123;
   ```

### High Failure Rate

1. **Check error messages**:
   ```sql
   SELECT error_message, COUNT(*) FROM location_update_queue
   WHERE status = 'failed' GROUP BY error_message;
   ```

2. **Common issues**:
   - Invalid addresses → Improve address validation
   - Rate limiting → Increase `API_DELAY` in Edge Function
   - Nominatim downtime → Retry will handle automatically

### Queue Growing Too Large

1. **Increase batch size**:
   ```sql
   -- Update pg_cron job or manual invocation
   SELECT net.http_post(..., body := '{"batch_size": 50}');
   ```

2. **Increase frequency**: Change pg_cron schedule from `*/5` to `*/2` (every 2 minutes)

3. **Parallel processing**: Run multiple Edge Function invocations in parallel (advanced)

## Performance Optimization

### For Large Backlogs

If you have thousands of posts to geocode:

```bash
# Process in larger batches (be mindful of rate limits)
for i in {1..10}; do
  curl -X POST https://***REMOVED***/functions/v1/update-post-coordinates \
    -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
    -d '{"batch_size": 20}' &
  sleep 30 # Stagger requests
done
```

### Database Indexes

Already created by migration:
- `idx_location_queue_status` - Fast status filtering
- `idx_location_queue_post_id` - Fast post lookup
- `idx_location_queue_retry` - Optimized retry queries

## Security

- RLS enabled on `location_update_queue` (service_role only)
- All functions use `SECURITY DEFINER` with `search_path = ''`
- Edge Function requires service role key
- No user-facing queue access

## Best Practices

1. **Monitor queue length** - Alert if pending > 100
2. **Review failures weekly** - Identify systemic issues
3. **Cleanup old entries monthly** - Keep queue table lean
4. **Test address validation** - Prevent invalid addresses from being queued
5. **Rate limit awareness** - Don't exceed Nominatim's 1 req/sec limit

## Migration Guide

### From Old System to New Queue-Based System

The migration (`20251215_comprehensive_geocoding_system.sql`) handles:

1. Creates `location_update_queue` table
2. Removes `POINT(0 0)` default from `posts.location`
3. Backfills existing posts without coordinates
4. Sets up triggers and functions
5. Configures pg_cron (if available)

No manual data migration needed - just run the migration and the system will backfill automatically.

## Related Files

- **Migration**: `/supabase/migrations/20251215_comprehensive_geocoding_system.sql`
- **Edge Function**: `/supabase/functions/update-post-coordinates/index.ts`
- **Shared Logic**: `/supabase/functions/_shared/geocoding.ts`
- **Types**: `/src/types/product.types.ts`

## Support

For issues or questions, check:
1. Supabase Dashboard → Database → Functions → Logs
2. Queue status: `SELECT * FROM location_update_queue WHERE status = 'failed' LIMIT 10;`
3. Edge Function logs in Supabase Dashboard
