import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, afterAll, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { publicReleasePairCompositeFixture } from "../helpers/public-release-pair-composite";
import work from "../../functions/lib/public-release-pair-work.js";
import protocol from "../../functions/lib/public-release-pair.js";
import { openPublicReleasePairCompositeAuthority } from "../../site/scripts/public-release-pair-composite-storage";
import { openPublicReleasePairRenderPlans } from "../../site/scripts/public-release-pair-render-plans";
import { derivePairPreviewContextSource, retainPairPreviewContext } from "../../site/scripts/public-release-pair-preview-context";
let runtime: Miniflare, sequence = 0;
beforeAll(() => { runtime = new Miniflare({ workers: [{ config: { name: "editorial-side-source", type: "worker", compatibilityDate: "2026-07-09",
  manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
  env: { CONTENT: { type: "r2", name: "editorial-side-source" } } } }] }); });
afterAll(async () => { await runtime?.dispose(); });
it("retains actual frozen editorial source after mutable CMS and provider bytes disappear, preserving OLD source and NEW target", async () => {
  const firestore = isolatedFirestore(`editorial-source-${++sequence}`), store = await runtime.getR2Bucket("CONTENT"), directory = await mkdtemp(path.join(os.tmpdir(), "editorial-frozen-"));
  let fixture;
  try {
    fixture = await publicReleasePairCompositeFixture({ firestore, store, directory });
    const claim = await work.claimPublicReleasePairWork({ firestore, pair: fixture.pair, taskId: fixture.taskId });
    if (!claim) throw new Error("Missing actual frozen claim");
    const opened = await openPublicReleasePairCompositeAuthority({ firestore, store, pair: fixture.pair, identity: claim.identity });
    const plans = await openPublicReleasePairRenderPlans(opened.frozen.root, opened.frozen.readFile);
    const home = plans.plan.routes.find(route => route.path === "/_home-sources.json");
    if (!home || home.renderer !== "json") throw new Error("Missing frozen actual Home source output");
    const homeRequest = JSON.parse(new TextDecoder().decode(await opened.frozen.readFile(home.inputFile)));
    const input = { pair: fixture.pair, identity: claim.identity, claimDigest: protocol.publicReleaseDigest(claim.token),
      viewManifestDigest: "c".repeat(64), root: opened.frozen.root, readFrozenFile: opened.frozen.readFile,
      homeSourceBytes: new TextEncoder().encode(JSON.stringify(homeRequest.read)), renderedAt: plans.plan.renderedAt };
    await firestore.doc("cmsPosts/story").update({ "published.metadata.title": "Mutable newer title must not be read" });
    fixture.packet.boundary.objects.clear(); const requests = fixture.packet.codeRequests();
    const source = await derivePairPreviewContextSource(input);
    expect(source.documents.find((row: any) => row.path === "cmsPosts/story").data.published.metadata.title).toBe("Accepted composite change");
    expect(source.pair).toEqual(protocol.publicReleasePairReference(fixture.pair));
    expect(source.sourcePair).toEqual(protocol.publicReleasePairReference(fixture.sourcePair));
    expect(source.sourcePair.commitSha).not.toBe(source.pair.commitSha);
    expect(source.homeSources.publication.commitSha).toBe(fixture.sourcePair.commitSha);
    expect(source.originalCode.reference.publication.commitSha).toBe(fixture.sourcePair.commitSha);
    expect(fixture.packet.codeRequests()).toBe(requests);
    const retained = await retainPairPreviewContext({ firestore, ...input }); expect(retained.manifest.viewManifestDigest).toBe(input.viewManifestDigest);
    await expect(derivePairPreviewContextSource({ ...input, homeSourceBytes: new TextEncoder().encode("{}") })).rejects.toThrow();
    await expect(derivePairPreviewContextSource({ ...input, readFrozenFile: async name => name.startsWith("code-source/objects/")
      ? new TextEncoder().encode("{}") : input.readFrozenFile(name) })).rejects.toThrow();
  } finally { await fixture?.close(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);
