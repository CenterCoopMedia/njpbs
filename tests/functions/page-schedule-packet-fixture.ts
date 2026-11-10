import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { backgroundStorageFixture } from "./background-storage-fixture";
import { createPublicArtifactInventoryReceipt } from "../../site/src/lib/public-artifact-inventory";
import { buildScheduleExport } from "../../site/src/lib/schedule-export";
import { createHomeSourceSnapshot } from "../../site/src/lib/home-sources";
import { createHomeEditorialCatalog } from "../../site/src/lib/home-editorial-catalog";
import { projectCmsPost, type CmsPostDoc } from "../../site/src/lib/cms-posts-projection";
import { projectCmsProgram } from "../../site/src/lib/cms-programs-projection";

const require = createRequire(import.meta.url);
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
let fixtureSequence = 0;

/** Real local HTTP and Storage SDK boundaries; no live transport or credential. */
export async function schedulePacketFixture({ firestore, rendererSha, generation = 2, boundary: existingBoundary,
  includeHomeSources = false, attachExternalInputs = true, postDocuments = [], programRead, preparePublication,
  target = require("../../functions/lib/publication-target").publicationTarget("development") }: {
  firestore: any; rendererSha: string; generation?: number; target?: any; boundary?: Awaited<ReturnType<typeof backgroundStorageFixture>>;
  includeHomeSources?: boolean; attachExternalInputs?: boolean; postDocuments?: CmsPostDoc[];
  programRead?: any; preparePublication?(context: { codeContext: any; reservation: any }): Promise<any>;
}) {
  const previousFunctionsEmulator = process.env.FUNCTIONS_EMULATOR;
  process.env.FUNCTIONS_EMULATOR = "true";
  const checkedAt = Date.parse("2026-10-12T10:00:00Z");
  const dates = Array.from({ length: 14 }, (_, n) => new Date(Date.UTC(2026, 9, 12 + n)).toISOString().slice(0, 10));
  const schedule = { source: "pbs-tvss" as const, generatedAt: "2026-10-12T09:00:00.000Z",
    timeZone: "America/New_York", request: { station: "WNJT", dates },
    days: Object.fromEntries(["broadcast", "kids"].map(kind => [kind, dates.map(date => ({
      date, callsign: "wnjt", kind, timeZone: "America/New_York", entries: [{ title: "Example schedule program",
        startsAt: `${date}T08:00:00-04:00`, endsAt: `${date}T09:00:00-04:00`,
        isKids: kind === "kids", kids: kind === "kids", feedKind: kind }],
    }))])) };
  const json = Buffer.from(JSON.stringify(schedule)), pdf = Buffer.from("%PDF-1.7\nexact retained SDK fixture bytes\n");
  const boundary = existingBoundary ?? await backgroundStorageFixture(target.backgroundBucket);
  const operationId = "S".repeat(20);
  const inputs: any = { schemaVersion: 1, operationId, runtime: { owner: "cloudflare", release: "b".repeat(40) },
    contentDigest: "c".repeat(64), checkedAt, files: {} };
  const payloads: Record<string, any> = { "launch-media-manager.json": {},
    "spotlight-news.json": { checkedAt: new Date(checkedAt).toISOString(), cards: [] }, "schedule.json": schedule };
  const contentValue = (value: any): any => Array.isArray(value) ? value.map(contentValue) :
    value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .filter(([key]) => !["checkedAt", "generatedAt", "sourceCheckedAt"].includes(key))
      .map(([key, item]) => [key, contentValue(item)])) : value;
  inputs.contentDigest = sha(JSON.stringify(Object.fromEntries(Object.entries(payloads).map(([name, value]) => [name, contentValue(value)]))));
  for (const name of ["launch-media-manager.json", "spotlight-news.json", "schedule.json"]) {
    const bytes = Buffer.from(JSON.stringify(payloads[name]));
    inputs.files[name] = { key: `post-background-v1/external-inputs/${operationId}/${name}`, digest: sha(bytes), size: bytes.length };
    boundary.objects.set(inputs.files[name].key, bytes);
  }
  const source = { operationId, runtime: inputs.runtime, contentDigest: inputs.contentDigest, scheduleDigest: sha(json), checkedAt };
  const identity = sha(JSON.stringify([operationId, source.runtime.owner, source.runtime.release, source.contentDigest, source.scheduleDigest, checkedAt]));
  const exported = buildScheduleExport(schedule as any, new Date(checkedAt));
  const packet: any = { schemaVersion: 1, source, generatedAt: schedule.generatedAt, exportedAt: exported.exportedAt,
    startDate: exported.startDate, endDate: exported.endDate, timeZone: schedule.timeZone, files: {} };
  for (const [kind, bytes, name, contentType] of [["json", json, "schedule.json", "application/json"],
    ["pdf", pdf, "nj-pbs-schedule.pdf", "application/pdf"]] as const) {
    packet.files[kind] = { key: `post-background-v1/schedule-packets/${operationId}/${identity}/${sha(bytes)}/${name}`,
      digest: sha(bytes), size: bytes.length, contentType };
    boundary.objects.set(packet.files[kind].key, bytes);
  }
  if (attachExternalInputs) await firestore.doc("system/publicDeployment/contexts/public").update({ externalInputs: { ...inputs, schedulePacket: packet } });
  const reservation: any = { schemaVersion: 1, buildBatchId: "cms-" + (++fixtureSequence).toString(36).padStart(20, "C"), generation,
    status: "reserved", commitSha: rendererSha, reservedAgainstGeneration: generation - 1,
    reservedAgainstDeploymentId: generation > 1 ? "previous" : null,
    reservedAgainstCommitSha: generation > 1 ? "e".repeat(40) : null,
    cutoffAt: { seconds: checkedAt / 1000, nanoseconds: 0, toMillis: () => checkedAt },
    reservedAt: { seconds: checkedAt / 1000, nanoseconds: 0, toMillis: () => checkedAt } };
  const homePublication = { buildBatchId: reservation.buildBatchId, generation, commitSha: rendererSha };
  const pools = includeHomeSources ? createHomeSourceSnapshot(payloads["launch-media-manager.json"], payloads["spotlight-news.json"], homePublication) : undefined;
  const homeSources = pools ? { ...pools, editorial: createHomeEditorialCatalog(pools, payloads["spotlight-news.json"], [], new Date(checkedAt).toISOString()) } : undefined;
  const posts = postDocuments.flatMap(document => {
    const post = projectCmsPost(document, { now: new Date(checkedAt), assets: new Map() });
    return post ? [post] : [];
  });
  const programs = (programRead?.documents ?? []).map((document: any) => projectCmsProgram(document, {
    now: new Date(checkedAt), assets: new Map((programRead.assets ?? []).map((asset: any) => [asset.id, asset])) })).filter(Boolean);
  const receipt =
    createPublicArtifactInventoryReceipt({ reservation, pages: [], programs: [], authors: [], settings: [],
      ...(programRead ? { programs: programRead.documents.map((document: any) => ({ kind: "program", documentId: document.id,
        sourceVersion: document.published.sourceVersion, canonicalPath: `/programs/${document.published.metadata.slug}/`,
        aliases: [], publishedSnapshot: document.published })) } : {}),
      posts: posts.map(post => ({ kind: "post", documentId: post.postId, sourceVersion: post.sourceVersion,
        canonicalPath: post.path, aliases: post.previousSlugs.map(slug => `/posts/${slug}/`),
        publishedSnapshot: postDocuments.find(document => document.id === post.postId)?.published })) });
  const codeContext = { schemaVersion: 3, pages: [], posts, programs, authors: [], settings: [], ...(homeSources ? { homeSources } : {}), receipt,
    ...(programRead ? { programImageDescriptors: { ...programRead.programImageDescriptors, buildBatchId: reservation.buildBatchId,
      generation, rendererSha, mediaManifestDigest: receipt.mediaManifestDigest } } : {}) };
  let publication = { schemaVersion: 1, digestAlgorithm: "sha256", buildBatchId: reservation.buildBatchId,
    generation, commitSha: rendererSha, artifactDigest: "d".repeat(64),
    artifactReceiptDigest: sha(JSON.stringify(codeContext.receipt)), mediaManifestDigest: codeContext.receipt.mediaManifestDigest };
  if (preparePublication) {
    publication = await preparePublication({ codeContext, reservation });
    if (["buildBatchId", "generation", "commitSha", "mediaManifestDigest"].some(key => publication[key as keyof typeof publication] !== receipt[key as keyof typeof receipt]) ||
        publication.artifactReceiptDigest !== sha(JSON.stringify(receipt))) throw new Error("Prepared fixture publication differs from CODE");
  }
  const bytes = Buffer.from(JSON.stringify(codeContext));
  const manifest = { schemaVersion: 1, buildBatchId: publication.buildBatchId,
    artifactReceiptDigest: publication.artifactReceiptDigest, byteLength: bytes.length, sha256: sha(bytes),
    key: `public-context/${publication.buildBatchId}/${sha(bytes)}.json` };
  await firestore.doc(`cmsPreviewPublicContexts/${publication.buildBatchId}`).set(manifest);
  await firestore.doc("system/publicDeployment/noBuildPages/capability").set({ schemaVersion: 1,
    rendererSha, servingEnabled: true, generation,
    terminalOwner: { schemaVersion: 1, transport: "page-no-build-v1", rendererSha } });
  let codeReads = 0, codeRequests = 0, referenceReads = 0, refuseCode = false, recordReply: any;
  const server = createServer(async (request, response) => {
    codeRequests++;
    const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const query = JSON.parse(Buffer.concat(chunks).toString());
    const current = ["current-code", "current-code-reference"].includes(query.mode);
    const record = ["programs", "events"].includes(query.family) && query.purpose === "cards" && recordReply;
    if (refuseCode || request.method !== "POST" || !current && !record || query.rendererSha !== rendererSha ||
        request.headers["x-njpbs-cms-edge"] !== require("../../functions/lib/cms-edge").LOCAL_EDGE_SECRET) {
      response.writeHead(503).end(); return;
    }
    if (query.mode === "current-code-reference") {
      referenceReads++;
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ schemaVersion: 1,
        kind: "current-code-reference", reference: { publication, manifest } })); return;
    }
    codeReads++;
    if (record) { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(recordReply)); return; }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ schemaVersion: 1, kind: "current-code",
      reference: { publication, manifest }, bytes: bytes.toString("base64") }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address() as { port: number };
  return { boundary, packet, pdf, homeSources, codeContext, reference: { publication, manifest }, codeReads: () => codeReads,
    referenceReads: () => referenceReads, codeRequests: () => codeRequests,
    request: (url: string, options: RequestInit) => {
      const origin = target.environment === "development" ? "https://dev-api.example.org" : "https://api.example.org";
      if (url !== `${origin}/_internal/record-code`) throw new Error("Wrong fixed CODE target");
      return fetch(`http://127.0.0.1:${address.port}/_internal/record-code`, options);
    }, refuseCode: () => { refuseCode = true; }, allowCode: () => { refuseCode = false; }, recordReply: (value: any) => { recordReply = value; },
    close: async () => { if (!existingBoundary) await boundary.close(); await new Promise<void>(resolve => server.close(() => resolve()));
      if (previousFunctionsEmulator === undefined) delete process.env.FUNCTIONS_EMULATOR;
      else process.env.FUNCTIONS_EMULATOR = previousFunctionsEmulator; } };
}
