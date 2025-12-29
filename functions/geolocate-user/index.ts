// ============================================================================
// GEOLOCATE USER - Before User Created Hook
// Uses IP geolocation to capture approximate user location at signup
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Webhook } from "https://esm.sh/standardwebhooks@1.0.0";

const VERSION = "1.0.0";

// Get the webhook secret from environment
const hookSecret = Deno.env.get("BEFORE_USER_CREATED_HOOK_SECRET")?.replace("v1,whsec_", "");

interface GeoLocation {
  latitude: number;
  longitude: number;
  city?: string;
  region?: string;
  country?: string;
  countryCode?: string;
}

interface IpApiResponse {
  status: string;
  lat?: number;
  lon?: number;
  city?: string;
  regionName?: string;
  country?: string;
  countryCode?: string;
  message?: string;
}

interface HookPayload {
  metadata: {
    uuid: string;
    time: string;
    name: string;
    ip_address: string;
  };
  user: {
    id: string;
    email?: string;
    phone?: string;
    app_metadata: Record<string, unknown>;
    user_metadata: Record<string, unknown>;
  };
}

/**
 * Get geolocation from IP address using ip-api.com (free, no API key required)
 * Rate limit: 45 requests per minute from an IP address
 * For production with higher volume, consider ipinfo.io or ipstack with API keys
 */
async function getLocationFromIP(ipAddress: string): Promise<GeoLocation | null> {
  // Skip private/local IPs
  if (
    ipAddress === "127.0.0.1" ||
    ipAddress === "::1" ||
    ipAddress.startsWith("192.168.") ||
    ipAddress.startsWith("10.") ||
    ipAddress.startsWith("172.")
  ) {
    console.log(`Skipping geolocation for private IP: ${ipAddress}`);
    return null;
  }

  try {
    // Using ip-api.com - free tier, no API key needed
    // Fields: status,lat,lon,city,regionName,country,countryCode
    const response = await fetch(
      `http://ip-api.com/json/${ipAddress}?fields=status,lat,lon,city,regionName,country,countryCode`,
      {
        method: "GET",
        headers: {
          "Accept": "application/json",
        },
      }
    );

    if (!response.ok) {
      console.error(`IP API request failed: ${response.status}`);
      return null;
    }

    const data: IpApiResponse = await response.json();

    if (data.status !== "success" || !data.lat || !data.lon) {
      console.error(`IP geolocation failed: ${data.message || "Unknown error"}`);
      return null;
    }

    return {
      latitude: data.lat,
      longitude: data.lon,
      city: data.city,
      region: data.regionName,
      country: data.country,
      countryCode: data.countryCode,
    };
  } catch (error) {
    console.error("Error fetching geolocation:", error);
    return null;
  }
}

Deno.serve(async (req: Request) => {
  const startTime = Date.now();
  const requestId = crypto.randomUUID();

  console.log(`[${requestId}] Geolocate user hook triggered`);

  try {
    const payload = await req.text();
    const headers = Object.fromEntries(req.headers);

    // Verify webhook signature if secret is configured
    let event: HookPayload;
    
    if (hookSecret) {
      try {
        const wh = new Webhook(hookSecret);
        event = wh.verify(payload, headers) as HookPayload;
      } catch (error) {
        console.error(`[${requestId}] Webhook verification failed:`, error);
        return new Response(
          JSON.stringify({
            error: {
              message: "Invalid webhook signature",
              http_code: 401,
            },
          }),
          {
            status: 401,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    } else {
      // No secret configured, parse payload directly (development mode)
      console.warn(`[${requestId}] No webhook secret configured - running in development mode`);
      event = JSON.parse(payload) as HookPayload;
    }

    const ipAddress = event.metadata?.ip_address;
    const userId = event.user?.id;

    console.log(`[${requestId}] Processing user ${userId} with IP: ${ipAddress}`);

    if (!ipAddress) {
      console.log(`[${requestId}] No IP address provided, allowing signup`);
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Get geolocation from IP
    const location = await getLocationFromIP(ipAddress);

    if (location) {
      console.log(
        `[${requestId}] Geolocation found: ${location.city}, ${location.country} ` +
        `(${location.latitude}, ${location.longitude})`
      );

      // Return the location data to be stored in user_metadata
      // The auth system will merge this into the user's metadata
      const duration = Date.now() - startTime;
      
      return new Response(
        JSON.stringify({
          user_metadata: {
            signup_location: {
              latitude: location.latitude,
              longitude: location.longitude,
              city: location.city,
              region: location.region,
              country: location.country,
              country_code: location.countryCode,
              source: "ip_geolocation",
              captured_at: new Date().toISOString(),
            },
          },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Request-ID": requestId,
            "X-Version": VERSION,
            "X-Duration-Ms": duration.toString(),
          },
        }
      );
    }

    // No location found, but allow signup to proceed
    console.log(`[${requestId}] Could not determine location, allowing signup`);
    const duration = Date.now() - startTime;

    return new Response("{}", {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-Request-ID": requestId,
        "X-Version": VERSION,
        "X-Duration-Ms": duration.toString(),
      },
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[${requestId}] Error in geolocate-user hook:`, error);

    // Don't block signup on errors - just log and continue
    return new Response("{}", {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-Request-ID": requestId,
        "X-Version": VERSION,
        "X-Duration-Ms": duration.toString(),
      },
    });
  }
});
