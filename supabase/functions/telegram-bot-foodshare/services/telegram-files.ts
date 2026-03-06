/**
 * Telegram file download and upload to Supabase Storage
 */

import { logger } from "../../_shared/logger.ts";

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");

/**
 * Download a file from Telegram and upload to Supabase Storage with retry logic
 */
export async function downloadAndUploadTelegramFile(
  fileId: string,
  userId: number,
  maxRetries = 3,
): Promise<string | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.info("Downloading Telegram file", { attempt, maxRetries, fileId });

      // Step 1: Get file path from Telegram with timeout
      const fileInfoController = new AbortController();
      const fileInfoTimeout = setTimeout(() => fileInfoController.abort(), 5000);

      const fileInfoResponse = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`,
        { signal: fileInfoController.signal },
      );
      clearTimeout(fileInfoTimeout);

      if (!fileInfoResponse.ok) {
        logger.error("Failed to get file info from Telegram", { status: fileInfoResponse.status });
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
          continue;
        }
        return null;
      }

      const fileInfo = await fileInfoResponse.json();

      if (!fileInfo.ok || !fileInfo.result?.file_path) {
        logger.error("Invalid file info response", { fileInfo });
        return null;
      }

      const filePath = fileInfo.result.file_path;
      const fileSize = fileInfo.result.file_size || 0;
      logger.info("File info retrieved", { filePath, fileSize });

      // Validate file size (max 20MB)
      if (fileSize > 20 * 1024 * 1024) {
        logger.error("File too large", { fileSize });
        return null;
      }

      // Step 2: Download the file from Telegram with timeout
      const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;
      const fileController = new AbortController();
      const fileTimeout = setTimeout(() => fileController.abort(), 30000);

      const fileResponse = await fetch(fileUrl, { signal: fileController.signal });
      clearTimeout(fileTimeout);

      if (!fileResponse.ok) {
        logger.error("Failed to download file from Telegram", { status: fileResponse.status });
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
          continue;
        }
        return null;
      }

      const fileBlob = await fileResponse.blob();
      const fileBuffer = await fileBlob.arrayBuffer();
      logger.info("Downloaded file", { byteLength: fileBuffer.byteLength });

      // Validate downloaded size matches
      if (fileSize > 0 && fileBuffer.byteLength !== fileSize) {
        logger.warn("Downloaded size mismatch", {
          downloadedSize: fileBuffer.byteLength,
          expectedSize: fileSize,
        });
      }

      // Step 3: Upload via api-v1-images for compression
      const fileExtension = filePath.split(".").pop()?.toLowerCase() || "jpg";
      const timestamp = Date.now();
      const randomString = crypto.randomUUID().split("-")[0];
      const fileName = `${userId}_${timestamp}_${randomString}.${fileExtension}`;
      const storagePath = `food-photos/${fileName}`;

      logger.info("Uploading via api-v1-images", { storagePath });

      // Upload via image API for compression
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

      const formData = new FormData();
      formData.append("file", new Blob([fileBuffer], { type: fileBlob.type || "image/jpeg" }));
      formData.append("bucket", "posts");
      formData.append("path", storagePath);
      formData.append("generateThumbnail", "false");
      formData.append("extractEXIF", "false");
      formData.append("enableAI", "false");

      let uploadError = null;
      for (let uploadAttempt = 1; uploadAttempt <= 2; uploadAttempt++) {
        try {
          const uploadResponse = await fetch(
            `${supabaseUrl}/functions/v1/api-v1-images/upload`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${serviceKey}`,
              },
              body: formData,
            },
          );

          if (uploadResponse.ok) {
            const result = await uploadResponse.json();
            logger.info("File uploaded successfully", { url: result.data.url });
            return result.data.url;
          }

          uploadError = await uploadResponse.text();
          logger.error("Image API upload error", {
            uploadAttempt,
            maxAttempts: 2,
            error: String(uploadError),
          });
        } catch (error) {
          uploadError = error;
          logger.error("Upload exception", { uploadAttempt, maxAttempts: 2, error: String(error) });
        }

        if (uploadAttempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      // If we got here, upload failed after retries
      if (attempt < maxRetries) {
        logger.info("Retrying entire download/upload process", {
          nextAttempt: attempt + 1,
          maxRetries,
        });
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
        continue;
      }

      logger.error("All upload attempts failed", { error: String(uploadError) });
      return null;
    } catch (error) {
      logger.error("Error downloading/uploading file", {
        attempt,
        maxRetries,
        error: String(error),
      });

      if (error instanceof Error && error.name === "AbortError") {
        logger.error("Request timeout");
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
  userId: number,
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
