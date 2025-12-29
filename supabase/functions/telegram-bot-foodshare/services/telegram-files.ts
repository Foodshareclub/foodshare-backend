/**
 * Telegram file download and upload to Supabase Storage
 */

import { getSupabaseClient } from "./supabase.ts";

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");

/**
 * Download a file from Telegram and upload to Supabase Storage with retry logic
 */
export async function downloadAndUploadTelegramFile(
  fileId: string,
  userId: number,
  maxRetries = 3
): Promise<string | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`📥 Downloading Telegram file (attempt ${attempt}/${maxRetries}):`, fileId);

      // Step 1: Get file path from Telegram with timeout
      const fileInfoController = new AbortController();
      const fileInfoTimeout = setTimeout(() => fileInfoController.abort(), 5000);

      const fileInfoResponse = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`,
        { signal: fileInfoController.signal }
      );
      clearTimeout(fileInfoTimeout);

      if (!fileInfoResponse.ok) {
        console.error("Failed to get file info from Telegram:", fileInfoResponse.status);
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
          continue;
        }
        return null;
      }

      const fileInfo = await fileInfoResponse.json();

      if (!fileInfo.ok || !fileInfo.result?.file_path) {
        console.error("Invalid file info response:", fileInfo);
        return null;
      }

      const filePath = fileInfo.result.file_path;
      const fileSize = fileInfo.result.file_size || 0;
      console.log("📄 File path:", filePath, "Size:", fileSize, "bytes");

      // Validate file size (max 20MB)
      if (fileSize > 20 * 1024 * 1024) {
        console.error("❌ File too large:", fileSize, "bytes");
        return null;
      }

      // Step 2: Download the file from Telegram with timeout
      const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;
      const fileController = new AbortController();
      const fileTimeout = setTimeout(() => fileController.abort(), 30000);

      const fileResponse = await fetch(fileUrl, { signal: fileController.signal });
      clearTimeout(fileTimeout);

      if (!fileResponse.ok) {
        console.error("Failed to download file from Telegram:", fileResponse.status);
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
          continue;
        }
        return null;
      }

      const fileBlob = await fileResponse.blob();
      const fileBuffer = await fileBlob.arrayBuffer();
      console.log("📦 Downloaded file size:", fileBuffer.byteLength, "bytes");

      // Validate downloaded size matches
      if (fileSize > 0 && fileBuffer.byteLength !== fileSize) {
        console.warn("⚠️ Downloaded size mismatch:", fileBuffer.byteLength, "vs", fileSize);
      }

      // Step 3: Generate unique filename
      const fileExtension = filePath.split(".").pop()?.toLowerCase() || "jpg";
      const timestamp = Date.now();
      const randomString = crypto.randomUUID().split("-")[0];
      const fileName = `${userId}_${timestamp}_${randomString}.${fileExtension}`;
      const storagePath = `food-photos/${fileName}`;

      console.log("📤 Uploading to Supabase Storage:", storagePath);

      // Step 4: Upload to Supabase Storage with retry
      const supabase = getSupabaseClient();
      let uploadError = null;

      for (let uploadAttempt = 1; uploadAttempt <= 2; uploadAttempt++) {
        const { data, error } = await supabase.storage
          .from("posts")
          .upload(storagePath, fileBuffer, {
            contentType: fileBlob.type || "image/jpeg",
            upsert: false,
            cacheControl: "3600",
          });

        if (!error) {
          // Step 5: Get public URL
          const { data: urlData } = supabase.storage.from("posts").getPublicUrl(storagePath);

          console.log("✅ File uploaded successfully:", urlData.publicUrl);
          return urlData.publicUrl;
        }

        uploadError = error;
        console.error(`❌ Supabase Storage upload error (attempt ${uploadAttempt}/2):`, error);

        if (uploadAttempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      // If we got here, upload failed after retries
      if (attempt < maxRetries) {
        console.log(`🔄 Retrying entire process (attempt ${attempt + 1}/${maxRetries})...`);
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
        continue;
      }

      console.error("❌ All upload attempts failed:", uploadError);
      return null;
    } catch (error) {
      console.error(
        `❌ Error downloading/uploading file (attempt ${attempt}/${maxRetries}):`,
        error
      );

      if (error instanceof Error && error.name === "AbortError") {
        console.error("❌ Request timeout");
      }

      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
        continue;
      }

      return null;
    }
  }

  return null;
}

/**
 * Download multiple Telegram files and upload to Supabase Storage
 */
export async function downloadAndUploadMultipleFiles(
  fileIds: string[],
  userId: number
): Promise<string[]> {
  const uploadedUrls: string[] = [];

  for (const fileId of fileIds) {
    const url = await downloadAndUploadTelegramFile(fileId, userId);
    if (url) {
      uploadedUrls.push(url);
    }
  }

  return uploadedUrls;
}
