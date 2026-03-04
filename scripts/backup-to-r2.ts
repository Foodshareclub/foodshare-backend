import { S3Client, PutObjectCommand } from "https://esm.sh/@aws-sdk/client-s3";

const bucketName = Deno.env.get("R2_BUCKET_NAME") || Deno.env.get("S3_BUCKET_NAME");
const accountId = Deno.env.get("R2_ACCOUNT_ID");
const accessKeyId = Deno.env.get("R2_ACCESS_KEY_ID") || Deno.env.get("S3_ACCESS_KEY_ID");
const secretAccessKey = Deno.env.get("R2_SECRET_ACCESS_KEY") || Deno.env.get("S3_SECRET_ACCESS_KEY");
const endpoint = Deno.env.get("S3_ENDPOINT") || `https://${accountId}.r2.cloudflarestorage.com`;

if (!bucketName || !accessKeyId || !secretAccessKey) {
  console.error("❌ Missing required S3/R2 environment variables.");
  Deno.exit(1);
}

const filePath = Deno.args[0];
if (!filePath) {
  console.error("❌ Usage: deno run scripts/backup-to-r2.ts <file-path>");
  Deno.exit(1);
}

try {
  const file = await Deno.readFile(filePath);
  const fileName = filePath.split("/").pop();
  const destPath = `backups/${new Date().toISOString().split("T")[0]}/${fileName}`;

  const client = new S3Client({
    region: "auto",
    endpoint: endpoint,
    credentials: {
      accessKeyId: accessKeyId,
      secretAccessKey: secretAccessKey,
    },
  });

  console.log(`🚀 Uploading ${fileName} to R2 bucket ${bucketName}...`);
  
  await client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: destPath,
      Body: file,
    })
  );

  console.log(`✅ Backup successfully uploaded to R2: ${destPath}`);
} catch (error) {
  console.error("❌ Error uploading backup to R2:", error);
  Deno.exit(1);
}
