import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import replayServing from "../../functions/lib/public-release-serving-replay.js";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import { releasePair, pairReference } from "../helpers/private-public-release-pair.js";
const pair = releasePair(), base = work.publicReleasePairPath(pair.pairId);
const cursor = { baselineDigest: "1".repeat(64), sequence: 2, lastDigest: "2".repeat(64) };
const view = { identity: { schemaVersion: 2, pair: pairReference(pair), kind: "qualification", sourceOperationId: "source-one", sourceVersion: 7,
  snapshotDigest: "3".repeat(64), contextSequence: 1, inputManifestDigest: "4".repeat(64) }, claimDigest: "5".repeat(64), manifestDigest: "6".repeat(64), manifestBytes: 500 };
let db: Firestore, app: ReturnType<typeof initializeApp>, witness: any, namespaces: any[], readWitness: any;
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) throw new Error("Use assigned loopback Firestore emulator");
  app = initializeApp({ projectId: "demo-layer4-composed" }, "layer4-composed"); db = getFirestore(app);
});
afterAll(async () => { await deleteApp(app); });
async function selection(kind: string, members: any[]) {
  const page = { schemaVersion: 2, pairDigest: protocol.publicReleaseDigest(pair), kind, cursor, index: 0, members };
  const pageDigest = protocol.publicReleaseDigest(page);
  const root = { schemaVersion: 2, kind, pairDigest: protocol.publicReleaseDigest(pair), cursor,
    pages: members.length ? [{ digest: pageDigest, count: members.length, firstPath: members[0].path, lastPath: members.at(-1).path }] : [], count: members.length };
  const digest = protocol.publicReleaseDigest(root);
  await db.doc(`${base}/replaySelections/${digest}`).set({ root, readbackDigest: "7".repeat(64) });
  if (members.length) await db.doc(`${base}/replaySelectionPages/${pageDigest}`).set(page);
  return digest;
}
beforeEach(async () => {
  await db.recursiveDelete(db.collection("system"));
  const contentViewDigest = await selection("content", [{ path: "/contact/", view, bodyDigest: "a".repeat(64) }]);
  const codePackOverlayDigest = await selection("code-pack-overlay", [{ path: "/_astro/retained.abcdef12.png", view, bodyDigest: "b".repeat(64) }]);
  witness = { schemaVersion: 2, pairDigest: protocol.publicReleaseDigest(pair), contentViewDigest, codePackOverlayDigest,
    codeAssetManifestDigest: pair.codeAssetManifestDigest, headCursor: cursor, codePackView: { ...view, manifestDigest: "8".repeat(64) } };
  namespaces = [{ namespace: "/pagefind/", headCursor: cursor, cursor: { ...cursor, sequence: 1 }, view,
    members: [{ path: "/pagefind/current.pf_fragment", sha256: "c".repeat(64), mime: "application/octet-stream", size: 1 }],
    withdrawnPaths: ["/pagefind/old.pf_fragment"] }];
  // The shared replay owner validates the real witness/capsule chain; this
  // typed seam supplies that already-verified result to the layer-four reader.
  readWitness = vi.fn(async (options: any) => {
    expect(options.witnessDigest).toBe(protocol.publicReleaseDigest(witness));
    for (const selected of options.selectedViews ?? []) expect(selected).toEqual(view);
    return { witness, namespaces, headView: view };
  });
});
const read = (path: string) => db.runTransaction(transaction => replayServing.readComposedPairArtifactInTransaction({ firestore: db, transaction, pair,
  contentHead: { pairId: pair.pairId, viewId: protocol.publicReleaseDigest(witness), manifestDigest: witness.contentViewDigest, contextSequence: cursor.sequence },
  changes: { schemaVersion: 2, ...cursor }, path, readWitness } as any), { readOnly: true });
it("resolves the selected original content view without scanning a mutable checkpoint", async () => {
  const result = await read("/contact/");
  expect(result.locator.manifestDigest).toBe(view.manifestDigest); expect(result.expectedBodyDigest).toBe("a".repeat(64));
  expect(result.artifactPath).toBe("/contact/"); expect(readWitness).toHaveBeenCalledTimes(2);
});
it("resolves exact overlay additions and selected baseline fallback paths", async () => {
  expect((await read("/_astro/retained.abcdef12.png")).expectedBodyDigest).toBe("b".repeat(64));
  const fallback = await read("/unowned/");
  expect(fallback.locator.manifestDigest).toBe("8".repeat(64)); expect(fallback.artifactPath).toBe("/unowned/index.html");
});
it("never falls back into a withdrawn or missing namespace member", async () => {
  const current = await read("/pagefind/current.pf_fragment"); expect(current.expectedBodyDigest).toBe("c".repeat(64));
  for (const path of ["/pagefind/old.pf_fragment", "/pagefind/unknown.pf_fragment"]) expect((await read(path)).absent).toBe(true);
  await expect(read("/api/v1/content/1.json")).rejects.toThrow();
});
it("refuses altered selection pages and a witness belonging to another pair", async () => {
  const root = (await db.doc(`${base}/replaySelections/${witness.contentViewDigest}`).get()).data()!.root;
  await db.doc(`${base}/replaySelectionPages/${root.pages[0].digest}`).update({ "members": [{ path: "/contact/", view, bodyDigest: "0".repeat(64) }] });
  await expect(read("/contact/")).rejects.toThrow();
  witness = { ...witness, pairDigest: "0".repeat(64) }; await expect(read("/contact/")).rejects.toThrow();
});
it("keeps transaction reads bounded as an inventory root grows", async () => {
  const root = { schemaVersion: 2, kind: "content", pairDigest: protocol.publicReleaseDigest(pair), cursor,
    pages: Array.from({ length: 300 }, (_, i) => ({ digest: String(i).padStart(64, "0"), count: 1,
      firstPath: `/route-${String(i).padStart(4, "0")}/`, lastPath: `/route-${String(i).padStart(4, "0")}/` })), count: 300 };
  const digest = protocol.publicReleaseDigest(root); witness = { ...witness, contentViewDigest: digest };
  await db.doc(`${base}/replaySelections/${digest}`).set({ root, readbackDigest: "7".repeat(64) });
  const docs = vi.spyOn(db, "doc");
  expect((await read("/zz-absent/")).artifactPath).toBe("/zz-absent/index.html");
  expect(docs.mock.calls.map(([path]) => path)).toHaveLength(2); docs.mockRestore();
});

it("resolves rendered Home JSON from the official dynamic overlay selection", async () => {
  const codePackOverlayDigest = await selection("code-pack-overlay", [{ path: "/_home-sources.json", view, bodyDigest: "d".repeat(64) }]);
  witness = { ...witness, codePackOverlayDigest };
  const result = await read("/_home-sources.json");
  expect(result.locator.manifestDigest).toBe(view.manifestDigest); expect(result.expectedBodyDigest).toBe("d".repeat(64));
  expect(result.artifactPath).toBe("/_home-sources.json"); expect(readWitness).toHaveBeenCalledTimes(2);
});
it("refuses an uninstalled shared witness owner with a bounded protocol error", async () => {
  await expect(db.runTransaction(transaction => replayServing.readComposedPairArtifactInTransaction({ firestore: db, transaction, pair,
    contentHead: { pairId: pair.pairId, viewId: protocol.publicReleaseDigest(witness), manifestDigest: witness.contentViewDigest, contextSequence: cursor.sequence },
    changes: { schemaVersion: 2, ...cursor }, path: "/contact/" }), { readOnly: true })).rejects.toMatchObject({ name: "PublicReleaseProtocolError" });
});
