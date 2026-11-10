import { createHash } from "node:crypto";
import { createPublicArtifactInventoryReceipt } from "../../site/src/lib/public-artifact-inventory";
import { buildScheduleExport } from "../../site/src/lib/schedule-export";
import { readPageSchedulePacket } from "../../site/src/lib/page-schedule-packet";
import { encodePublicReleasePairCodePackChunk } from "../../site/scripts/public-release-pair-code-pack";
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** Real packet/CODE grammars and original adapter, entirely in frozen bytes. */
export async function frozenReplayScheduleFixture(rendererSha: string, legacyReceipt = false) {
  const checkedAt = Date.parse("2026-10-12T10:00:00.000Z"), cutoffAt = { seconds: checkedAt / 1000, nanoseconds: 0, toMillis: () => checkedAt };
  const reservation = { schemaVersion: 1 as const, buildBatchId: `cms-${"C".repeat(20)}`, generation: 5, status: "reserved" as const,
    commitSha: rendererSha, reservedAgainstGeneration: 4, reservedAgainstDeploymentId: "previous", reservedAgainstCommitSha: "e".repeat(40), cutoffAt, reservedAt: cutoffAt };
  const publicContext = { schemaVersion: 3, pages: [], posts: [], programs: [], authors: [], settings: [],
    receipt: createPublicArtifactInventoryReceipt({ reservation, pages: [], posts: [], programs: [], authors: [], settings: [] }) };
  const originalContext = legacyReceipt ? { ...publicContext, receipt: { ...publicContext.receipt, aggregateRoutes: ["/posts/", "/staff/"] } } : publicContext;
  const publication = { schemaVersion: 1 as const, digestAlgorithm: "sha256" as const, buildBatchId: reservation.buildBatchId, generation: 5,
    commitSha: rendererSha, artifactDigest: "d".repeat(64), artifactReceiptDigest: hash(JSON.stringify(originalContext.receipt)), mediaManifestDigest: publicContext.receipt.mediaManifestDigest };
  const contextBytes = encode(originalContext);
  const reference = { publication, manifest: { schemaVersion: 1 as const, buildBatchId: publication.buildBatchId,
    artifactReceiptDigest: publication.artifactReceiptDigest, byteLength: contextBytes.length, sha256: hash(contextBytes),
    key: `public-context/${publication.buildBatchId}/${hash(contextBytes)}.json` } };
  const qualifiedCode = { reference, publication, publicContext };
  const schedule: any = { source: "pbs-tvss", generatedAt: "2026-10-12T09:00:00.000Z", timeZone: "America/New_York",
    request: { station: "WNJT", dates: ["2026-10-12"] }, days: Object.fromEntries(["broadcast", "kids"].map(kind => [kind, [{
      date: "2026-10-12", kind, callsign: "wnjt", timeZone: "America/New_York", entries: [{ title: "Frozen program", startsAt: "2026-10-12T12:00:00Z", endsAt: "2026-10-12T13:00:00Z" }],
    }]])) };
  const json = encode(schedule), pdf = Buffer.from("%PDF-1.7\nfrozen packet\n"), operationId = "S".repeat(20);
  const inputs: any = { schemaVersion: 1, operationId, runtime: { owner: "cloudflare", release: "e".repeat(40) },
    contentDigest: "c".repeat(64), checkedAt, files: {} };
  for (const name of ["launch-media-manager.json", "spotlight-news.json", "schedule.json"]) inputs.files[name] = {
    key: `post-background-v1/external-inputs/${operationId}/${name}`, digest: hash(name === "schedule.json" ? json : "{}"), size: name === "schedule.json" ? json.length : 2 };
  const source = { operationId, runtime: inputs.runtime, contentDigest: inputs.contentDigest, scheduleDigest: hash(json), checkedAt };
  const identity = hash(JSON.stringify([operationId, source.runtime.owner, source.runtime.release, source.contentDigest, source.scheduleDigest, checkedAt]));
  const exported = buildScheduleExport(schedule, new Date(checkedAt));
  inputs.schedulePacket = { schemaVersion: 1, source, generatedAt: schedule.generatedAt, exportedAt: exported.exportedAt,
    startDate: exported.startDate, endDate: exported.endDate, timeZone: schedule.timeZone, files: {} };
  const files = new Map<string, Uint8Array>(), objects = new Map<string, Uint8Array>(), roster = [];
  for (const [kind, bytes, name, contentType] of [["json", json, "schedule.json", "application/json"], ["pdf", pdf, "nj-pbs-schedule.pdf", "application/pdf"]] as const) {
    const receipt = { key: `post-background-v1/schedule-packets/${operationId}/${identity}/${hash(bytes)}/${name}`, digest: hash(bytes), size: bytes.length, contentType };
    inputs.schedulePacket.files[kind] = receipt; objects.set(receipt.key, bytes);
    const chunkFiles = [`provider-inputs/objects/${receipt.digest}/0000.json`];
    files.set(chunkFiles[0], encodePublicReleasePairCodePackChunk(bytes));
    roster.push({ name: `schedule-packet/${kind}`, key: receipt.key, digest: receipt.digest, bytes: bytes.length, contentType, chunkFiles });
  }
  const codeBytes = encode(qualifiedCode), codeChunks = ["code-source/objects/0000.json"];
  files.set(codeChunks[0], encodePublicReleasePairCodePackChunk(codeBytes));
  files.set("code-source.json", encode({ schemaVersion: 1, reference, sha256: hash(codeBytes), bytes: codeBytes.length, chunkFiles: codeChunks }));
  files.set("provider-inputs.json", encode({ schemaVersion: 1, externalInputs: inputs, retainedHome: null, files: roster }));
  const original = await readPageSchedulePacket({ authority: { contextRevision: 4, contextDigest: hash("njpbs-public-context-v1:4"),
    code: { ...publication, deploymentId: "original-deployment", contextDigest: hash(JSON.stringify(publicContext)) }, inputs },
    storage: { get: async key => objects.get(key)!, put: async () => { throw new Error("Read only"); } } });
  return { schedule: original.schedule, files, qualifiedCode, inputs, roster };
}

export function frozenReplayProgramRead(rendererSha: string) {
  const original = { assetId: "art", url: "https://media.njpbs.org/cms-media/art/original.png", mimeType: "image/png", width: 960, height: 540 };
  const image = { url: "/_astro/art.png", mimeType: "image/png", width: 960, height: 540, srcset: "/_astro/art.png 960w", sizes: "100vw",
    sources: [{ type: "image/avif", srcset: "/_astro/art.avif 960w" }, { type: "image/webp", srcset: "/_astro/art.webp 960w" }] };
  const catalog = { schemaVersion: 1, buildBatchId: "original-image-pack", generation: 5, rendererSha: rendererSha, mediaManifestDigest: "e".repeat(64),
    programs: [{ programId: "one", sourceVersion: 7, path: "/programs/one/", original, content: image, grid: image }],
    files: ["png", "avif", "webp"].map(format => ({ path: `/_astro/art.${format}`, digest: hash("abc"), size: 3, contentType: `image/${format}`, base64: "YWJj" })) };
  return ({ kind: "published-record-family", family: "programs", complete: true, assets: [{ id: "art", ...original }],
    documents: [{ id: "one", version: 7, status: "published", publiclyVisible: true, publishAt: "2026-10-12T10:00:00.000Z",
      published: { sourceVersion: 7, publishedAt: "2026-10-12T10:00:00.000Z", blocks: [], metadata: { type: "program", title: "Frozen program", slug: "one",
        previousSlugs: [], locale: "en", keyArtAssetId: "art", description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Frozen synopsis" }] }] } } } }],
    sourceSeal: { rendererSha: rendererSha, contextRevision: 4, contextDigest: hash("njpbs-public-context-v1:4") }, programImageDescriptors: catalog });
}
