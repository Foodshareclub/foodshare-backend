# FoodShare API Reference v2.0

## Base URL
```
https://your-project.supabase.co/functions/v1
```

## Authentication
All endpoints require Bearer token unless specified:
```
Authorization: Bearer YOUR_TOKEN
```

---

## Image API v1

### Upload Image
**POST** `/api-v1-images/upload`

Upload and compress image with optional thumbnail generation.

**Request:**
```bash
curl -X POST $BASE_URL/api-v1-images/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@image.jpg" \
  -F "bucket=food-images" \
  -F "generateThumbnail=true"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "url": "https://storage.url/image.jpg",
    "path": "uuid.jpg",
    "thumbnailUrl": "https://storage.url/thumb.jpg"
  },
  "metadata": {
    "originalSize": 1024000,
    "finalSize": 512000,
    "savedBytes": 512000,
    "format": "jpeg",
    "storage": "r2"
  }
}
```

### Upload from URL
**POST** `/api-v1-images/upload-from-url`

Download external image and upload to storage.

**Request:**
```json
{
  "imageUrl": "https://example.com/image.jpg",
  "bucket": "challenges",
  "challengeId": 123
}
```

---

## Engagement API v1

### Get Engagement Status
**GET** `/api-v1-engagement?postId={id}`

Get like/bookmark/favorite status for a post.

**Response:**
```json
{
  "postId": 123,
  "isLiked": true,
  "isBookmarked": false,
  "likeCount": 42
}
```

### Toggle Favorite
**POST** `/api-v1-engagement?action=favorite&mode=toggle`

Atomically toggle favorite status.

**Modes:** `toggle`, `add`, `remove`

**Request:**
```json
{
  "postId": 123
}
```

**Response:**
```json
{
  "postId": 123,
  "isFavorited": true,
  "likeCount": 43,
  "action": "added"
}
```

### Toggle Like
**POST** `/api-v1-engagement?action=like`

**Request:**
```json
{
  "postId": 123
}
```

### Toggle Bookmark
**POST** `/api-v1-engagement?action=bookmark`

**Request:**
```json
{
  "postId": 123
}
```

### Batch Operations
**POST** `/api-v1-engagement/batch`

Process multiple engagement operations in one request.

**Request:**
```json
{
  "operations": [
    {
      "correlationId": "uuid-1",
      "type": "toggle_favorite",
      "entityId": "123"
    },
    {
      "correlationId": "uuid-2",
      "type": "toggle_like",
      "entityId": "456"
    }
  ]
}
```

**Supported Types:**
- `toggle_favorite`
- `toggle_like`
- `toggle_bookmark`
- `mark_read`
- `archive_room`

---

## Metrics API v1

### Track Event
**POST** `/api-v1-metrics/event`

Track single user event.

**Request:**
```json
{
  "eventType": "listing_view",
  "data": {
    "listingId": "123"
  }
}
```

**Valid Event Types:**
- `listing_view`, `search`, `share_complete`, `message_sent`
- `feed_scroll`, `save`, `profile_view`, `category_browse`
- `notification_opened`, `app_open`, `app_background`

### Track Batch Events
**POST** `/api-v1-metrics/events`

**Request:**
```json
{
  "events": [
    { "eventType": "app_open" },
    { "eventType": "feed_scroll" }
  ]
}
```

---

## Notifications API v1

### Send Push
**POST** `/api-v1-notifications/send`

Send push notification with platform-specific options.

**Request:**
```json
{
  "userId": "user-uuid",
  "type": "new_message",
  "title": "New Message",
  "body": "You have a new message",
  "channels": ["push"],
  "ios": {
    "interruptionLevel": "time-sensitive"
  },
  "android": {
    "channelId": "messages"
  },
  "deepLink": {
    "entityType": "chat",
    "entityId": "room-uuid"
  }
}
```

---

## Migration from Old Endpoints

### Favorites
```diff
- POST /atomic-favorites
+ POST /api-v1-engagement?action=favorite&mode=toggle
```

### Event Tracking
```diff
- POST /track-event
+ POST /api-v1-metrics/event
```

### Batch Operations
```diff
- POST /batch-operations
+ POST /api-v1-engagement/batch
```

### Push Notifications
```diff
- POST /send-push-notification
+ POST /api-v1-notifications/send
```

---

## Rate Limits

| Endpoint | Limit |
|----------|-------|
| /api-v1-images/upload | 100/day per user |
| /api-v1-engagement | 120/min per IP |
| /api-v1-metrics/event | 100/min per user |
| /api-v1-notifications/send | 60/min per user |

---

## Error Format

```json
{
  "error": "Error message",
  "code": "ERROR_CODE",
  "requestId": "uuid"
}
```

**Common Codes:**
- `VALIDATION_ERROR` - Invalid request
- `AUTH_ERROR` - Authentication failed
- `RATE_LIMIT_EXCEEDED` - Too many requests
- `SERVER_ERROR` - Internal error
