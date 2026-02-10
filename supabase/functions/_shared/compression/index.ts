/**
 * Shared Image Compression Service
 * Used by api-v1-images
 *
 * Implements TinyPNG/Cloudinary race with circuit breaker
 */

export interface CompressResult {
  buffer: Uint8Array;
  method: string;
  service: string;
  originalSize: number;
  compressedSize: number;
  savedPercent: number;
}

interface CircuitState {
  failures: number;
  lastFailure: number;
  isOpen: boolean;
}

const circuits = new Map<string, CircuitState>();
const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_TIMEOUT = 60000;

function checkCircuit(service: string): boolean {
  const circuit = circuits.get(service);
  if (!circuit || !circuit.isOpen) return true;

  if (Date.now() - circuit.lastFailure > CIRCUIT_TIMEOUT) {
    circuits.set(service, { failures: 0, lastFailure: 0, isOpen: false });
    return true;
  }

  return false;
}

function recordFailure(service: string) {
  const circuit = circuits.get(service) || { failures: 0, lastFailure: 0, isOpen: false };
  circuit.failures++;
  circuit.lastFailure = Date.now();

  if (circuit.failures >= CIRCUIT_THRESHOLD) {
    circuit.isOpen = true;
  }

  circuits.set(service, circuit);
}

function recordSuccess(service: string) {
  circuits.set(service, { failures: 0, lastFailure: 0, isOpen: false });
}

async function compressWithTinyPNG(
  imageData: Uint8Array,
  targetWidth: number = 800,
): Promise<CompressResult> {
  const apiKey = Deno.env.get("TINYPNG_API_KEY");
  if (!apiKey) throw new Error("TINYPNG_API_KEY not set");

  const authHeader = "Basic " + btoa(`api:${apiKey}`);

  const compressResponse = await fetch("https://api.tinify.com/shrink", {
    method: "POST",
    headers: { Authorization: authHeader },
    body: imageData,
  });

  if (!compressResponse.ok) {
    throw new Error(`TinyPNG failed: ${compressResponse.status}`);
  }

  const result = await compressResponse.json();
  const compressedUrl = result.output.url;

  const resizeResponse = await fetch(compressedUrl, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      resize: { method: "fit", width: targetWidth },
    }),
  });

  if (!resizeResponse.ok) {
    throw new Error(`TinyPNG resize failed: ${resizeResponse.status}`);
  }

  const buffer = new Uint8Array(await resizeResponse.arrayBuffer());

  return {
    buffer,
    method: "tinypng",
    service: "tinypng",
    originalSize: imageData.length,
    compressedSize: buffer.length,
    savedPercent: Math.round(((imageData.length - buffer.length) / imageData.length) * 100),
  };
}

async function compressWithCloudinary(
  imageData: Uint8Array,
  targetWidth: number = 800,
): Promise<CompressResult> {
  const cloudName = Deno.env.get("CLOUDINARY_CLOUD_NAME");
  const apiKey = Deno.env.get("CLOUDINARY_API_KEY");
  const apiSecret = Deno.env.get("CLOUDINARY_API_SECRET");

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error("Cloudinary credentials not set");
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = `temp_${crypto.randomUUID()}`;

  const formData = new FormData();
  formData.append("file", new Blob([imageData]));
  formData.append("upload_preset", "ml_default");
  formData.append("public_id", publicId);
  formData.append("timestamp", timestamp.toString());
  formData.append("api_key", apiKey);

  const uploadUrl = `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`;
  const uploadResponse = await fetch(uploadUrl, {
    method: "POST",
    body: formData,
  });

  if (!uploadResponse.ok) {
    throw new Error(`Cloudinary upload failed: ${uploadResponse.status}`);
  }

  const uploadResult = await uploadResponse.json();
  const transformedUrl = uploadResult.secure_url.replace(
    "/upload/",
    `/upload/w_${targetWidth},c_fit,q_auto,f_auto/`,
  );

  const imageResponse = await fetch(transformedUrl);
  if (!imageResponse.ok) {
    throw new Error(`Cloudinary transform failed: ${imageResponse.status}`);
  }

  const buffer = new Uint8Array(await imageResponse.arrayBuffer());

  return {
    buffer,
    method: "cloudinary",
    service: "cloudinary",
    originalSize: imageData.length,
    compressedSize: buffer.length,
    savedPercent: Math.round(((imageData.length - buffer.length) / imageData.length) * 100),
  };
}

export async function compressImage(
  imageData: Uint8Array,
  targetWidth: number = 800,
): Promise<CompressResult> {
  const originalSize = imageData.length;

  // Skip if already small
  if (originalSize < 100 * 1024) {
    return {
      buffer: imageData,
      method: "none",
      service: "none",
      originalSize,
      compressedSize: originalSize,
      savedPercent: 0,
    };
  }

  const tinyPNGAvailable = checkCircuit("tinypng");
  const cloudinaryAvailable = checkCircuit("cloudinary");

  if (!tinyPNGAvailable && !cloudinaryAvailable) {
    throw new Error("All compression services unavailable");
  }

  // Race both services
  const promises: Promise<CompressResult>[] = [];

  if (tinyPNGAvailable) {
    promises.push(
      compressWithTinyPNG(imageData, targetWidth)
        .then((result) => {
          recordSuccess("tinypng");
          return result;
        })
        .catch((error) => {
          recordFailure("tinypng");
          throw error;
        }),
    );
  }

  if (cloudinaryAvailable) {
    promises.push(
      compressWithCloudinary(imageData, targetWidth)
        .then((result) => {
          recordSuccess("cloudinary");
          return result;
        })
        .catch((error) => {
          recordFailure("cloudinary");
          throw error;
        }),
    );
  }

  return await Promise.race(promises);
}

export async function generateThumbnail(
  imageData: Uint8Array,
  maxWidth: number = 300,
): Promise<Uint8Array> {
  const result = await compressImage(imageData, maxWidth);
  return result.buffer;
}
