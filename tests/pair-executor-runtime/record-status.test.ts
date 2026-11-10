import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { releasePair, pairReference } from "../helpers/private-public-release-pair.js";
import { publicReleaseBaselineCodeFixture } from "../helpers/public-release-baseline-code";
import deployment from "../../functions/lib/public-deployment.js";
import work from "../../functions/lib/public-release-pair-work.js";
import log from "../../functions/lib/public-release-change-log.js";
import producer from "../../functions/lib/public-release-producer.js";
import baseline from "../../functions/lib/public-release-change-baseline.js";
import snapshots from "../../functions/lib/publish-snapshot.js";
import { captureOwnedPublicReleasePairInput } from "../../site/scripts/public-release-pair-source-owner";
import { createPublicReleasePairExecutor } from "../../site/scripts/public-release-pair-executor";
import { runPublicReleasePairWorkOnce } from "../../site/scripts/public-release-pair-runtime";
import { readPublicReleasePairView } from "../../site/scripts/public-release-pair-view-storage";
import { projectPublishedRecordRead } from "../../site/src/lib/published-record-render";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let runtime: Miniflare, store: R2Bucket, pair: ReturnType<typeof releasePair>, db: ReturnType<typeof isolatedFirestore>;
beforeAll(async () => {
  const seal = await readFile(new URL("../../site/.public-post-renderer/pair-renderer-release.json", import.meta.url));
  pair = { ...releasePair("a", JSON.parse(seal.toString("utf8")).rendererSha), rendererDigest: hash(seal) };
  db = isolatedFirestore("pair-record-live-status");
  runtime = new Miniflare({ workers: [{ config: { name: "pair-record-live-status", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "pair-record-live-status" } } } }] });
  store = await runtime.getR2Bucket("CONTENT");
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  const listed = await store.list(); if (listed.objects.length) await store.delete(listed.objects.map(row => row.key));
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1, activeDeploymentId: "record-code",
    activeCommitSha: pair.commitSha, lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "record-code" });
  await work.registerPublicReleasePair({ firestore: db, pair });
  const head = log.initialPublicReleaseChangeHead("f".repeat(64)); await db.doc(log.PUBLIC_RELEASE_CHANGES_PATH).set(head);
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 1 });
  const code = publicReleaseBaselineCodeFixture(db, pair.commitSha);
  await baseline.capturePublicReleaseChangeBaseline({ firestore: code.firestore, currentCodeRequest: code.request, logEpoch: "record-status" });
  await db.doc(producer.PUBLIC_RELEASE_CHANGE_LOG_CONTROL).set({ schemaVersion: 2, enabled: true, logEpoch: "record-status", pair: pairReference(pair), head });
});
afterAll(async () => { await runtime?.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it.each([true, false])("matches real compiled record producer bytes and explicit withdrawals (visible %s)", async visible => {
  const published = snapshots.createPublishedSnapshot({ collection: "cmsPosts", document: { id: "one", version: 1, type: "program", title: "Public Program",
    slug: "one", previousSlugs: ["former"], locale: "en", description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Public Program synopsis" }] }] }, blocks: [] },
  publishedAt: "2026-10-01T12:00:00.000Z", publishedBy: "editor" });
  const operationId = visible ? "record-visible" : "record-withdrawn", details = ["/programs/one/", "/programs/former/", "/shows/one/", "/shows/former/"];
  await db.runTransaction(async transaction => {
    const append = await producer.preparePublicReleaseProducerInTransaction({ firestore: db, transaction, operationId, contextRevision: 2,
      changes: [{ kind: "record", id: "one", action: visible ? "publish" : "withdraw", sourceVersion: 1, snapshot: published }] });
    append(); transaction.set(db.doc("cmsPosts/one"), { id: "one", version: 1, status: visible ? "published" : "draft", publiclyVisible: visible, publishAt: published.publishedAt, published });
    transaction.set(db.doc("system/publicDeployment/noBuildRecordOwners/one"), { family: "programs", documentId: "one", visible, ownedPaths: details });
    transaction.set(db.doc("system/publicDeployment/contexts/public"), { schemaVersion: 1, revision: 2 });
  });
  const firestore = new Proxy(db, { get(target, key) { if (key === "projectId") return "njpbs-site-dev";
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; } });
  const captured = await captureOwnedPublicReleasePairInput({ firestore, store, providerStore: store, pair, sourceOperationId: operationId });
  const plan = JSON.parse(new TextDecoder().decode(await (await store.get(captured.root.files.find(file => file.name === "render-plan.json")!.objectKey))!.arrayBuffer()));
  expect(plan.expectedOutputs).toHaveLength(6);
  expect(plan.expectedOutputs.filter((row: any) => row.status === 308)).toEqual([]);
  const { taskId } = await db.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({ firestore: db, transaction, pair,
    input: { ...captured.receipt.scope, inputManifestDigest: captured.receipt.inputManifestDigest } }));
  const execution = createPublicReleasePairExecutor({ firestore: db, store, pair });
  let failure: unknown;
  const result = await runPublicReleasePairWorkOnce({ firestore: db, pair, ...execution, execute: async input => {
    try { return await execution.execute(input); } catch (error) { failure = error; throw error; }
  } });
  expect(result, failure instanceof Error ? `${(failure as any).code}: ${failure.stack}` : String(failure)).toBe("complete");
  const base = work.publicReleasePairPath(pair.pairId), receipt = (await db.doc(`${base}/receipts/${taskId}`).get()).data()!, staged = (await db.doc(`${base}/views/${receipt.manifestDigest}`).get()).data()!;
  const outputs = []; for await (const output of readPublicReleasePairView({ store, pair, identity: receipt.identity, claimDigest: receipt.claimDigest,
    manifestDigest: receipt.manifestDigest, manifestBytes: staged.manifestBytes })) outputs.push(output);
  const requests = new Map<string, any>();
  for (const route of plan.routes) if (route.renderer === "record") {
    const file = captured.root.files.find(file => file.name === route.inputFile)!;
    requests.set(route.path, JSON.parse(new TextDecoder().decode(await (await store.get(file.objectKey))!.arrayBuffer())));
  }
  const compiled = await import(new URL("../../site/.public-post-renderer/server/entry.mjs", import.meta.url).href);
  const now = new Date(plan.renderedAt);
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
  vi.stubGlobal("fetch", async () => { throw new Error("Live producer comparison has no network"); });
  try {
    for (const output of outputs) {
      const detail = details.includes(output.path), route = plan.routes.find((row: any) => row.path === output.path);
      expect(output.status).toBe(detail && !visible ? 410 : 200);
      if (output.status === 410) { expect(output.body.length).toBe(0); expect(route.renderer).toBe("withdrawal"); continue; }
      const request = requests.get(output.path);
      const content = await projectPublishedRecordRead(request.read, output.path, pair.commitSha, now);
      expect(content).not.toBeNull();
      const html = await compiled.renderPublishedRecordFamily(content);
      expect(output.body).toEqual(new TextEncoder().encode(html));
    }
  } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
});
