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
import work from "../../functions/lib/public-release-pair-work.js";
let runtime: Miniflare;
beforeAll(async () => { runtime = new Miniflare({ workers: [{ config: { name: "composite-compiled", type: "worker", compatibilityDate: "2026-07-09",
  manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
  env: { CONTENT: { type: "r2", name: "composite-compiled" } } } }] }); });
afterAll(async () => { await runtime?.dispose(); });
it("renders the complete frozen H through the actual NEW sandbox and recovers original completion without rerendering", async () => {
  const firestore = isolatedFirestore(`composite-compiled-${Date.now()}`), store = await runtime.getR2Bucket("CONTENT"), directory = await mkdtemp(path.join(os.tmpdir(), "composite-compiled-"));
  let fixture;
  try {
    fixture = await publicReleasePairCompositeFixture({ firestore, store, directory, prepareArtifacts: compiledPublicReleasePairCompositeArtifacts });
    await firestore.doc("cmsPosts/story").delete(); await firestore.doc("cmsPosts/one").delete(); fixture.packet.boundary.objects.clear();
    const started = performance.now();
    let renderMs = 0, metrics: unknown;
    const execute = async (args: Parameters<typeof fixture.operations.execute>[0]) => {
      const began = performance.now(), result = await fixture!.operations.execute(args);
      renderMs = performance.now() - began; metrics = (result as any).metrics; return result;
    };
    const crashStage = async () => { throw new Error("simulated crash after atomic completion"); };
    await expect(runPublicReleasePairWorkOnce({ firestore, pair: fixture.pair, ...fixture.operations, execute, stage: crashStage })).rejects.toThrow("simulated crash");
    const receipt = (await firestore.doc(`${fixture.base}/receipts/${fixture.taskId}`).get()).data()!;
    expect(receipt).toBeTruthy();
    const owner = { firestore, store, pair: fixture.pair, identity: receipt.identity, claimDigest: receipt.claimDigest, viewManifestDigest: receipt.manifestDigest };
    const stageBegan = performance.now(); await fixture.operations.recover(); const stageMs = performance.now() - stageBegan;
    const opened = await openStagedPublicReleasePairComposite(owner); await opened.verifyAll();
    const html = new TextDecoder().decode((await opened.readMember("/posts/shadow-fixture/")).body);
    expect(html).toContain("Accepted composite change");
    for (const target of ["/_publication.json", "/_content-status.json", "/api/v1/content.json", "/pagefind/pagefind.js", "/feeds/news.xml", "/search/meaning-index.json"]) {
      expect((await opened.readMember(target)).body.length).toBeGreaterThan(0);
    }
    expect(await work.claimPublicReleasePairWork({ firestore, pair: fixture.pair, taskId: fixture.taskId })).toBeNull();
    await fixture.operations.recover();
    expect((await firestore.doc(`${fixture.base}/receipts/${fixture.taskId}`).get()).data()).toEqual(receipt);
    const measurement = { kind: "pair-composite-local-measurement", renderMs, stageMs, elapsedMs: performance.now() - started, metrics,
      outputCount: opened.manifest.members.length, scope: "small real frozen fixture; local R2; excludes source capture and remote I/O" };
    if (process.env.PAIR_COMPOSITE_MEASUREMENT_FILE) await writeFile(process.env.PAIR_COMPOSITE_MEASUREMENT_FILE, JSON.stringify(measurement) + "\n");
  } finally { await fixture?.close(); await rm(directory, { recursive: true, force: true }); }
}, 120_000);
