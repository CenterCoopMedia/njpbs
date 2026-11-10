import { afterAll, beforeAll, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { privateReaderFixture } from "../helpers/private-pair-reader-fixture";
import { sealedPair } from "../helpers/sealed-public-release-pair";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import rolloutApi from "../../functions/lib/public-release-pair-rollout.js";
import type { PairRolloutReadback, PairUploadPlan } from "../../functions/lib/public-release-pair-rollout";
import { startPublicReleasePairServer } from "../../site/scripts/public-release-pair-server";
import { createPrivatePairReader, readerSealPath } from "../../site/scripts/public-release-pair-private-reader";
import { PAIR_READER_PATH, parseReaderSeals, parseReaderRequest, parseReaderReply } from "../../site/scripts/public-release-pair-reader-contract";
import type { PairViewStore } from "../../site/scripts/public-release-pair-view-storage";
import { installPublicReleasePairReader } from "../../site/scripts/install-public-release-pair-reader";
import { privatePairReaderInstallation, privatePairReaderCapabilities } from "../../workers/src/private-pair-reader-installation";

let runtime: Miniflare;
beforeAll(() => {
  runtime = new Miniflare({ workers: [{ config: { name: "reader-server-test", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "reader-server-test" } } } }] });
});
afterAll(async () => { await runtime?.dispose(); });
it("mounts the actual read-only reader on the container server and refuses missing seals and unknown owners", async () => {
  const firestore = isolatedFirestore("actual-reader-server"), store = await runtime.getR2Bucket("CONTENT") as unknown as PairViewStore;
  const fixture = await privateReaderFixture(firestore, store, [{ path: "/withdrawn/", status: 410,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, bytes: new Uint8Array() }]);
  const base = work.publicReleasePairPath(fixture.pair.pairId), before = (await firestore.doc(`${base}/work/${fixture.staged.taskId}`).get()).data();
  const server = await startPublicReleasePairServer({ firestore, pair: fixture.pair, host: "127.0.0.1", port: 0,
    privateReader: async request => createPrivatePairReader({ firestore, pair: fixture.pair, store,
      installed: parseReaderSeals((await firestore.doc(readerSealPath(fixture.pair)).get()).data(), fixture.pair) })(request) });
  try {
    if (!server.address || typeof server.address === "string") throw new Error("Missing test address");
    const origin = `http://127.0.0.1:${server.address.port}`;
    const input = parseReaderRequest({ schemaVersion: 2, pairDigest: protocol.publicReleaseDigest(fixture.pair),
      ...fixture.selectedView, nonce: "a".repeat(64), paths: ["/withdrawn/"], absence: null }, fixture.pair);
    const call = (body: unknown = input) => fetch(`${origin}${PAIR_READER_PATH}`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const response = await call();
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    const reply = parseReaderReply(await response.json(), fixture.pair, input);
    expect(reply.outputs).toMatchObject([{ path: "/withdrawn/", status: 410, bytes: 0, bodyBase64: "" }]);
    expect((await call({ ...input, claimDigest: "e".repeat(64) })).status).toBe(503);
    expect((await call({ ...input, paths: Array.from({ length: 33 }, (_, index) => `/route-${index}/`).sort() })).status).toBe(503);
    expect((await fetch(`${origin}/private-pair-reader/v2/publish`, { method: "POST" })).status).toBe(404);
    await firestore.doc(readerSealPath(fixture.pair)).delete();
    expect((await call()).status).toBe(503);
    expect((await firestore.doc(`${base}/work/${fixture.staged.taskId}`).get()).data()).toEqual(before);
    expect((await firestore.collection(`${base}/receipts`).get()).size).toBe(1);
  } finally { await server.close(); await fixture.close(); }
});

async function installation(namespace: string) {
  const firestore = isolatedFirestore(namespace), { pair, seals } = sealedPair();
  const { workerVersionId, ...publisher } = pair.publisher;
  const plan: PairUploadPlan = { schemaVersion: 2, kind: "private-pair-publisher-upload", pairTemplate: { ...pair, publisher },
    accountId: "a".repeat(32), imageReference: `registry.cloudflare.com/${"a".repeat(32)}/fixture@${publisher.imageDigest}`,
    bundleDigest: "b".repeat(64), configurationDigest: "c".repeat(64) };
  await rolloutApi.reservePublicReleasePairUpload({ firestore, plan });
  await rolloutApi.recordPublicReleasePairUploadReadback({ firestore, plan, readback: {
    planDigest: protocol.publicReleaseDigest(plan), publisherApplication: publisher.application, workerVersionId,
    bundleDigest: plan.bundleDigest, configurationDigest: plan.configurationDigest, imageDigest: publisher.imageDigest } });
  await work.registerPublicReleasePair({ firestore, pair });
  await rolloutApi.reservePublicReleasePairRollout({ firestore, pair });
  const rollout: PairRolloutReadback = { publisherApplication: publisher.application, publisherWorkerVersionId: workerVersionId,
    imageDigest: publisher.imageDigest, publicService: pair.publicWorker.service, publicWorkerVersionId: pair.publicWorker.versionId,
    publisherDeploymentId: "aaaaaaaa-1111-4111-8111-111111111111", publicDeploymentId: "bbbbbbbb-1111-4111-8111-111111111111",
    publisherTrafficPercent: 100, publicTrafficPercent: 100 };
  const actual = { seals: privatePairReaderInstallation(pair, seals.deployment.origin),
    publisher: { pairDigest: protocol.publicReleaseDigest(pair), publisher: pair.publisher,
      readerContractDigest: pair.readerContractDigest, capabilities: privatePairReaderCapabilities(pair.commitSha) } };
  return { firestore, pair, seals, rollout, actual, readInstalled: async () => actual };
}
it("writes one immutable install seal only after verified actual image, version and reader RPC readback", async () => {
  const input = await installation("reader-install-success"), base = work.publicReleasePairPath(input.pair.pairId);
  await expect(installPublicReleasePairReader(input)).rejects.toThrow();
  expect((await input.firestore.doc(readerSealPath(input.pair)).get()).exists).toBe(false);
  await rolloutApi.recordPublicReleasePairRolloutReadback({ ...input, readback: input.rollout });
  const [first, second] = await Promise.all([installPublicReleasePairReader(input), installPublicReleasePairReader(input)]);
  expect([first.idempotent, second.idempotent].sort()).toEqual([false, true]);
  expect(first.installDigest).toBe(second.installDigest); expect(first.receipt).toEqual(second.receipt);
  expect((await input.firestore.doc(readerSealPath(input.pair)).get()).data()).toEqual(input.seals);
  expect((await input.firestore.collection(`${base}/readerInstalls`).get()).size).toBe(1);
  expect((await input.firestore.doc("system/publicDeployment").get()).exists).toBe(false);
  expect((await input.firestore.collection(`${base}/work`).get()).size).toBe(0);
});
it("refuses missing reader bytes contract, wrong image/version/origin and retirement without creating a seal", async () => {
  const input = await installation("reader-install-refusals");
  await rolloutApi.recordPublicReleasePairRolloutReadback({ ...input, readback: input.rollout });
  const malformed = [
    { ...input.actual, publisher: { ready: true } },
    { ...input.actual, publisher: { ...input.actual.publisher, capabilities: {} } },
    { ...input.actual, seals: { ...input.seals, deployment: { ...input.seals.deployment, origin: "https://other.example.test" } } },
    { ...input.actual, seals: { ...input.seals, deployment: { ...input.seals.deployment, versionId: "cccccccc-1111-4111-8111-111111111111" } } },
  ];
  for (const actual of malformed) await expect(installPublicReleasePairReader({ ...input, readInstalled: async () => actual })).rejects.toThrow();
  await expect(installPublicReleasePairReader({ ...input, rollout: { ...input.rollout, imageDigest: `sha256:${"e".repeat(64)}` } })).rejects.toThrow();
  await input.firestore.doc(`${work.publicReleasePairPath(input.pair.pairId)}/controls/runtime`).update({ status: "retired" });
  await expect(installPublicReleasePairReader(input)).rejects.toThrow();
  expect((await input.firestore.doc(readerSealPath(input.pair)).get()).exists).toBe(false);
});
