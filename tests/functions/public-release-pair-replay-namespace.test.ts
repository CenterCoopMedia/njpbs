import feed from "../../functions/lib/public-release-pair-replay-content-feed.js";
import { replayRuntimeFixture, replayNamespaceFixture } from "../helpers/public-release-pair-replay-runtime";
import { afterEach, afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Miniflare } from "miniflare";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { releasePair } from "../helpers/private-public-release-pair.js";
import protocol from "../../functions/lib/public-release-pair.js";
import legacy from "../../functions/lib/public-deployment.js";
import work from "../../functions/lib/public-release-pair-work.js";
import views from "../../functions/lib/public-release-pair-view.js";
import namespace from "../../functions/lib/public-release-pair-search-namespace.js";
import search from "../../functions/lib/public-release-pair-replay-namespace.js";
import inventory from "../../functions/lib/public-release-pair-replay-inventory.js";
import capsules from "../../functions/lib/public-release-pair-replay-capsule.js";
import type { ReplayViewReference } from "../../functions/lib/public-release-pair-replay";
import type { ReplaySelectionMember } from "../../functions/lib/public-release-pair-replay-inventory";

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
let pair = releasePair(),
  baselineCursor = { baselineDigest: "b".repeat(64), sequence: 0, lastDigest: "b".repeat(64) };
let artifacts = new Map<string, import("../../functions/lib/public-release-pair-replay-inventory").ReplayArtifact>();
let base = work.publicReleasePairPath(pair.pairId);
let fixture: Awaited<ReturnType<typeof replayRuntimeFixture>> | undefined;
let db: ReturnType<typeof isolatedFirestore>, runtime: Miniflare, store: R2Bucket;
beforeAll(async () => {
  db = isolatedFirestore("public-release-pair-replay-namespace.test.ts");
  runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "replay-search",
          type: "worker",
          compatibilityDate: "2026-07-09",
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" },
            },
          },
          env: { CONTENT: { type: "r2", name: "replay-search-bytes" } },
        },
      },
    ],
  });
  store = await runtime.getR2Bucket("CONTENT");
});
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});
beforeEach(async () => {
  pair = releasePair();
  base = work.publicReleasePairPath(pair.pairId);
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`,
    { method: "DELETE" },
    db,
  );
  const objects = await store.list();
  if (objects.objects.length) await store.delete(objects.objects.map((row) => row.key));
  await db.doc("system/publicDeployment").set(legacy.initialPublicDeploymentPointer());
  await work.registerPublicReleasePair({ firestore: db, pair });
});
afterAll(async () => {
  await runtime?.dispose();
});

async function capturedView(sequence: number, fragment: string, items = 1) {
  if (!fixture) {
    fixture = await replayRuntimeFixture(db, store);
    pair = fixture.pair;
    baselineCursor = fixture.baseline.cursor;
    artifacts = new Map(fixture.baseline.manifest.members.map((row) => [row.path, row]));
    base = work.publicReleasePairPath(pair.pairId);
  }
  if (!sequence) {
    const initial = search.baselineReplaySearchNamespace({
      pair,
      artifacts,
      codePackView: fixture.baseline.reference,
      cursor: baselineCursor,
    });
    if (!initial) throw new Error("Missing baseline namespace");
    return { reference: fixture.baseline.reference, cursor: baselineCursor, manifest: initial.manifest };
  }
  const value = await replayNamespaceFixture(fixture, sequence, fragment, items);
  const members = value.outputs
    .filter((row) => row.path.startsWith("/pagefind/"))
    .map((row) => ({ path: row.path, mime: row.headers["content-type"], size: row.bytes, sha256: row.bodyDigest }));
  const manifest = namespace.parsePublicReleasePairSearchNamespace(
    {
      schemaVersion: 1,
      kind: "pair-search-namespace",
      namespace: "/pagefind/",
      pairDigest: protocol.publicReleaseDigest(pair),
      inputManifestDigest: value.reference.identity.inputManifestDigest,
      cursor: value.cursor,
      members,
    },
    pair,
    value.reference.identity,
  );
  return { ...value, manifest };
}
async function apply(
  view: Awaited<ReturnType<typeof capturedView>>,
  previous: ReturnType<typeof search.baselineReplaySearchNamespace>,
  overlay: Map<string, ReplaySelectionMember>,
) {
  return db.runTransaction(
    async (transaction) => {
      const outputs = await inventory.readReplayOutputInventory({
        firestore: db,
        transaction,
        pair,
        reference: view.reference,
        cursor: view.cursor,
      });
      return search.applyReplaySearchNamespace({
        firestore: db,
        transaction,
        pair,
        artifacts,
        outputs,
        reference: view.reference,
        cursor: view.cursor,
        previous,
        overlay,
      });
    },
    { readOnly: true },
  );
}
it("replaces the whole namespace and retains transient shards for negative qualification", async () => {
  const baseline = await capturedView(0, "baseline"),
    first = await capturedView(1, "transient"),
    last = await capturedView(2, "current");
  const overlay = new Map<string, ReplaySelectionMember>();
  const initial = search.baselineReplaySearchNamespace({
    pair,
    artifacts,
    codePackView: baseline.reference,
    cursor: baselineCursor,
  });
  const one = await apply(first, initial, overlay),
    two = await apply(last, one.state, overlay);
  expect([...overlay.keys()]).toEqual([
    "/pagefind/current.pf_fragment",
    "/pagefind/pagefind-entry.json",
    "/pagefind/pagefind.js",
  ]);
  const [proof] = search.replaySearchNamespaceProof(two.state, last.cursor);
  expect(proof.withdrawnPaths).toEqual(["/pagefind/baseline.pf_fragment", "/pagefind/transient.pf_fragment"]);
  expect(proof.namespaceRootDigest).toBe(sha(encode(last.manifest.members)));
  expect(proof.namespaceManifestDigest).toBe(sha(encode(last.manifest)));
  expect(proof.namespaceRootDigest).not.toBe(proof.namespaceManifestDigest);
  expect(proof.cursor).toEqual(last.cursor);
  expect(proof.view).toEqual(last.reference);
});
it("refuses a missing original namespace descriptor before changing the selected map", async () => {
  const baseline = await capturedView(0, "baseline"),
    first = await capturedView(1, "current");
  const overlay = new Map<string, ReplaySelectionMember>();
  const initial = search.baselineReplaySearchNamespace({
    pair,
    artifacts,
    codePackView: baseline.reference,
    cursor: baselineCursor,
  });
  await db.doc(namespace.publicReleasePairSearchNamespaceProofPath(pair, first.reference.manifestDigest)).delete();
  await expect(apply(first, initial, overlay)).rejects.toThrow();
  expect(overlay.size).toBe(0);
});
it("refuses namespace reuse without sealed unchanged-input evidence or a complete replacement", async () => {
  const baseline = await capturedView(0, "baseline");
  const previous = search.baselineReplaySearchNamespace({
    pair,
    artifacts,
    codePackView: baseline.reference,
    cursor: baselineCursor,
  });
  await expect(
    db.runTransaction(
      (transaction) =>
        search.applyReplaySearchNamespace({
          firestore: db,
          transaction,
          pair,
          artifacts,
          outputs: [],
          reference: baseline.reference,
          cursor: baselineCursor,
          previous,
          overlay: new Map(),
        }),
      { readOnly: true },
    ),
  ).rejects.toMatchObject({ code: "replay-search-input-evidence-missing" });
});
it("requires the exact compiled marker and both required namespace entry files", async () => {
  const baseline = await capturedView(0, "baseline");
  const check = (values: typeof artifacts) =>
    search.baselineReplaySearchNamespace({
      pair,
      artifacts: values,
      codePackView: baseline.reference,
      cursor: baselineCursor,
    });
  const missing = new Map(artifacts);
  missing.delete("/pagefind/pagefind.js");
  expect(() => check(missing)).toThrow();
  const forged = new Map(artifacts),
    key = "/_pair-compiled/pair-search-namespace.json";
  forged.set(key, { ...forged.get(key)!, sha256: "f".repeat(64) });
  expect(() => check(forged)).toThrow();
});

it("opens a namespace union across immutable chunks and refuses a missing predecessor", async () => {
  const baseline = await capturedView(0, "baseline");
  const initial = search.baselineReplaySearchNamespace({
    pair,
    artifacts,
    codePackView: baseline.reference,
    cursor: baselineCursor,
  });
  const paths = Array.from(
    { length: 5000 },
    (_, index) => `/pagefind/${sha(encode({ historicalShard: index }))}.pf_fragment`,
  );
  const namespaces = search
    .replaySearchNamespaceProof(initial, baselineCursor)
    .map((proof) => ({ ...proof, priorPaths: [...proof.priorPaths, ...paths], withdrawnPaths: paths }));
  const descriptor = await capsules.writeReplayNamespaceProof({ firestore: db, pair, namespaces });
  expect(descriptor.chunkCount).toBeGreaterThan(1);
  expect(await capsules.readReplayNamespaceProof({ firestore: db, pair, descriptor })).toEqual(namespaces);
  const tail = (await db.doc(`${base}/replayNamespaceChunks/${descriptor.tailDigest}`).get()).data()!;
  await db.doc(`${base}/replayNamespaceChunks/${tail.prevChunkDigest}`).delete();
  await expect(capsules.readReplayNamespaceProof({ firestore: db, pair, descriptor })).rejects.toThrow();
});
it("refuses changed namespace chunk bytes and a truncated descriptor", async () => {
  const namespaces = [{ namespace: "/pagefind/", priorPaths: ["/pagefind/removed.pf_fragment"] }];
  const descriptor = await capsules.writeReplayNamespaceProof({ firestore: db, pair, namespaces });
  await expect(
    capsules.readReplayNamespaceProof({ firestore: db, pair, descriptor: { ...descriptor, chunkCount: 0 } }),
  ).rejects.toThrow();
  await db
    .doc(`${base}/replayNamespaceChunks/${descriptor.tailDigest}`)
    .update({ body: Buffer.from("[]").toString("base64") });
  await expect(capsules.readReplayNamespaceProof({ firestore: db, pair, descriptor })).rejects.toThrow();
});

it("replaces a two-page feed with a sealed zero-page index and retains every withdrawn page", async () => {
  const baseline = await capturedView(0, "baseline");
  const first = await capturedView(1, "first", 21);
  const last = await capturedView(2, "last", 0);
  const initial = feed.baselineReplayContentFeedNamespace({
    pair,
    artifacts,
    codePackView: baseline.reference,
    cursor: baselineCursor,
  });
  const overlay = new Map<string, ReplaySelectionMember>();
  async function select(value: typeof first, previous: typeof initial) {
    const outputs = await db.runTransaction(
      (transaction) =>
        inventory.readReplayOutputInventory({
          firestore: db,
          transaction,
          pair,
          reference: value.reference,
          cursor: value.cursor,
        }),
      { readOnly: true },
    );
    return db.runTransaction(
      (transaction) =>
        feed.applyReplayContentFeedNamespace({
          firestore: db,
          transaction,
          pair,
          artifacts,
          outputs,
          reference: value.reference,
          cursor: value.cursor,
          previous,
          overlay,
        }),
      { readOnly: true },
    );
  }
  const one = await select(first, initial),
    two = await select(last, one.state);
  const [proof] = feed.replayContentFeedNamespaceProof(two.state, last.cursor);
  expect(proof.members).toEqual([]);
  expect(proof.index.pageCount).toBe(0);
  expect(proof.index.view).toEqual(last.reference);
  expect(proof.index.cursor).toEqual(last.cursor);
  expect(proof.withdrawnPaths).toEqual(["/api/v1/content/1.json", "/api/v1/content/2.json"]);
  expect([...overlay.keys()]).toEqual(["/api/v1/content.json"]);
});
