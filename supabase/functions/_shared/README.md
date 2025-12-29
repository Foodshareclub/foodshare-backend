# Shared Edge Function Utilities

This directory contains shared utilities used across multiple Supabase Edge Functions.

## Geocoding Service

The geocoding service provides a unified, optimized interface for converting addresses to coordinates using the Nominatim (OpenStreetMap) API.

### Features

- **Caching**: 7-day in-memory cache to reduce API calls
- **Rate Limiting**: Automatic 1-second delay between requests (Nominatim requirement)
- **Retry Logic**: Exponential backoff with 3 retry attempts
- **Timeout Protection**: 10-second timeout per request
- **Address Normalization**: Automatic cleanup of apartment numbers, USA → US conversion
- **Progressive Fallback**: Tries full address first, then progressively simplifies
- **Country Fallbacks**: Automatically tries common countries if not specified
- **Validation**: Ensures coordinates are valid and non-zero

### Usage

```typescript
import {
  geocodeAddress,
  geocodeWithCountryFallback,
  type Coordinates,
} from "../_shared/geocoding.ts";

// Simple geocoding
const coords = await geocodeAddress("123 Main St, New York, NY");
if (coords) {
  console.log(`Lat: ${coords.latitude}, Lon: ${coords.longitude}`);
}

// With country fallbacks
const coords2 = await geocodeWithCountryFallback("Prague, Wenceslas Square");
// Will try: Prague, Wenceslas Square → Prague, Wenceslas Square, USA → Prague, Wenceslas Square, Czech Republic → etc.
```

### API Reference

#### `geocodeAddress(address: string): Promise<Coordinates | null>`

Geocodes a single address with caching and retry logic.

**Parameters:**

- `address` - The address string to geocode

**Returns:**

- `Coordinates` object with `latitude` and `longitude`, or `null` if geocoding fails

**Example:**

```typescript
const coords = await geocodeAddress("1600 Pennsylvania Avenue NW, Washington, DC");
```

#### `geocodeWithCountryFallback(location: string, fallbackCountries?: string[]): Promise<Coordinates | null>`

Geocodes with automatic country fallbacks if the initial attempt fails.

**Parameters:**

- `location` - The location string to geocode
- `fallbackCountries` - Optional array of countries to try (default: ["USA", "United States", "Czech Republic", "France", "Russia"])

**Returns:**

- `Coordinates` object with `latitude` and `longitude`, or `null` if all attempts fail

**Example:**

```typescript
const coords = await geocodeWithCountryFallback("Prague Castle");
```

#### `cleanupCache(): void`

Removes expired cache entries (older than 7 days).

**Example:**

```typescript
// Call periodically to prevent memory growth
cleanupCache();
```

#### `getCacheStats(): { size: number; hitRate?: number }`

Returns cache statistics for monitoring.

**Example:**

```typescript
const stats = getCacheStats();
console.log(`Cache size: ${stats.size} entries`);
```

### Performance Characteristics

- **Cache Hit**: ~1ms (instant)
- **Cache Miss**: 1-3 seconds (depends on Nominatim response time)
- **Rate Limiting**: Minimum 1 second between requests
- **Timeout**: 10 seconds maximum per request
- **Retries**: Up to 3 attempts with exponential backoff

### Best Practices

1. **Batch Operations**: Add delays between geocoding calls in loops

   ```typescript
   for (const address of addresses) {
     const coords = await geocodeAddress(address);
     await new Promise((resolve) => setTimeout(resolve, 1000));
   }
   ```

2. **Error Handling**: Always check for null results

   ```typescript
   const coords = await geocodeAddress(address);
   if (!coords) {
     console.error("Failed to geocode:", address);
     return;
   }
   ```

3. **Cache Cleanup**: Call `cleanupCache()` periodically in long-running functions

   ```typescript
   setInterval(() => cleanupCache(), 60 * 60 * 1000); // Every hour
   ```

4. **Specific Addresses**: Provide complete addresses for better accuracy

   ```typescript
   // Good
   await geocodeAddress("123 Main St, Springfield, IL 62701, USA");

   // Less accurate
   await geocodeAddress("Springfield");
   ```

### Limitations

- **Rate Limits**: Nominatim allows 1 request per second
- **Cache Size**: In-memory cache grows with unique addresses (consider Redis for production)
- **Accuracy**: Results depend on OpenStreetMap data quality
- **No Batch API**: Each address requires a separate request

### Troubleshooting

**Problem**: Geocoding returns null for valid addresses

**Solutions:**

- Check if address is too vague (add city, state, country)
- Try `geocodeWithCountryFallback()` instead
- Check Nominatim API status
- Verify address format matches OpenStreetMap conventions

**Problem**: Rate limiting errors

**Solutions:**

- Ensure minimum 1-second delay between calls
- Use the built-in rate limiting (automatic)
- Reduce batch sizes

**Problem**: Cache growing too large

**Solutions:**

- Call `cleanupCache()` regularly
- Consider implementing Redis for production
- Reduce `CACHE_TTL_MS` in the source code

### Future Improvements

- [ ] Redis cache for multi-instance deployments
- [ ] Batch geocoding support
- [ ] Alternative geocoding providers (Google, Mapbox)
- [ ] Cache hit rate tracking
- [ ] Prometheus metrics export
- [ ] Configurable cache TTL
- [ ] Address validation before geocoding
