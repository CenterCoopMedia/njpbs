import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { backgroundStorageFixture } from "./functions/background-storage-fixture";
import { createPublicArtifactInventoryReceipt } from "../site/src/lib/public-artifact-inventory";
import { buildScheduleExport } from "../site/src/lib/schedule-export";
import { createNoBuildPageWorker } from "../workers/src/no-build-page-worker";
import type { NoBuildPageReply } from "../cms-api/src/index";

const require = createRequire(import.meta.url);
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const rendererSha = "a".repeat(40), checkedAt = Date.parse("2026-10-30T15:00:00Z");
const jsonPath = "/_schedule-sources.json", pdfPath = "/schedule/downloads/nj-pbs-schedule.pdf";
const dates = Array.from({ length: 14 }, (_, n) => new Date(Date.UTC(2026, 9, 30 + n)).toISOString().slice(0, 10));
const data = { source: "pbs-tvss" as const, generatedAt: "2026-10-30T13:00:00.000Z",
  timeZone: "America/New_York", request: { station: "WNJT", dates },
  days: Object.fromEntries(["broadcast", "kids"].map(kind => [kind, dates.map(date => ({
    date, callsign: "wnjt", kind, timeZone: "America/New_York", entries: [{ title: "Example reader program",
      startsAt: `${date}T12:00:00-04:00`, endsAt: `${date}T13:00:00-04:00`, isKids: kind === "kids", feedKind: kind }],
  }))])) };
const rawJson = Buffer.from(JSON.stringify(data));
// The reader verifies retained seals/magic; producing a PDF belongs to the
// unchanged producer suite. This deliberately cannot be a regenerated PDF.
const pdf = Buffer.from("%PDF-1.7\nretained reader fixture bytes\n");
let boundary: Awaited<ReturnType<typeof backgroundStorageFixture>>;
let handlerFactory: Function, readInputs: Function, readExport: Function, captureSchedule: Function;
let publication: Record<string, unknown>, codeContext: any, pointer: any, context: any, packet: any, capability: any;
let codeReads: number, transactions: number, errors: string[], malformedCode: boolean;
let legacyReferenceStatus: number | null;
let firestore: ReturnType<typeof fixtureFirestore>;

beforeAll(async () => {
  process.env.GCLOUD_PROJECT = "njpbs-site-dev";
  process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: "njpbs-site-dev" });
  process.env.FUNCTIONS_EMULATOR = "true";
  delete process.env.CMS_EDGE_ORIGIN_SECRET;
  boundary = await backgroundStorageFixture("njpbs-dev-public-artifacts");
  handlerFactory = require("../functions/public-content.js").createCmsGetPublicPageHandler;
  ({ readPageScheduleInputsInTransaction: readInputs, readNoBuildPageScheduleExport: readExport, capturePageSchedule: captureSchedule } =
    require("../functions/lib/no-build-page-schedule-reader.js"));
});
afterAll(async () => { await boundary?.close(); });
beforeEach(() => {
  codeReads = 0; transactions = 0; errors = []; malformedCode = false;
  legacyReferenceStatus = null;
  firestore = fixtureFirestore();
  capability = { schemaVersion: 1, rendererSha, servingEnabled: true, generation: 1 };
  boundary.objects.clear(); boundary.reads.length = 0; boundary.writes.length = 0;
  boundary.onRead(null); boundary.refuseReads(false);
  const reservation = { schemaVersion: 1 as const, buildBatchId: "cms-" + "C".repeat(20), generation: 1,
    status: "reserved" as const, commitSha: rendererSha, reservedAgainstGeneration: 0,
    reservedAgainstDeploymentId: null, reservedAgainstCommitSha: null,
    cutoffAt: { seconds: checkedAt / 1000, nanoseconds: 0, toMillis: () => checkedAt },
    reservedAt: { seconds: checkedAt / 1000, nanoseconds: 0, toMillis: () => checkedAt } };
  codeContext = { schemaVersion: 3, pages: [], posts: [], programs: [], authors: [], settings: [], receipt:
    createPublicArtifactInventoryReceipt({ reservation, pages: [], posts: [], programs: [], authors: [], settings: [] }) };
  publication = { schemaVersion: 1, digestAlgorithm: "sha256", buildBatchId: reservation.buildBatchId,
    generation: 1, commitSha: rendererSha, artifactDigest: "d".repeat(64),
    artifactReceiptDigest: sha(JSON.stringify(codeContext.receipt)), mediaManifestDigest: codeContext.receipt.mediaManifestDigest };
  pointer = { schemaVersion: 1, mediaLifecycleReady: false, state: "idle", activeGeneration: 1,
    activeDeploymentId: "fixture-code", activeCommitSha: rendererSha, lastReservedGeneration: 1,
    newestEligibleGeneration: 1, newestEligibleBuildBatchId: reservation.buildBatchId };
  const operationId = "S".repeat(20);
  const inputs: any = { schemaVersion: 1, operationId, runtime: { owner: "cloudflare", release: "b".repeat(40) },
    contentDigest: "c".repeat(64), checkedAt, files: {} };
  for (const name of ["launch-media-manager.json", "spotlight-news.json", "schedule.json"]) {
    const bytes = name === "schedule.json" ? rawJson : Buffer.from("{}");
    inputs.files[name] = { key: `post-background-v1/external-inputs/${operationId}/${name}`, digest: sha(bytes), size: bytes.length };
  }
  const source = { operationId, runtime: inputs.runtime, contentDigest: inputs.contentDigest, scheduleDigest: sha(rawJson), checkedAt };
  const identity = sha(JSON.stringify([operationId, source.runtime.owner, source.runtime.release, source.contentDigest, source.scheduleDigest, checkedAt]));
  const exported = buildScheduleExport(data as any, new Date(checkedAt));
  packet = { schemaVersion: 1, source, generatedAt: data.generatedAt, exportedAt: exported.exportedAt,
    startDate: exported.startDate, endDate: exported.endDate, timeZone: data.timeZone, files: {} };
  for (const [kind, bytes, name, contentType] of [["json", rawJson, "schedule.json", "application/json"],
    ["pdf", pdf, "nj-pbs-schedule.pdf", "application/pdf"]] as const) {
    packet.files[kind] = { key: `post-background-v1/schedule-packets/${operationId}/${identity}/${sha(bytes)}/${name}`,
      digest: sha(bytes), size: bytes.length, contentType };
    boundary.objects.set(packet.files[kind].key, Buffer.from(bytes));
  }
  context = { schemaVersion: 1, revision: 7, externalInputs: { ...inputs, schedulePacket: packet } };
});
function fixtureFirestore() { return {
  projectId: "njpbs-site-dev", doc: (path: string) => ({ path }),
  runTransaction: async (work: Function, options: unknown) => {
    expect(options).toEqual({ readOnly: true }); transactions++;
    // A real read-only transaction pins its snapshot. Fresh reads must use a
    // new transaction rather than reread this older selection.
    return work(snapshotTransaction());
  },
}; }
function snapshotTransaction() {
  const selectedPointer = structuredClone(pointer), selectedContext = structuredClone(context), selectedCapability = structuredClone(capability);
  return { get: async (ref: { path: string }) => {
    expect(ref.path).toBe("system/publicDeployment/noBuildPages/capability");
    return { data: () => selectedCapability };
  }, getAll: async (...refs: { path: string }[]) => {
    expect(refs.map(r => r.path)).toEqual(["system/publicDeployment", "system/publicDeployment/contexts/public"]);
    return [{ data: () => selectedPointer }, { data: () => selectedContext }];
  } };
}
async function codeRequest(url: string, options: RequestInit) {
  expect(url).toBe("https://dev-api.example.org/_internal/record-code");
  const query = JSON.parse(String(options.body));
  expect(["current-code", "current-code-reference"]).toContain(query.mode);
  expect(query).toEqual({ mode: query.mode, rendererSha });
  expect(new Headers(options.headers).get("x-njpbs-cms-edge")).toBe(require("../functions/lib/cms-edge").LOCAL_EDGE_SECRET);
  if (query.mode === "current-code") codeReads++;
  if (query.mode === "current-code-reference" && legacyReferenceStatus !== null) {
    return new Response(null, { status: legacyReferenceStatus });
  }
  const bytes = Buffer.from(JSON.stringify(malformedCode ? { ...codeContext, posts: [{ draftTitle: "invalid" }] } : codeContext));
  const reference = { publication, manifest: {
    schemaVersion: 1, buildBatchId: publication.buildBatchId, artifactReceiptDigest: publication.artifactReceiptDigest,
    byteLength: bytes.length, sha256: sha(bytes), key: `public-context/${publication.buildBatchId}/${sha(bytes)}.json`,
  } };
  return Response.json(query.mode === "current-code-reference" ? { schemaVersion: 1, kind: "current-code-reference", reference } :
    { schemaVersion: 1, kind: "current-code", reference, bytes: bytes.toString("base64") });
}
async function decision(path = jsonPath): Promise<NoBuildPageReply> {
  // Exercise the default factory, full validator and emitted CJS. Only its
  // existing HTTP transport is local; no injected CODE reader bypasses it.
  const handler = handlerFactory({ firestore, currentCodeRequest: codeRequest,
    log: { error: (_: unknown, details: any) => errors.push(details.errorMessage) } });
  const res = { statusCode: 0, body: undefined as any, headersSent: false,
    set() { return this; }, status(n: number) { this.statusCode = n; return this; }, json(body: unknown) { this.body = body; return this; } };
  await handler({ method: "POST", body: { mode: "no-build-page-v1", path, rendererSha, method: "GET" } }, res);
  return { ...res.body, status: res.statusCode };
}
it.each([jsonPath, pdfPath])("uses the default qualified factory and preserves exact sealed bytes at %s", async path => {
  const reply = await decision(path);
  expect(reply.status).toBe(200); expect(reply.kind).toBe("schedule-export");
  expect(codeReads).toBe(2); expect(transactions).toBe(6); expect(boundary.writes).toEqual([]);
  const bytes = Buffer.from(reply.bytes!, "base64"), receipt = reply.scheduleReceipt!;
  expect(receipt.source).toEqual(packet.source); expect(receipt.exportedAt).toBe(new Date(checkedAt).toISOString());
  expect(receipt.rawJson.digest).toBe(sha(rawJson)); expect(receipt.projectionJson.digest).not.toBe(sha(rawJson));
  expect(receipt.retainedPdf.digest).toBe(sha(pdf)); expect(JSON.stringify(reply)).not.toContain("selection");
  if (path === pdfPath) expect(bytes.equals(pdf)).toBe(true);
  else { expect(bytes.at(-1)).toBe(10); expect(JSON.parse(bytes.toString()).publication.commitSha).toBe(rendererSha); }
});
it("runs full CODE validation before accessing packet storage", async () => {
  malformedCode = true;
  expect((await decision()).status).toBe(503);
  expect(transactions).toBe(2); expect(boundary.reads).toEqual([]);
});
it.each([400, 503])("keeps Schedule available when an older reference RPC returns %s", async status => {
  legacyReferenceStatus = status;
  const first = await decision();
  expect(first).toMatchObject({ status: 200, kind: "schedule-export" });
  expect(first.scheduleReceipt!.source).toEqual(packet.source);
  expect(codeReads).toBe(4); expect(boundary.reads).toHaveLength(2);
  expect((await decision(pdfPath)).status).toBe(200);
  expect(codeReads).toBe(6); expect(boundary.reads).toHaveLength(2);
  expect(boundary.writes).toEqual([]);
});
it.each([400, 503])("refuses invalid full CODE during reference RPC rollout at %s", async status => {
  legacyReferenceStatus = status; malformedCode = true;
  expect((await decision()).status).toBe(503);
  expect(codeReads).toBe(1); expect(boundary.reads).toEqual([]);
});
it.each([401, 403])("does not fall back when the reference RPC refuses authentication at %s", async status => {
  legacyReferenceStatus = status;
  expect((await decision()).status).toBe(503);
  expect(codeReads).toBe(0); expect(boundary.reads).toEqual([]);
});
it("reuses immutable packet bytes on later decisions while checking fresh authority", async () => {
  expect((await decision()).status).toBe(200);
  expect(codeReads).toBe(2); expect(boundary.reads).toHaveLength(2);
  expect((await decision(pdfPath)).status).toBe(200);
  expect(codeReads).toBe(2); expect(boundary.reads).toHaveLength(2);
  capability.servingEnabled = false;
  expect(await decision()).toMatchObject({ kind: "pass", status: 200 });
  expect(codeReads).toBe(2); expect(boundary.reads).toHaveLength(2);
});
it("deduplicates simultaneous cold decisions for an exact identity", async () => {
  expect((await Promise.all([decision(), decision(pdfPath)])).map(reply => reply.status)).toEqual([200, 200]);
  expect(codeReads).toBe(2); expect(boundary.reads).toHaveLength(2);
});
it.each(["context", "capability", "CODE"])("reads new immutable bytes when the fresh %s identity changes", async change => {
  expect((await decision()).status).toBe(200);
  if (change === "context") context.revision++;
  if (change === "capability") capability.generation++;
  if (change === "CODE") publication.artifactDigest = "e".repeat(64);
  expect((await decision()).status).toBe(200);
  expect(codeReads).toBe(4); expect(boundary.reads).toHaveLength(4);
});
it("evicts old identities after four entries instead of retaining an unbounded packet history", async () => {
  const firstRevision = context.revision;
  for (let offset = 0; offset < 5; offset++) {
    context.revision = firstRevision + offset;
    expect((await decision()).status).toBe(200);
  }
  expect(codeReads).toBe(10); expect(boundary.reads).toHaveLength(10);
  context.revision = firstRevision;
  expect((await decision()).status).toBe(200);
  expect(codeReads).toBe(12); expect(boundary.reads).toHaveLength(12);
});
it("keeps the caller's original capture deadline when immutable bytes are reused", async () => {
  let clock = Date.now(); const deadline = clock + 45_000;
  await captureSchedule({ firestore, rendererSha, request: codeRequest, now: () => clock, deadline });
  clock += 40_000;
  const reused = await captureSchedule({ firestore, rendererSha, request: codeRequest, now: () => clock, deadline });
  expect(codeReads).toBe(2); expect(boundary.reads).toHaveLength(2);
  clock = deadline + 1;
  await expect(readInputs({ firestore, transaction: snapshotTransaction(), rendererSha, scheduleCapture: reused })).rejects.toThrow("capture is unavailable");
});
it.each(["revision", "externalInputs", "otherContextField", "deployment", "CODE"])("refuses a moved %s after storage IO", async change => {
  boundary.onRead(async () => {
    boundary.onRead(null);
    if (change === "revision") context.revision++;
    if (change === "externalInputs") context.externalInputs.checkedAt++;
    if (change === "otherContextField") context.changedAt = "new";
    if (change === "deployment") pointer.activeDeploymentId = "moved";
    if (change === "CODE") publication.artifactDigest = "e".repeat(64);
  });
  expect((await decision()).status).toBe(503);
});
it("binds a full actual capture inside the final transaction without CODE or Storage IO", async () => {
  const capture = await captureSchedule({ firestore, rendererSha, request: codeRequest });
  const reads = boundary.reads.length, requests = codeReads;
  const schedule = await readInputs({ firestore, transaction: snapshotTransaction(), rendererSha, scheduleCapture: capture });
  expect(schedule.receipt.rawJson.digest).toBe(sha(rawJson));
  expect(boundary.reads.length).toBe(reads); expect(codeReads).toBe(requests);
  context.externalInputs.contentDigest = "f".repeat(64);
  await expect(readInputs({ firestore, transaction: snapshotTransaction(), rendererSha, scheduleCapture: capture })).rejects.toThrow("selection moved");
});
it("refuses missing or forged captures in a write transaction without external IO", async () => {
  for (const capture of [undefined, {}]) {
    await expect(readInputs({ firestore, transaction: snapshotTransaction(), rendererSha, scheduleCapture: capture })).rejects.toThrow();
  }
  expect(boundary.reads).toEqual([]); expect(codeReads).toBe(0);
});
it.each(["missing", "wrong seal", "foreign source", "clock"])("refuses %s packet", async change => {
  if (change === "missing") boundary.objects.delete(packet.files.pdf.key);
  if (change === "wrong seal") boundary.objects.set(packet.files.pdf.key, Buffer.from("%PDF-corrupt"));
  if (change === "foreign source") packet.source.runtime.release = "f".repeat(40);
  if (change === "clock") packet.exportedAt = new Date(checkedAt + 1).toISOString();
  expect((await decision()).status).toBe(503);
});
it("refuses implicit live CODE transport and arbitrary routes before storage", async () => {
  await expect(readExport({ firestore, path: jsonPath, rendererSha })).rejects.toThrow("fixture transport");
  await expect(readExport({ firestore, path: "/arbitrary.pdf", rendererSha })).rejects.toThrow("route");
  expect(boundary.reads).toEqual([]);
});
it("preserves UTF8/BOM rejection after exact byte seals are verified", async () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), rawJson]);
  packet.files.json = { ...packet.files.json, key: packet.files.json.key.replace(packet.files.json.digest, sha(bytes)),
    digest: sha(bytes), size: bytes.length };
  boundary.objects.set(packet.files.json.key, bytes);
  expect((await decision()).status).toBe(503);
  expect(errors.some(message => message.includes("packet"))).toBe(true);
});
it.each([jsonPath, pdfPath])("serves only verified fixed Worker bytes with HEAD at %s", async path => {
  const reply = await decision(path);
  const worker = createNoBuildPageWorker({ rendererSha, rendererReady: true, getDecision: async () => reply,
    fetchAsset: async () => { throw new Error("Assets must not be used"); }, render: async () => "",
    cache: { async match() {}, async put() {} } });
  const response = await worker.fetch(new Request(`https://dev-public.example.org${path}`));
  expect(response!.status).toBe(200); expect(response!.headers.get("cache-control")).toBe("no-store");
  expect(response!.headers.get("x-njpbs-schedule-exported-at")).toBe(new Date(checkedAt).toISOString());
  if (path === pdfPath) expect(Buffer.from(await response!.arrayBuffer()).equals(pdf)).toBe(true);
  expect(await (await worker.fetch(new Request(`https://dev-public.example.org${path}`, { method: "HEAD" })))!.text()).toBe("");
  for (const query of ["?key=private", "?cms-schedule=a&cms-schedule=b"]) {
    expect((await worker.fetch(new Request(`https://dev-public.example.org${path}${query}`)))!.status).toBe(404);
  }
  const refresh = await worker.fetch(new Request(`https://dev-public.example.org${path}?_njpbs_refresh=11111111-1111-4111-8111-111111111111`));
  expect(refresh!.status).toBe(200);
  expect(refresh!.headers.get("x-njpbs-content-source")).toBe("cms-page-schedule");
});
it("falls through ordinary and Admin freshness requests without capability or matching bytes", async () => {
  const reply = await decision(pdfPath);
  for (const ready of [false, true]) {
    const worker = createNoBuildPageWorker({ rendererSha, rendererReady: ready,
      getDecision: async () => ({ ...reply, bytes: Buffer.from("%PDF-wrong").toString("base64") }),
      fetchAsset: async () => { throw new Error("Assets must not be used"); }, render: async () => "",
      cache: { async match() {}, async put() {} } });
    expect(await worker.fetch(new Request(`https://dev-public.example.org${pdfPath}`))).toBeNull();
    expect(await worker.fetch(new Request(`https://dev-public.example.org${jsonPath}?cms-schedule=proof`))).toBeNull();
  }
});
it.each(["missing", "disabled", "another renderer"])("keeps fixed exports on Assets before %s capability activates without immutable IO", async state => {
  if (state === "missing") capability = undefined;
  if (state === "disabled") capability.servingEnabled = false;
  if (state === "another renderer") capability.rendererSha = "f".repeat(40);
  expect(await readExport({ firestore, path: pdfPath, rendererSha, currentCodeRequest: codeRequest })).toEqual({ kind: "pass", path: pdfPath });
  expect(codeReads).toBe(0); expect(boundary.reads).toEqual([]); expect(boundary.writes).toEqual([]);
});
