import { createHash } from "node:crypto";
import { createPublicArtifactInventoryReceipt } from "../../site/src/lib/public-artifact-inventory";
import { afterAll } from "vitest";
const priorFunctionsEmulator = process.env.FUNCTIONS_EMULATOR;
afterAll(() => { if (priorFunctionsEmulator === undefined) delete process.env.FUNCTIONS_EMULATOR; else process.env.FUNCTIONS_EMULATOR = priorFunctionsEmulator; });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
/** Explicit emulator transport using the actual CODE reference/wire grammar.
 * SDK methods stay bound to the emulator; only its target label is projected. */
export function publicReleaseBaselineCodeFixture(db: any, rendererSha: string) {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) throw new Error("Use a local emulator");
  process.env.FUNCTIONS_EMULATOR = "true";
  const cutoffAt = { seconds: 1_760_000_000, nanoseconds: 0, toMillis: () => 1_760_000_000_000 };
  const buildBatchId = `cms-${"B".repeat(20)}`;
  const publicContext = { schemaVersion: 3, pages: [], posts: [], programs: [], authors: [], settings: [], receipt:
    createPublicArtifactInventoryReceipt({ reservation: { schemaVersion: 1, buildBatchId, generation: 1, status: "reserved", commitSha: rendererSha,
      reservedAgainstGeneration: 0, reservedAgainstDeploymentId: null, reservedAgainstCommitSha: null, cutoffAt, reservedAt: cutoffAt },
      pages: [], posts: [], programs: [], authors: [], settings: [] }) };
  const bytes = JSON.stringify(publicContext);
  const publication = { schemaVersion: 1, digestAlgorithm: "sha256", buildBatchId, generation: 1, commitSha: rendererSha,
    artifactDigest: "d".repeat(64), artifactReceiptDigest: hash(JSON.stringify(publicContext.receipt)), mediaManifestDigest: publicContext.receipt.mediaManifestDigest };
  const reference = { publication, manifest: { schemaVersion: 1, buildBatchId, artifactReceiptDigest: publication.artifactReceiptDigest,
    byteLength: Buffer.byteLength(bytes), sha256: hash(bytes), key: `public-context/${buildBatchId}/${hash(bytes)}.json` } };
  const firestore = new Proxy(db, { get(target, key) { if (key === "projectId") return process.env.CMS_DEPLOYMENT_ENVIRONMENT === "development" ? "njpbs-site-dev" : "njpbs-site";
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; } });
  const request = async (_url: unknown, options: RequestInit = {}) => {
    const query = JSON.parse(String(options.body));
    if (query.rendererSha !== rendererSha || query.mode !== "current-code") throw new Error("Wrong fixture CODE request");
    return new Response(JSON.stringify({ schemaVersion: 1, kind: "current-code", reference, bytes: Buffer.from(bytes).toString("base64") }), { headers: { "content-type": "application/json" } });
  };
  return { firestore, request, qualified: { reference, publication, publicContext } };
}
