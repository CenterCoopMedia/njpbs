import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { R2MediaStorage, isConditionalConflict } = require("../functions/lib/r2-media");
const { parseConnectorManifest, manifestKey, packageKey } = require("../functions/lib/studio-connector-package");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

class PackageUploadError extends Error {}
export function describeUploadFailure(error) {
  if (error instanceof PackageUploadError) return error.message;
  if (error?.code === "ENOENT") return "A required package file was not found.";
  if (error?.code === "EACCES") return "Package files could not be read.";
  const status = error?.$metadata?.httpStatusCode;
  if (Number.isInteger(status) && status >= 400 && status <= 599) return `Storage request failed (HTTP ${status}).`;
  return "Storage could not be reached or configured. Check its configuration and try again.";
}

export async function uploadConnectorPackage({ path, sourceSha, storage }) {
  const manifestBytes = await readFile(path);
  let manifest;
  try { manifest = parseConnectorManifest(JSON.parse(manifestBytes.toString("utf8")), sourceSha); }
  catch { throw new PackageUploadError("Connector manifest is invalid or its source differs."); }
  const zip = await readFile(join(dirname(path), manifest.filename));
  if (zip.length !== manifest.sizeBytes || digest(zip) !== manifest.sha256) throw new PackageUploadError("Connector package bytes differ from the manifest");
  async function put(key, bytes, contentType) {
    const sha256 = digest(bytes);
    try {
      await storage.client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: key, Body: bytes,
        ContentLength: bytes.length, ContentType: contentType, CacheControl: "private, no-store",
        Metadata: { source: sourceSha, sha256 }, IfNoneMatch: "*" }));
    } catch (error) { if (!isConditionalConflict(error)) throw error; }
    const head = await storage.head(key);
    if (head.contentLength !== bytes.length || head.metadata.source !== sourceSha || head.metadata.sha256 !== sha256) {
      throw new PackageUploadError("Stored connector package does not match the exact release");
    }
  }
  await put(packageKey(sourceSha, manifest.sha256), zip, "application/zip");
  // Publish the immutable manifest only after the ZIP has passed readback checks.
  await put(manifestKey(sourceSha), manifestBytes, "application/json");
  return manifest;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  let storage;
  try {
    if (!process.env.CMS_MEDIA_MASTER_R2_BUCKET) {
      console.log("Studio connector download is unavailable: Private master-media storage is not configured.");
    } else {
      storage = new R2MediaStorage({ endpoint: (process.env.CMS_MEDIA_R2_ENDPOINT ?? `https://${process.env.CLOUDFLARE_ACCOUNT_ID ?? ""}.r2.cloudflarestorage.com`), bucket: process.env.CMS_MEDIA_MASTER_R2_BUCKET,
        accessKeyId: process.env.CMS_MEDIA_R2_ACCESS_KEY_ID, secretAccessKey: process.env.CMS_MEDIA_R2_SECRET_ACCESS_KEY });
      const manifest = await uploadConnectorPackage({ path: process.argv[2], sourceSha: process.env.DEPLOY_SHA, storage });
      console.log(`Studio connector stored for ${manifest.sourceSha}; SHA-256 ${manifest.sha256}.`);
    }
  } catch (error) {
    // Print fixed local checks or a numeric HTTP status, never SDK request details.
    console.error(`Studio connector upload failed: ${describeUploadFailure(error)}`);
    process.exitCode = 1;
  } finally { storage?.client.destroy(); }
}
