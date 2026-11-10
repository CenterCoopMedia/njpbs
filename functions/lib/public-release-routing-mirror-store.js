"use strict";
const { publicationTarget } = require("./publication-target");
const { RoutingMirrorError } = require("./public-release-routing-mirror-codec");
/** Node-only private R2 adapter. Never import this adapter into shared Worker
 * producer code. Credentials resolve inside the signing client at use time. */
function createPublicReleaseRoutingMirrorStore({ environment, accountId, credential, client }) {
  const target = publicationTarget(environment);
  if (!/^[a-f0-9]{32}$/.test(accountId ?? "") || !client && typeof credential !== "function") throw new RoutingMirrorError();
  const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
  const storage = client ?? new S3Client({ endpoint: `https://${accountId}.r2.cloudflarestorage.com`, region: "auto", maxAttempts: 1,
    credentials: async () => ({ ...await credential(), expiration: new Date(Date.now() + 30_000) }) });
  const allowed = (key, writing = false) => {
    if (typeof key !== "string" || !/^[A-Za-z0-9._:/-]+$/.test(key) || key.includes("..") ||
        !(key.startsWith(`public-release-routing/${environment}/`) || !writing &&
          (key.startsWith("release-pairs/") || key.startsWith("release-pair-inputs/v2/")))) throw new RoutingMirrorError();
  };
  return {
    async get(key) {
      allowed(key);
      let object;
      try { object = await storage.send(new GetObjectCommand({ Bucket: target.publicationBucket, Key: key }), { abortSignal: AbortSignal.timeout(30_000) }); }
      catch (error) { if (error?.$metadata?.httpStatusCode === 404) return null; throw new RoutingMirrorError(); }
      if (!object.Body || !Number.isSafeInteger(object.ContentLength) || object.ContentLength < 0 || object.ContentLength > 16 * 1024 * 1024 || !object.ETag) throw new RoutingMirrorError();
      return { size: object.ContentLength, body: object.Body.transformToWebStream(), customMetadata: object.Metadata ?? {}, etag: object.ETag };
    },
    async put(key, bytes, options) {
      allowed(key, true);
      // A real R2 write must not use authority from a throwaway emulator.
      if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new RoutingMirrorError();
      if (!(bytes instanceof Uint8Array) || bytes.length > 16 * 1024 * 1024 || !options?.onlyIf ||
          Object.keys(options.onlyIf).length !== 1 || !(options.onlyIf.etagDoesNotMatch === "*" ||
          typeof options.onlyIf.etagMatches === "string" && /^[^\r\n]{1,256}$/.test(options.onlyIf.etagMatches))) throw new RoutingMirrorError();
      try {
        const object = await storage.send(new PutObjectCommand({ Bucket: target.publicationBucket, Key: key, Body: bytes,
          ContentLength: bytes.length, ContentType: "application/json", CacheControl: "private, no-store", Metadata: options.customMetadata,
          ...(options.onlyIf.etagDoesNotMatch ? { IfNoneMatch: "*" } : { IfMatch: options.onlyIf.etagMatches }) }), { abortSignal: AbortSignal.timeout(30_000) });
        if (!object.ETag) throw new RoutingMirrorError(); return { etag: object.ETag };
      } catch (error) { if ([409, 412].includes(error?.$metadata?.httpStatusCode)) return null; throw new RoutingMirrorError(); }
    },
    close() { if (!client) storage.destroy(); },
  };
}
module.exports = { createPublicReleaseRoutingMirrorStore };
