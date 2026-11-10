import { createHash, generateKeyPairSync } from "node:crypto";
import { expect, vi } from "vitest";
import { createPublicArtifactInventoryReceipt } from "../site/src/lib/public-artifact-inventory";
import { RECORD_CODE_WORKER_BYTES } from "./record-code-source";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const env = { CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ type: "service_account", project_id: "njpbs-site",
  client_email: "fixture@njpbs-site.iam.gserviceaccount.com", private_key: privateKey.export({ format: "pem", type: "pkcs8" }) }),
  R2_PREVIEW_CREDENTIAL: JSON.stringify({ accessKeyId: "fixture".repeat(4), secretAccessKey: "fixture".repeat(8) }) };
const field = (v: any): any => v === null ? { nullValue: null } : typeof v === "string" ? { stringValue: v } :
  typeof v === "number" ? { integerValue: String(v) } : typeof v === "boolean" ? { booleanValue: v } :
  Array.isArray(v) ? { arrayValue: { values: v.map(field) } } : { mapValue: { fields: encode(v) } };
const encode = (v: any) => Object.fromEntries(Object.entries(v).map(([k, v]) => [k, field(v)]));

export async function currentCodeFixture(options: { race?: string; badBytes?: boolean; large?: boolean } = {}) {
  const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
  const time = { seconds: 1_780_000_000, nanoseconds: 0, toMillis: () => 1_780_000_000_000 };
  const reservation = { schemaVersion: 1 as const, buildBatchId: "cms-" + "C".repeat(20), generation: 3,
    status: "reserved" as const, commitSha: "a".repeat(40), reservedAgainstGeneration: 2,
    reservedAgainstDeploymentId: "previous", reservedAgainstCommitSha: "b".repeat(40), cutoffAt: time, reservedAt: time };
  const input = { schemaVersion: 3, pages: [], posts: [], programs: [], authors: [], settings: [], receipt:
    createPublicArtifactInventoryReceipt({ reservation, pages: [], posts: [], programs: [], authors: [], settings: [] }) };
  const bytes = Buffer.from(JSON.stringify(input));
  const publication = { schemaVersion: 1, digestAlgorithm: "sha256", buildBatchId: reservation.buildBatchId,
    generation: 3, commitSha: reservation.commitSha, artifactDigest: "d".repeat(64),
    artifactReceiptDigest: hash(JSON.stringify(input.receipt)), mediaManifestDigest: input.receipt.mediaManifestDigest };
  const manifest = { schemaVersion: 1, buildBatchId: publication.buildBatchId, artifactReceiptDigest: publication.artifactReceiptDigest,
    byteLength: bytes.length, sha256: hash(bytes), key: `public-context/${publication.buildBatchId}/${hash(bytes)}.json` };
  const code = { input, reference: { publication, manifest } };
  const pointer: any = { schemaVersion: 1, state: "idle", activeCommitSha: publication.commitSha,
    activeGeneration: publication.generation };
  if (options.large) manifest.byteLength = RECORD_CODE_WORKER_BYTES + 1;
  const seen = new Map<string, number>();
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input)), key = url.pathname;
    const n = (seen.get(key) ?? 0) + 1; seen.set(key, n);
    if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "synthetic-token", token_type: "Bearer" });
    if (key === "/_publication.json") return new Response(JSON.stringify({ ...publication,
      ...(options.race === "publication" && n > 1 ? { artifactDigest: "f".repeat(64) } : {}) }), {
      headers: { "content-type": "application/json", "x-njpbs-publication-origin": "njpbs-production" } });
    if (url.hostname.endsWith("r2.cloudflarestorage.com")) {
      expect(key).toBe(`/njpbs-cms-previews/${manifest.key}`);
      expect(init?.method).toBe("GET"); expect(new Headers(init?.headers).has("authorization")).toBe(true);
      const body = options.badBytes ? Buffer.alloc(manifest.byteLength) : bytes;
      return new Response(body, { headers: { "content-length": String(manifest.byteLength) } });
    }
    const path = key.split("/documents/")[1];
    const data = path === "system/publicDeployment" ? pointer : path === `cmsPreviewPublicContexts/${publication.buildBatchId}` ? manifest : undefined;
    if (data === undefined) throw new Error("Unexpected path in the read-only fixture");
    expect(init?.method ?? "GET").toBe("GET");
    if (data === null) return new Response(null, { status: 404 });
    const changed = options.race === "pointer" && path === "system/publicDeployment" && n > 1;
    return Response.json({ name: `projects/njpbs-site/databases/(default)/documents/${path}`, fields: encode({ ...data,
      ...(changed ? { activeGeneration: pointer.activeGeneration + 1 } : {}) }),
      updateTime: options.race === "manifest" && path.startsWith("cmsPreviewPublicContexts/") && n > 1 ? "second" : "first" });
  });
  return { code, request, rendererSha: publication.commitSha };
}
