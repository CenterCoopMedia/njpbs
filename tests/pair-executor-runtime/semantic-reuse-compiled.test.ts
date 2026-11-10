import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { publicReleasePairCompositeFixture } from "../helpers/public-release-pair-composite";
import { compiledPublicReleasePairCompositeArtifacts } from "../helpers/compiled-public-release-pair-composite";
import { runPublicReleasePairWorkOnce } from "../../site/scripts/public-release-pair-runtime";
import { openStagedPublicReleasePairComposite } from "../../site/scripts/public-release-pair-composite-storage";
import { openStagedPublicReleasePairCodePack } from "../../site/scripts/public-release-pair-code-pack-executor";
import { extractPassages } from "../../site/src/search/passages";

let runtime: Miniflare, directory: string, fixture: Awaited<ReturnType<typeof publicReleasePairCompositeFixture>>;
let store: R2Bucket, unchanged: Awaited<ReturnType<typeof fixture.prepareNext>>, changed: typeof unchanged;
const measurements: unknown[] = [];
let completePassages: number;
beforeAll(async () => {
  runtime = new Miniflare({ workers: [{ config: { name: "semantic-reuse-compiled", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "semantic-reuse-compiled" } } } }] });
  store = await runtime.getR2Bucket("CONTENT"); directory = await mkdtemp(path.join(os.tmpdir(), "semantic-reuse-compiled-"));
  const firestore = isolatedFirestore(`semantic-reuse-compiled-${Date.now()}`);
  fixture = await publicReleasePairCompositeFixture({ firestore, store, directory, prepareArtifacts: compiledPublicReleasePairCompositeArtifacts });
  // Capture real successive immutable H inputs before removing their mutable
  // sources. Each original accepted operation still executes its own H/claim.
  unchanged = await fixture.prepareNext(); changed = await fixture.prepareNext("Changed accepted semantic title");
  await firestore.doc("cmsPosts/story").delete(); await firestore.doc("cmsPosts/one").delete(); fixture.packet.boundary.objects.clear();
}, 120_000);
afterAll(async () => {
  try {
    if (process.env.PAIR_SEMANTIC_REUSE_MEASUREMENT_FILE) await writeFile(process.env.PAIR_SEMANTIC_REUSE_MEASUREMENT_FILE,
      JSON.stringify({ kind: "pair-semantic-reuse-local-measurement", measurements,
        scope: "real compiled NEW; single-article historical qualification replay; local Firestore/R2; queued-run elapsed excludes source capture, remote I/O and activation; phase sum is not click-to-live" }) + "\n");
  } finally { await fixture?.close(); await runtime?.dispose(); if (directory) await rm(directory, { recursive: true, force: true }); }
});
async function measure(kind: string, taskId: string, captureAndQueueMs?: number) {
  const started = performance.now(); let renderMs = 0, stageMs = 0, metrics: any;
  const execute = async (args: Parameters<typeof fixture.operations.execute>[0]) => {
    const before = performance.now(), result = await fixture.operations.execute(args); renderMs = performance.now() - before; metrics = (result as any).metrics; return result;
  };
  const stage = async (args: Parameters<typeof fixture.operations.stage>[0]) => {
    const before = performance.now(); await fixture.operations.stage(args); stageMs = performance.now() - before;
  };
  expect(await runPublicReleasePairWorkOnce({ firestore: fixture.firestore, pair: fixture.pair, ...fixture.operations, execute, stage })).toBe("complete");
  const queuedRunMs = performance.now() - started;
  const receipt = (await fixture.firestore.doc(`${fixture.base}/receipts/${taskId}`).get()).data()!;
  expect(receipt).toBeTruthy();
  expect(receipt.identity.kind).toBe("qualification");
  measurements.push({ kind, taskKind: receipt.identity.kind, renderMs, stageMs, queuedRunMs, captureAndQueueMs,
    localPathPhaseSumMs: captureAndQueueMs === undefined ? undefined : captureAndQueueMs + queuedRunMs, metrics });
  return { metrics, owner: { firestore: fixture.firestore, store, pair: fixture.pair, identity: receipt.identity,
    claimDigest: receipt.claimDigest, viewManifestDigest: receipt.manifestDigest } };
}
async function assertCompleteSemanticRoster(owner: Awaited<ReturnType<typeof measure>>["owner"]) {
  // Derive the expected roster from separately verified G HTML plus unowned
  // original baseline HTML, never from the semantic result or its metrics.
  const opened = await openStagedPublicReleasePairComposite(owner);
  const baseline = await openStagedPublicReleasePairCodePack(owner);
  const owned = new Set([...opened.plan.routes.map(route => route.path),
    ...opened.manifest.members.filter(member => member.kind === "author").map(member => member.path)]);
  const html: { path: string; body: Uint8Array }[] = [];
  for (const member of opened.manifest.members) if (member.status === 200 && member.mime.startsWith("text/html"))
    html.push({ path: member.path, body: (await opened.readMember(member.path)).body });
  for (const member of baseline.manifest.members) if (member.mime.startsWith("text/html")) {
    const route = member.path.replace(/\/index\.html$/, "/");
    if (!owned.has(route)) html.push({ path: route, body: await baseline.readMember(member.path) });
  }
  const expected = html.flatMap(file => extractPassages(new TextDecoder().decode(file.body), file.path, "public"));
  expect(expected.length).toBeGreaterThan(0);
  const semantic = JSON.parse(new TextDecoder().decode((await opened.readMember("/search/meaning-index.json")).body));
  const roster = (passages: typeof expected) => passages.map(({ id, url, title, text }) => ({ id, url, title, text })).sort((a, b) => a.id < b.id ? -1 : 1);
  expect(roster(semantic.passages)).toEqual(roster(expected));
  return expected.length;
}
it("cold-encodes the real complete roster before retaining any vectors", async () => {
  const { metrics, owner } = await measure("cold", fixture.taskId, fixture.initialCaptureAndQueueMs);
  completePassages = await assertCompleteSemanticRoster(owner);
  expect(metrics.semantic).toMatchObject({ passages: completePassages, encoded: completePassages, reused: 0 });
}, 60_000);
it("reuses exact unchanged passages from the preceding actual completed G", async () => {
  const queued = await unchanged.enqueue();
  const { metrics, owner } = await measure("warm-unchanged", queued.taskId, queued.captureAndQueueMs);
  expect(await assertCompleteSemanticRoster(owner)).toBe(completePassages);
  expect(metrics.semantic).toMatchObject({ passages: completePassages, encoded: 0, reused: completePassages, modelLoadMs: 0 });
}, 60_000);
it("freshly encodes a changed title while keeping exact unchanged passages", async () => {
  const queued = await changed.enqueue();
  const { metrics, owner } = await measure("warm-changed-title", queued.taskId, queued.captureAndQueueMs);
  expect(metrics.semantic.encoded).toBeGreaterThan(0); expect(metrics.semantic.encoded).toBeLessThan(completePassages);
  expect(metrics.semantic.reused).toBeGreaterThan(0);
  expect(metrics.semantic.passages).toBe(await assertCompleteSemanticRoster(owner));
  expect(metrics.semantic.encoded + metrics.semantic.reused).toBe(metrics.semantic.passages);
  const opened = await openStagedPublicReleasePairComposite(owner);
  expect(new TextDecoder().decode((await opened.readMember("/posts/shadow-fixture/")).body)).toContain("Changed accepted semantic title");
}, 60_000);
