# Image Upload Metrics Dashboard

## Quick Stats

### Daily Upload Summary
```sql
SELECT * FROM image_upload_stats
ORDER BY upload_date DESC
LIMIT 7;
```

### Compression Performance
```sql
SELECT * FROM compression_efficiency;
```

### Storage Costs
```sql
SELECT 
  bucket,
  total_gb,
  estimated_monthly_cost_usd,
  file_count
FROM storage_costs
ORDER BY total_gb DESC;
```

### Top Uploaders (Last 30 Days)
```sql
SELECT * FROM top_uploaders LIMIT 10;
```

## Detailed Queries

### Hourly Upload Rate
```sql
SELECT 
  DATE_TRUNC('hour', uploaded_at) as hour,
  COUNT(*) as uploads,
  SUM(saved_bytes) / 1024.0 / 1024.0 as mb_saved
FROM image_upload_metrics
WHERE uploaded_at > NOW() - INTERVAL '24 hours'
GROUP BY hour
ORDER BY hour DESC;
```

### Compression Method Breakdown
```sql
SELECT 
  compression_method,
  COUNT(*) as uses,
  ROUND(AVG(processing_time_ms)) as avg_ms,
  ROUND(AVG(saved_bytes::NUMERIC / NULLIF(original_size, 0) * 100), 2) as avg_savings_pct
FROM image_upload_metrics
WHERE uploaded_at > NOW() - INTERVAL '7 days'
GROUP BY compression_method;
```

### Failed Compressions (returned original)
```sql
SELECT 
  bucket,
  COUNT(*) as failed_count,
  AVG(original_size) / 1024.0 / 1024.0 as avg_size_mb
FROM image_upload_metrics
WHERE compression_method = 'none'
  AND uploaded_at > NOW() - INTERVAL '7 days'
GROUP BY bucket;
```

### Rate Limit Status
```sql
SELECT 
  user_id,
  count,
  reset_at,
  CASE 
    WHEN count >= 100 THEN 'BLOCKED'
    WHEN count >= 80 THEN 'WARNING'
    ELSE 'OK'
  END as status
FROM user_rate_limits
WHERE key = 'image_upload_count'
  AND reset_at > NOW()
ORDER BY count DESC
LIMIT 20;
```

### Total Savings
```sql
SELECT 
  SUM(saved_bytes) / 1024.0 / 1024.0 / 1024.0 as total_gb_saved,
  COUNT(*) as total_uploads,
  ROUND(AVG(saved_bytes::NUMERIC / NULLIF(original_size, 0) * 100), 2) as avg_savings_pct
FROM image_upload_metrics;
```

## Alerts

### Users Near Rate Limit
```sql
SELECT 
  user_id,
  count,
  100 - count as remaining,
  reset_at
FROM user_rate_limits
WHERE key = 'image_upload_count'
  AND count >= 80
  AND reset_at > NOW()
ORDER BY count DESC;
```

### Large Uncompressed Files
```sql
SELECT 
  bucket,
  path,
  original_size / 1024.0 / 1024.0 as size_mb,
  compression_method,
  uploaded_at
FROM image_upload_metrics
WHERE compression_method = 'none'
  AND original_size > 1024 * 1024 -- > 1MB
  AND uploaded_at > NOW() - INTERVAL '24 hours'
ORDER BY original_size DESC;
```

### Slow Uploads
```sql
SELECT 
  bucket,
  path,
  processing_time_ms / 1000.0 as seconds,
  compression_method,
  uploaded_at
FROM image_upload_metrics
WHERE processing_time_ms > 5000 -- > 5 seconds
  AND uploaded_at > NOW() - INTERVAL '24 hours'
ORDER BY processing_time_ms DESC;
```

## Cost Analysis

### Monthly Cost Projection
```sql
SELECT 
  bucket,
  SUM(compressed_size) / 1024.0 / 1024.0 / 1024.0 as gb_this_month,
  ROUND((SUM(compressed_size) / 1024.0 / 1024.0 / 1024.0 * 0.021)::NUMERIC, 2) as estimated_cost_usd
FROM image_upload_metrics
WHERE uploaded_at > DATE_TRUNC('month', NOW())
GROUP BY bucket
ORDER BY gb_this_month DESC;
```

### Savings vs Cost
```sql
SELECT 
  SUM(saved_bytes) / 1024.0 / 1024.0 / 1024.0 as gb_saved,
  SUM(compressed_size) / 1024.0 / 1024.0 / 1024.0 as gb_stored,
  ROUND((SUM(compressed_size) / 1024.0 / 1024.0 / 1024.0 * 0.021)::NUMERIC, 2) as storage_cost_usd,
  ROUND((SUM(saved_bytes) / 1024.0 / 1024.0 / 1024.0 * 0.021)::NUMERIC, 2) as savings_usd
FROM image_upload_metrics
WHERE uploaded_at > DATE_TRUNC('month', NOW());
```

## Setup

### Enable Sentry (Optional)
```bash
supabase secrets set SENTRY_DSN=your_sentry_dsn_here
```

### View Metrics in Supabase Dashboard
1. Go to SQL Editor
2. Run any query above
3. Save as "Saved Query" for quick access

### Export to CSV
```sql
COPY (
  SELECT * FROM image_upload_stats
  WHERE upload_date > NOW() - INTERVAL '30 days'
) TO '/tmp/upload_stats.csv' CSV HEADER;
```
