import { cloudflareR2Endpoint } from "./cloudflare-account.mjs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { assertPublicationTarget, type PublicationTarget } from "../../functions/lib/publication-target";
import { BASELINE_FILE_BYTES, ContentBaselineError } from "../../packages/content-core/src/public-content-baseline";
import type { PreviewStorageCredential } from "./cms-preview-storage-credential";
import type { BaselineUpload } from "./public-content-baseline-artifact";

const require = createRequire(import.meta.url);
const { r2ClientConfig, isConditionalConflict, normalizeMetadata } = require("../../functions/lib/r2-media");

export function createContentBaselineStorage({ target, credential, client }: {
  target: PublicationTarget; credential?: PreviewStorageCredential; client?: S3Client;
}): BaselineUpload & { close(): void } {
  target = assertPublicationTarget(target);
  if (!client && !credential) throw new ContentBaselineError("Baseline storage credentials are required");
  const storage = client ?? new S3Client({ ...r2ClientConfig({
    endpoint: cloudflareR2Endpoint(),
    accessKeyId: credential?.accessKeyId, secretAccessKey: credential?.secretAccessKey }), maxAttempts: 3 });
  const prefix = `public-content-baseline/v1/${target.workerName}/`;
  return {
    async writeAndVerify(key, bytes) {
      const suffix = key.startsWith(prefix) ? key.slice(prefix.length) : "";
      if (!/^(?:objects\/[a-f0-9]{64}|[a-f0-9]{40}\/[1-9]\d*\/[a-f0-9]{64}\/[a-f0-9]{64}\/manifest\.json)$/.test(suffix) ||
          bytes.length > BASELINE_FILE_BYTES) throw new ContentBaselineError("The baseline storage key or size is invalid");
      const digest = createHash("sha256").update(bytes).digest("hex");
      const checksum = Buffer.from(digest, "hex").toString("base64");
      if (suffix.startsWith("objects/") && suffix !== `objects/${digest}`) throw new ContentBaselineError("The baseline object key differs from its bytes");
      const options = () => ({ abortSignal: AbortSignal.timeout(60_000) });
      try {
        await storage.send(new PutObjectCommand({ Bucket: target.publicationBucket, Key: key, Body: bytes,
          ContentLength: bytes.length, ContentType: "application/octet-stream", CacheControl: "private, no-store",
          ChecksumSHA256: checksum, Metadata: { schema: "njpbs-public-baseline-v1", sha256: digest }, IfNoneMatch: "*" }), options());
      } catch (error) {
        if (!isConditionalConflict(error)) throw error;
      }
      const object = await storage.send(new GetObjectCommand({ Bucket: target.publicationBucket, Key: key, ChecksumMode: "ENABLED" }), options());
      const stream = object.Body?.transformToWebStream();
      if (!stream) throw new ContentBaselineError("The retained baseline object is unavailable");
      try {
        const metadata = normalizeMetadata(object.Metadata);
        if (object.ContentLength !== bytes.length || object.ChecksumSHA256 !== checksum ||
            metadata.schema !== "njpbs-public-baseline-v1" || metadata.sha256 !== digest) {
          throw new ContentBaselineError("The baseline storage receipt differs");
        }
        const hash = createHash("sha256");
        let size = 0;
        for await (const chunk of stream) {
          size += chunk.byteLength;
          if (size > bytes.length) throw new ContentBaselineError("The retained baseline exceeds its declared size");
          hash.update(chunk);
        }
        if (size !== bytes.length || hash.digest("hex") !== digest) throw new ContentBaselineError("The retained baseline bytes differ");
      } finally { void stream.cancel().catch(() => {}); }
    },
    close() { if (!client) storage.destroy(); },
  };
}
