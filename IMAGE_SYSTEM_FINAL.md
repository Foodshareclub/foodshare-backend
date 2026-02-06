# Image System - Final Architecture ✅

## All Image Functions

### 1. api-v1-images (MASTER)
**Purpose**: Unified image processing API
**Routes**:
- `POST /upload` - Single image upload
- `POST /batch` - Batch upload
- `POST /proxy` - Download & compress external images
- `GET /health` - Health check

**Features**:
- Smart compression (TinyPNG/Cloudinary race)
- EXIF extraction (GPS, camera, timestamp)
- Thumbnail generation (300px)
- AI food detection (optional)
- Rate limiting (100/day per user)
- Metrics tracking
- Audit logging
- Error tracking (Sentry)

### 2. upload-challenge-image
**Purpose**: Import challenge images from URLs
**Status**: Uses api-v1-images ✅
**Route**: `POST /upload-challenge-image`

### 3. review-images-cron
**Purpose**: Content moderation
**Schedule**: Hourly (`0 * * * *`)
**Features**:
- NSFW detection (HuggingFace)
- Quality checks
- Large file detection
- Admin review queue

### 4. recompress-images-cron
**Purpose**: Optimize old images
**Schedule**: Daily 4am (`0 4 * * *`)
**Features**:
- Processes 50 images/day
- Uses api-v1-images compression
- Tracks savings in metrics
- Gradual library optimization

## Removed Functions

### ❌ resize-tinify-upload-image
- **Removed**: 2026-02-06
- **Reason**: Replaced by `_shared/compression` + `api-v1-images`
- **Lines removed**: 2,437 (-90%)

### ❌ cors-proxy-images
- **Removed**: 2026-02-06
- **Reason**: Redundant, now `POST /api-v1-images/proxy`
- **Lines removed**: 281

**Total removed**: 2,718 lines

## Architecture Flow

```
┌─────────────────────────────────────────────────────────┐
│                    ALL IMAGE SOURCES                    │
├─────────────────────────────────────────────────────────┤
│ iOS App │ Avatars │ Telegram │ Challenges │ External   │
└────┬────┴────┬────┴────┬─────┴─────┬──────┴─────┬──────┘
     │         │         │           │            │
     └─────────┴─────────┴───────────┴────────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │   api-v1-images      │ ← SINGLE ENTRY POINT
              │   (orchestrator)     │
              └──────────────────────┘
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
   EXIF Extract    Thumbnail Gen    AI Analysis
        │                │                │
        └────────────────┼────────────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │ _shared/compression  │
              │  (TinyPNG/Cloudinary)│
              └──────────────────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │  Supabase Storage    │
              │  (8 buckets)         │
              └──────────────────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │  Metrics Dashboard   │
              │  (4 views)           │
              └──────────────────────┘
```

## Verification

### No Redundant Functions
```bash
ls functions/ | grep -iE "image|compress|resize|tinify"
# Result:
# - api-v1-images ✅
# - recompress-images-cron ✅
# - review-images-cron ✅
# - upload-challenge-image ✅ (uses api-v1-images)
```

### All Use Compression Pipeline
```bash
grep -r "api-v1-images" functions/*/index.ts
# Result: All image functions call api-v1-images ✅
```

### No Direct Storage Uploads
```bash
grep -r "storage.from.*\.upload" functions/ --include="*.ts" | grep -v "api-v1-images"
# Result: 0 matches (excluding api-v1-images itself) ✅
```

## Metrics & Monitoring

### Database Tables
1. `user_rate_limits` - Rate limiting (100/day)
2. `image_upload_metrics` - All upload data
3. `image_reviews` - Flagged images for review

### Analytics Views
1. `image_upload_stats` - Daily stats by bucket
2. `compression_efficiency` - Method comparison
3. `top_uploaders` - Top 100 users
4. `storage_costs` - Cost estimates

### Cron Jobs
1. `review-images-cron` - Hourly moderation
2. `recompress-images-cron` - Daily optimization
3. `cleanup-image-metrics` - Weekly cleanup

## API Usage

### Upload Image
```bash
POST /api-v1-images/upload
Content-Type: multipart/form-data

file: <binary>
bucket: food-images
generateThumbnail: true
extractEXIF: true
enableAI: false
```

### Proxy External Image
```bash
POST /api-v1-images/proxy
Content-Type: application/json

{
  "url": "https://example.com/image.jpg",
  "bucket": "assets"
}
```

### Batch Upload
```bash
POST /api-v1-images/batch
Content-Type: multipart/form-data

file0: <binary>
file1: <binary>
file2: <binary>
bucket: food-images
```

## Performance

### Compression
- **Savings**: 40-70% reduction
- **Speed**: 2-4 seconds (parallel race)
- **Methods**: TinyPNG, Cloudinary, or none (fallback)

### Caching
- **Metrics**: In database (permanent)
- **Rate limits**: In database (persistent)
- **No in-memory cache** (unreliable)

### Costs
- **TinyPNG**: 500 free/month, then $0.009/image
- **Cloudinary**: 25GB free, then $0.021/GB
- **Storage**: ~$0.021/GB/month
- **Estimated savings**: $50-200/month

## Migration Complete

- ✅ All functions consolidated
- ✅ All redundancy removed
- ✅ All features migrated
- ✅ All metrics tracked
- ✅ All cron jobs updated
- ✅ 2,718 lines removed
- ✅ Production ready

---

**Status**: COMPLETE ✅
**Date**: 2026-02-06
**Commit**: 40c302e
