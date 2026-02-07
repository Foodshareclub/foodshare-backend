/**
 * EXIF Metadata Extraction Service
 * @module api-v1-images/services/exif
 */

import ExifReader from "npm:exifreader@4.23.3";
import type { EXIFData } from "../types/index.ts";
import { logger } from "../../_shared/logger.ts";

export async function extractEXIF(imageData: Uint8Array): Promise<EXIFData | null> {
  try {
    const tags = ExifReader.load(imageData.buffer);
    
    const exif: EXIFData = {};
    
    // Extract GPS coordinates
    if (tags.GPSLatitude && tags.GPSLongitude) {
      const lat = parseGPSCoordinate(tags.GPSLatitude.description);
      const lon = parseGPSCoordinate(tags.GPSLongitude.description);
      
      if (lat !== null && lon !== null) {
        exif.gps = { latitude: lat, longitude: lon };
      }
    }
    
    // Extract timestamp
    if (tags.DateTime?.description) {
      exif.timestamp = tags.DateTime.description;
    } else if (tags.DateTimeOriginal?.description) {
      exif.timestamp = tags.DateTimeOriginal.description;
    }
    
    // Extract camera info
    if (tags.Make?.description || tags.Model?.description) {
      exif.camera = {
        make: tags.Make?.description,
        model: tags.Model?.description,
      };
    }
    
    // Extract orientation
    if (tags.Orientation?.value) {
      exif.orientation = tags.Orientation.value as number;
    }
    
    return Object.keys(exif).length > 0 ? exif : null;
  } catch (error) {
    logger.warn("EXIF extraction failed", { error });
    return null;
  }
}

function parseGPSCoordinate(description: string | undefined): number | null {
  if (!description) return null;
  
  // Parse formats like "37° 46' 29.99\" N" or "122° 25' 9.99\" W"
  const match = description.match(/(\d+)°\s*(\d+)'\s*([\d.]+)"\s*([NSEW])/);
  if (!match) return null;
  
  const [, degrees, minutes, seconds, direction] = match;
  let decimal = parseFloat(degrees) + parseFloat(minutes) / 60 + parseFloat(seconds) / 3600;
  
  if (direction === "S" || direction === "W") {
    decimal = -decimal;
  }
  
  return decimal;
}

export function getImageDimensions(imageData: Uint8Array): { width: number; height: number } | null {
  try {
    const tags = ExifReader.load(imageData.buffer);
    
    const width = tags["Image Width"]?.value || tags.PixelXDimension?.value;
    const height = tags["Image Height"]?.value || tags.PixelYDimension?.value;
    
    if (width && height) {
      return { width: width as number, height: height as number };
    }
    
    return null;
  } catch {
    return null;
  }
}
