import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Unified Map Services with Intelligent Preloading
// Handles: preferences, sync, analytics, tile caching, predictive loading

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

// Redis client with tile caching
let redis: any = null
async function getRedis() {
  if (!redis) {
    const { Redis } = await import('https://esm.sh/@upstash/redis@1.22.1')
    redis = new Redis({
      url: Deno.env.get('UPSTASH_REDIS_URL')!,
      token: Deno.env.get('UPSTASH_REDIS_TOKEN')!,
    })
  }
  return redis
}

// WebSocket connections
const wsConnections = new Map<string, WebSocket>()

// Tile cache with 24h TTL
const TILE_CACHE_TTL = 86400

export default async function handler(req: Request) {
  const url = new URL(req.url)
  const service = url.pathname.split('/').pop()
  
  switch (service) {
    case 'preferences':
      return await handlePreferences(req)
    case 'sync':
      return await handleSync(req)
    case 'analytics':
      return await handleAnalytics(req)
    case 'preload':
      return await handlePreload(req)
    case 'tiles':
      return await handleTiles(req)
    case 'quality':
      return await handleQuality(req)
    default:
      return new Response('Service not found', { status: 404 })
  }
}

// ============================================================================
// ADAPTIVE QUALITY SERVICE
// ============================================================================

async function handleQuality(req: Request) {
  const { method } = req
  const user = await getAuthenticatedUser(req)
  if (!user) return new Response('Unauthorized', { status: 401 })

  switch (method) {
    case 'POST':
      return await updateNetworkProfile(user.id, req)
    case 'GET':
      return await getOptimalSettings(user.id, req)
    default:
      return new Response('Method not allowed', { status: 405 })
  }
}

async function updateNetworkProfile(userId: string, req: Request) {
  const { bandwidth, latency, connectionType, deviceInfo } = await req.json()
  
  const { data, error } = await supabase.rpc('update_network_profile', {
    p_user_id: userId,
    p_bandwidth_mbps: bandwidth,
    p_latency_ms: latency,
    p_connection_type: connectionType,
    p_device_info: deviceInfo
  })

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ success: true, settings: data })
}

async function getOptimalSettings(userId: string, req: Request) {
  const { data, error } = await supabase
    .from('user_network_profiles')
    .select('*')
    .eq('user_id', userId)
    .single()

  if (error) {
    // Return default settings for new users
    return Response.json({
      success: true,
      settings: {
        quality: 'medium',
        retina: true,
        vector: true,
        concurrent_tiles: 6,
        compression: 'medium'
      }
    })
  }

  const settings = {
    quality: data.preferred_tile_quality,
    retina: data.enable_retina,
    vector: data.enable_vector_tiles,
    concurrent_tiles: data.max_concurrent_tiles,
    compression: data.avg_bandwidth_mbps < 2 ? 'high' : 
                 data.avg_bandwidth_mbps < 10 ? 'medium' : 'low'
  }

  return Response.json({ success: true, settings })
}

// ============================================================================
// ENHANCED TILE SERVICE WITH ADAPTIVE QUALITY
// ============================================================================

async function handleTiles(req: Request) {
  const url = new URL(req.url)
  const tileUrl = url.searchParams.get('url')
  const quality = url.searchParams.get('quality') || 'medium'
  const compression = url.searchParams.get('compression') || 'medium'
  
  if (!tileUrl) {
    return new Response('Missing tile URL', { status: 400 })
  }

  const cacheKey = `tile:${quality}:${compression}:${btoa(tileUrl)}`
  const redisClient = await getRedis()

  try {
    // Check cache first
    const cached = await redisClient.get(cacheKey)
    if (cached) {
      const tileData = Uint8Array.from(atob(cached), c => c.charCodeAt(0))
      return new Response(tileData, {
        headers: {
          'Content-Type': 'image/webp',
          'Cache-Control': 'public, max-age=86400',
          'X-Cache': 'HIT',
          'X-Quality': quality
        }
      })
    }

    // Fetch and process tile
    const response = await fetch(tileUrl)
    if (!response.ok) {
      return new Response('Tile not found', { status: 404 })
    }

    let tileData = await response.arrayBuffer()
    
    // Apply quality optimizations
    tileData = await optimizeTile(tileData, quality, compression)
    
    const base64Data = btoa(String.fromCharCode(...new Uint8Array(tileData)))
    await redisClient.setex(cacheKey, TILE_CACHE_TTL, base64Data)

    return new Response(tileData, {
      headers: {
        'Content-Type': 'image/webp',
        'Cache-Control': 'public, max-age=86400',
        'X-Cache': 'MISS',
        'X-Quality': quality
      }
    })
  } catch (error) {
    console.error('Adaptive tile error:', error)
    return new Response('Internal error', { status: 500 })
  }
}

async function optimizeTile(tileData: ArrayBuffer, quality: string, compression: string): Promise<ArrayBuffer> {
  // Simulate tile optimization (in production, use image processing library)
  const qualityMap = { low: 0.6, medium: 0.8, high: 1.0 }
  const compressionMap = { low: 0.9, medium: 0.7, high: 0.5 }
  
  const qualityFactor = qualityMap[quality] || 0.8
  const compressionFactor = compressionMap[compression] || 0.7
  
  // In production: resize, compress, convert to WebP
  // For now, return original data
  return tileData
}

// ============================================================================
// ENHANCED PRELOAD WITH ADAPTIVE QUALITY
// ============================================================================

async function handlePreload(req: Request) {
  const user = await getAuthenticatedUser(req)
  if (!user) return new Response('Unauthorized', { status: 401 })

  const url = new URL(req.url)
  const platform = url.searchParams.get('platform') || 'web'
  
  // Get user's network profile for adaptive preloading
  const { data: profile } = await supabase
    .from('user_network_profiles')
    .select('*')
    .eq('user_id', user.id)
    .single()

  const maxTiles = profile?.max_concurrent_tiles || 6
  const quality = profile?.preferred_tile_quality || 'medium'
  
  // Get ML predictions
  const { data: hotspots } = await supabase.rpc('detect_map_hotspots', {
    p_user_id: user.id,
    p_radius_meters: 2000,
    p_min_interactions: 3
  })

  if (!hotspots?.length) {
    return Response.json({ success: true, preloadUrls: [] })
  }

  // Generate adaptive tile URLs
  const preloadUrls = []
  const currentHour = new Date().getHours()
  
  for (const hotspot of hotspots.slice(0, 2)) { // Limit based on network
    const center = {
      lat: hotspot.hotspot_center.coordinates[1],
      lng: hotspot.hotspot_center.coordinates[0]
    }
    
    const timeRelevance = 1 - Math.abs(hotspot.primary_time_of_day - currentHour) / 12
    const priority = hotspot.confidence_score * timeRelevance
    
    if (priority > 0.3) {
      const radius = profile?.avg_bandwidth_mbps > 10 ? 2 : 1 // Adaptive radius
      const tileUrls = generateAdaptiveTileUrls(center, hotspot.avg_zoom, radius, quality)
      preloadUrls.push(...tileUrls.map(url => ({ url, priority, quality })))
    }
  }

  // Limit tiles based on network capacity
  const limitedUrls = preloadUrls
    .sort((a, b) => b.priority - a.priority)
    .slice(0, maxTiles)

  // Trigger background adaptive preloading
  if (limitedUrls.length > 0) {
    Promise.resolve().then(() => preloadAdaptiveTiles(limitedUrls, profile))
  }

  return Response.json({
    success: true,
    preloadUrls: limitedUrls,
    quality,
    maxTiles
  })
}

function generateAdaptiveTileUrls(
  center: {lat: number, lng: number}, 
  zoom: number, 
  radius: number, 
  quality: string
): string[] {
  const urls = []
  const z = Math.floor(zoom)
  const x = Math.floor((center.lng + 180) / 360 * Math.pow(2, z))
  const y = Math.floor((1 - Math.log(Math.tan(center.lat * Math.PI / 180) + 1 / Math.cos(center.lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, z))
  
  // Use different tile sources based on quality
  const baseUrl = quality === 'high' 
    ? 'https://tile.openstreetmap.org' 
    : 'https://cartodb-basemaps-a.global.ssl.fastly.net/light_all'
  
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      urls.push(`${baseUrl}/${z}/${x + dx}/${y + dy}.png`)
    }
  }
  
  return urls
}

async function preloadAdaptiveTiles(tiles: any[], profile: any) {
  const redisClient = await getRedis()
  const quality = profile?.preferred_tile_quality || 'medium'
  const compression = profile?.avg_bandwidth_mbps < 2 ? 'high' : 'medium'
  
  // Process tiles with adaptive concurrency
  const concurrency = profile?.max_concurrent_tiles || 6
  const chunks = []
  for (let i = 0; i < tiles.length; i += concurrency) {
    chunks.push(tiles.slice(i, i + concurrency))
  }
  
  for (const chunk of chunks) {
    await Promise.all(chunk.map(async (tile) => {
      try {
        const cacheKey = `tile:${quality}:${compression}:${btoa(tile.url)}`
        const exists = await redisClient.exists(cacheKey)
        
        if (!exists) {
          const response = await fetch(tile.url)
          if (response.ok) {
            let tileData = await response.arrayBuffer()
            tileData = await optimizeTile(tileData, quality, compression)
            const base64Data = btoa(String.fromCharCode(...new Uint8Array(tileData)))
            await redisClient.setex(cacheKey, TILE_CACHE_TTL, base64Data)
          }
        }
      } catch (error) {
        console.error('Adaptive preload error:', error)
      }
    }))
  }
}

// ============================================================================
// ENHANCED PREFERENCES WITH PRELOADING
// ============================================================================

async function handlePreferences(req: Request) {
  const { method } = req
  const user = await getAuthenticatedUser(req)
  if (!user) return new Response('Unauthorized', { status: 401 })

  switch (method) {
    case 'GET':
      return await getPreferencesWithPreload(user.id, req)
    case 'POST':
      return await savePreferences(user.id, req)
    default:
      return new Response('Method not allowed', { status: 405 })
  }
}

async function getPreferencesWithPreload(userId: string, req: Request) {
  const url = new URL(req.url)
  const platform = url.searchParams.get('platform') || 'web'
  
  // Get preferences (existing logic)
  const prefsResponse = await getPreferences(userId, req)
  const prefsData = await prefsResponse.json()

  // Add preload data if preferences found
  if (prefsData.success && prefsData.preferences) {
    const center = {
      lat: prefsData.preferences.last_center_lat,
      lng: prefsData.preferences.last_center_lng
    }
    const zoom = prefsData.preferences.last_zoom_level

    // Generate preload URLs for current location
    const preloadUrls = generateTileUrls(center, zoom, 1)
    prefsData.preloadUrls = preloadUrls.slice(0, 9) // 3x3 grid

    // Background preload
    Promise.resolve().then(() => preloadTiles(preloadUrls.map(url => ({ url, priority: 1.0 }))))
  }

  return Response.json(prefsData)
}

// ============================================================================
// EXISTING SERVICES (preferences, sync, analytics)
// ============================================================================

async function getPreferences(userId: string, req: Request) {
  const url = new URL(req.url)
  const platform = url.searchParams.get('platform') || 'web'
  
  try {
    const cacheKey = `map_prefs:${platform}:${userId}`
    const cached = await (await getRedis()).get(cacheKey)
    
    if (cached) {
      return Response.json({ 
        success: true, 
        preferences: JSON.parse(cached),
        source: 'cache'
      })
    }
  } catch (error) {
    console.error('Redis error:', error)
  }
  
  const { data, error } = await supabase
    .from('user_map_preferences')
    .select('*')
    .eq('user_id', userId)
    .eq('platform', platform)
    .single()

  if (error && error.code !== 'PGRST116') {
    return Response.json({ error: error.message }, { status: 500 })
  }

  if (data) {
    try {
      const cacheKey = `map_prefs:${platform}:${userId}`
      await (await getRedis()).setex(cacheKey, 3600, JSON.stringify(data))
    } catch (error) {
      console.error('Redis cache write failed:', error)
    }
  }

  return Response.json({ 
    success: true, 
    preferences: data,
    source: 'database'
  })
}

async function savePreferences(userId: string, req: Request) {
  const { center, zoom, mapStyle, searchRadius, platform, deviceId } = await req.json()

  const preferences = {
    user_id: userId,
    platform: platform || 'web',
    device_id: deviceId || null,
    last_center_lat: center.lat,
    last_center_lng: center.lng,
    last_zoom_level: zoom,
    map_style: mapStyle || 'standard',
    search_radius_km: searchRadius || 10.0
  }

  const { data, error } = await supabase
    .from('user_map_preferences')
    .upsert(preferences, { onConflict: 'user_id,platform,device_id' })
    .select()
    .single()

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  try {
    const cacheKey = `map_prefs:${platform}:${userId}`
    await (await getRedis()).setex(cacheKey, 3600, JSON.stringify(data))
  } catch (error) {
    console.error('Redis cache update failed:', error)
  }

  broadcastToUser(userId, {
    type: 'map_preferences_updated',
    userId,
    platform,
    deviceId,
    preferences: { center, zoom, timestamp: Date.now() }
  })

  return Response.json({ success: true, data })
}

async function handleSync(req: Request) {
  const upgrade = req.headers.get('upgrade')
  if (upgrade !== 'websocket') {
    return new Response('Expected websocket', { status: 400 })
  }

  const { socket, response } = Deno.upgradeWebSocket(req)
  let userId: string | null = null

  socket.onopen = () => console.log('WebSocket connected')

  socket.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data)
      
      if (data.type === 'auth') {
        userId = data.userId
        if (userId) {
          wsConnections.set(userId, socket)
        }
        return
      }

      if (data.type === 'map_sync' && userId) {
        broadcastToUser(userId, {
          type: 'map_preferences_updated',
          userId,
          platform: data.platform,
          deviceId: data.deviceId,
          preferences: {
            center: data.center,
            zoom: data.zoom,
            timestamp: Date.now()
          }
        }, socket)
      }
    } catch (error) {
      console.error('WebSocket message error:', error)
    }
  }

  socket.onclose = () => {
    if (userId) wsConnections.delete(userId)
  }

  return response
}

async function handleAnalytics(req: Request) {
  const { method } = req
  const user = await getAuthenticatedUser(req)
  if (!user) return new Response('Unauthorized', { status: 401 })

  if (method === 'POST') {
    const analytics = await req.json()
    const now = new Date()
    
    const { error } = await supabase
      .from('map_interaction_events')
      .insert({
        user_id: user.id,
        center_lat: analytics.center.lat,
        center_lng: analytics.center.lng,
        zoom_level: analytics.zoom,
        platform: analytics.platform,
        device_id: analytics.deviceId,
        session_id: analytics.sessionId,
        time_of_day: now.getHours(),
        day_of_week: now.getDay(),
        duration_seconds: analytics.durationSeconds || 0,
        interaction_type: analytics.interactionType
      })

    return Response.json({ success: !error, error: error?.message })
  }

  if (method === 'GET') {
    const url = new URL(req.url)
    const { data, error } = await supabase.rpc('detect_map_hotspots', {
      p_user_id: user.id,
      p_radius_meters: parseInt(url.searchParams.get('radius') || '1000'),
      p_min_interactions: parseInt(url.searchParams.get('min_interactions') || '5')
    })

    if (error) return Response.json({ error: error.message }, { status: 500 })

    const hotspots = data.map((row: any) => ({
      center: {
        lat: row.hotspot_center.coordinates[1],
        lng: row.hotspot_center.coordinates[0]
      },
      interactionCount: row.interaction_count,
      avgZoom: row.avg_zoom,
      primaryTimeOfDay: row.primary_time_of_day,
      confidenceScore: row.confidence_score
    }))

    return Response.json({
      success: true,
      hotspots,
      predictedCenter: hotspots[0]?.center || null
    })
  }

  return new Response('Method not allowed', { status: 405 })
}

// ============================================================================
// UTILITIES
// ============================================================================

async function getAuthenticatedUser(req: Request) {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return null

  const { data: { user } } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''))
  return user
}

function broadcastToUser(userId: string, message: any, excludeSocket?: WebSocket) {
  const userSocket = wsConnections.get(userId)
  if (userSocket && userSocket !== excludeSocket && userSocket.readyState === WebSocket.OPEN) {
    userSocket.send(JSON.stringify(message))
  }
}

function generateTileUrls(center: {lat: number, lng: number}, zoom: number, radius: number = 1): string[] {
  const urls = []
  const z = Math.floor(zoom)
  const x = Math.floor((center.lng + 180) / 360 * Math.pow(2, z))
  const y = Math.floor((1 - Math.log(Math.tan(center.lat * Math.PI / 180) + 1 / Math.cos(center.lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, z))
  
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      urls.push(`https://tile.openstreetmap.org/${z}/${x + dx}/${y + dy}.png`)
    }
  }
  
  return urls
}

async function preloadTiles(tiles: {url: string, priority: number}[]) {
  const redisClient = await getRedis()
  
  for (const tile of tiles.sort((a, b) => b.priority - a.priority)) {
    try {
      const cacheKey = `tile:${btoa(tile.url)}`
      const exists = await redisClient.exists(cacheKey)
      
      if (!exists) {
        const response = await fetch(tile.url)
        if (response.ok) {
          const tileData = await response.arrayBuffer()
          const base64Data = btoa(String.fromCharCode(...new Uint8Array(tileData)))
          await redisClient.setex(cacheKey, TILE_CACHE_TTL, base64Data)
        }
      }
    } catch (error) {
      console.error('Preload error:', error)
    }
  }
}
