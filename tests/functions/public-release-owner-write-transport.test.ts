import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { Miniflare } from "miniflare";
import { FieldValue } from "firebase-admin/firestore";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { switchedPairFixture } from "../helpers/public-release-switched-pair";
import { stagedPublicReleasePairCompositeFixture } from "../helpers/staged-public-release-pair-composite";
import { recoverOriginalPublicReleaseWork } from "../../site/scripts/public-release-original-work-recovery";
import { activateStagedPublicReleasePairPublication } from "../../site/scripts/public-release-pair-content-activation";
import { publicReleaseOwnerWriteStore } from "../../site/scripts/public-release-owner-write-transport";
import { pairOwnerWriteRpc } from "../../publisher/pair-owner-write-rpc";
import { pairTerminalRpc } from "../../publisher/pair-terminal-rpc";
import { publicReleaseTerminalTransport } from "../../site/scripts/public-release-terminal-transport";
import { preparePublicReleasePublicationTerminal, settlePreparedPublicReleasePublication } from "../../site/scripts/public-release-publication-terminal";
import { createPublicReleaseSlot } from "../../workers/src/public-release-slot";
import { createPublicReleaseRouter } from "../../workers/src/public-release-router";
import work from "../../functions/lib/public-release-pair-work.js";
import protocol from "../../functions/lib/public-release-pair.js";
import admission from "../../functions/lib/public-release-admission.js";
import serving from "../../functions/lib/public-release-serving.js";
import { readPublicReleasePairReplaySelection, writePublicReleasePairReplaySelection } from "../../site/scripts/public-release-pair-replay-selection-storage";
import { pairOwnerEvidenceClient } from "../../publisher/pair-owner-evidence-client";
import { decodePairEvidenceFields } from "../../publisher/pair-work-reader";

const require = createRequire(import.meta.url), family = require("../../functions/lib/public-release-family-admission.js");
const operationId = "W".repeat(20), hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let runtime: Miniflare, fixture: Awaited<ReturnType<typeof switchedPairFixture>>;
let store: Awaited<ReturnType<Miniflare["getR2Bucket"]>>, objectRequest: Request, staged: Awaited<ReturnType<typeof stagedPublicReleasePairCompositeFixture>>;
let owner: ReturnType<typeof publicReleaseOwnerWriteStore>, router: ReturnType<typeof createPublicReleaseRouter>;
let recoveryStore: ReturnType<typeof publicReleaseOwnerWriteStore>;
const puts: string[] = [];
const refused: string[] = [];
const networkFetch = globalThis.fetch;
let evidence: ReturnType<typeof pairOwnerEvidenceClient>;
let lostEvidenceResponse = false;
let transportFailure: unknown;
const faultAudit = new AsyncLocalStorage<boolean>();
let firstAudit: Promise<void> = Promise.resolve();
const bucket = { get: (key: string) => store.get(key), put: (key: string, ...args: any[]) => {
  puts.push(key);
  expect(faultAudit.getStore(), "A refused fault request must never reach an R2 put").not.toBe(true);
  return (store.put as any)(key, ...args);
} };
const authority = () => ({ pair: fixture.pair, read: async (path: string) => (await fixture.firestore.doc(path).get()).data() ?? null, ...evidence });

beforeAll(async () => {
  runtime = new Miniflare({ workers: [{ config: { name: "owner-write", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "owner-write" } } } }] });
  store = await runtime.getR2Bucket("CONTENT");
  const database = isolatedFirestore("owner-write-transport");
  fixture = await switchedPairFixture(database, store);
  const { firestore, pair, sourcePair } = fixture;
  evidence = pairOwnerEvidenceClient({ pair, projectId: database.projectId, token: "owner", decode: decodePairEvidenceFields,
    request: async (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== "https://firestore.googleapis.com") throw new Error("Invalid private evidence fixture destination");
      const response = await networkFetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}${url.pathname}`, init);
      if (url.pathname.endsWith(":commit") && !lostEvidenceResponse && response.ok) {
        lostEvidenceResponse = true; await response.body?.cancel(); return new Response(null, { status: 503 });
      }
      return response;
    } });
  const code = await fixture.captureCode();
  const task = await firestore.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({ firestore, transaction, pair,
    input: { ...code.root.scope, inputManifestDigest: code.receipt.inputManifestDigest } }));
  await stagedPublicReleasePairCompositeFixture({ ...fixture, content: code, taskId: task.taskId }, store);
  router = createPublicReleaseRouter({ environment: "development",
    readSelector: () => serving.readPublicReleaseSelector({ firestore, environment: "development" }),
    slots: [pair, sourcePair].map(side => createPublicReleaseSlot({ pair: side, workerVersionId: side.publicWorker.versionId, store,
      getDecision: (selection, path) => serving.readPublicReleaseDecision({ firestore, environment: "development", pair: side,
        selection, path, composedReadersEnabled: true }) })) });
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).hostname === "pair-terminal.internal") return pairTerminalRpc(request, bucket as any, authority(), router);
    // The recursive stale-token probe belongs to the audit. Other legitimate
    // writes must wait while its global billing/lease records are faulted.
    if (faultAudit.getStore()) return pairOwnerWriteRpc(request, bucket as any, authority());
    try {
    if (!objectRequest && /\/objects\//.test(request.url)) {
      objectRequest = request.clone();
      let finishAudit!: () => void;
      firstAudit = new Promise<void>(resolve => { finishAudit = resolve; });
      try { await faultAudit.run(true, async () => {
        const data = new Uint8Array(await request.clone().arrayBuffer());
        for (const fault of ["lease", "operation", "digest", "size", "metadata", "other-pair", "overwrite", "body-hash", "invalid-json"]) {
          const headers = new Headers(request.headers);
          let url = request.url, body = data;
          if (fault === "lease") headers.set("x-original-recovery-lease", "invalid");
          if (fault === "operation") headers.set("x-owner-operation", "unaccepted-operation");
          if (fault === "digest") url = url.replace(/([a-f0-9]{64})\.json$/, `${"f".repeat(64)}.json`);
          if (fault === "size") headers.set("content-length", String(data.length + 1));
          if (fault === "metadata") headers.set("x-pair-metadata", "{}");
          if (fault === "other-pair") url = url.replace(pair.pairId, sourcePair.pairId);
          if (fault === "overwrite") headers.delete("if-none-match");
          if (fault === "body-hash") { body = new Uint8Array(data); body[0] ^= 1; }
          if (fault === "invalid-json") {
            body = new TextEncoder().encode("invalid-json"); const digest = hash(body);
            url = url.replace(/([a-f0-9]{64})\.json$/, `${digest}.json`);
            headers.set("content-length", String(body.length));
            headers.set("x-pair-metadata", JSON.stringify({ schemaversion: "2", pairdigest: protocol.publicReleaseDigest(pair), bodydigest: digest }));
          }
          const count = puts.length;
          expect((await pairOwnerWriteRpc(new Request(url, { method: "PUT", headers, body }), bucket as any, authority())).status, fault).toBe(403);
          expect(puts.length).toBe(count); refused.push(fault);
        }
        for (const fault of ["billing", "selector", "lease-expired", "lease-changed", "queue"]) {
          const path = fault === "billing" ? "system/billing" : fault === "selector" ? "system/publicDeployment"
            : fault === "queue" ? `cmsPublishQueue/${operationId}` : admission.publicationPendingPath(pair.pairId, operationId);
          const ref = firestore.doc(path), previous = (await ref.get()).data()!;
          const changed = fault === "billing" ? { ...previous, disabled: true } : fault === "selector" ? { ...previous, epoch: previous.epoch + 1 }
            : fault === "queue" ? { ...previous, status: "failed" } : { ...previous,
              recoveryLease: fault === "lease-expired" ? { ...previous.recoveryLease, until: 1 } : { ...previous.recoveryLease, token: "a".repeat(36) } };
          const body = new ReadableStream<Uint8Array>({ async pull(controller) {
            await ref.set(changed); controller.enqueue(data); controller.close();
          } }, { highWaterMark: 0 });
          const count = puts.length;
          try {
            expect((await pairOwnerWriteRpc(new Request(request.url, { method: "PUT", headers: request.headers,
              body, duplex: "half" } as RequestInit), bucket as any, authority())).status, fault).toBe(403);
            expect(puts.length).toBe(count); refused.push(fault);
          } finally { await ref.set(previous); }
        }
        const leaseRef = firestore.doc(admission.publicationPendingPath(pair.pairId, operationId)), savedLease = (await leaseRef.get()).data()!;
        try {
          await leaseRef.set({ ...savedLease, recoveryLease: { ...savedLease.recoveryLease, token: "b".repeat(36) } });
          const count = puts.length;
          // A stale attempt must send its originally reserved token. Reading
          // and adopting the replacement lease would incorrectly make this pass.
          await expect(recoveryStore.put(new URL(request.url).pathname.slice(1), data, {
            onlyIf: { etagDoesNotMatch: "*" }, sha256: hash(data),
            customMetadata: JSON.parse(request.headers.get("x-pair-metadata")!),
          })).rejects.toThrow();
          expect(puts.length).toBe(count); refused.push("stale-reserved-token");
        } finally { await leaseRef.set(savedLease); }
      }); } finally { finishAudit(); }
    } else if (objectRequest) await firstAudit;
    if (/\/manifests\//.test(request.url)) {
      const original = await request.clone().json() as any;
      for (const fault of ["original-source", "original-scope", "original-baseline"]) {
        const value = structuredClone(original);
        if (fault === "original-source") value.source.id = "other-original";
        if (fault === "original-scope") value.scope.sourceVersion++;
        if (fault === "original-baseline") value.cursor.baselineDigest = (value.cursor.baselineDigest[0] === "0" ? "1" : "0") + value.cursor.baselineDigest.slice(1);
        const body = new TextEncoder().encode(JSON.stringify(value)), digest = hash(body), headers = new Headers(request.headers);
        headers.set("content-length", String(body.length));
        headers.set("x-pair-metadata", JSON.stringify({ schemaversion: "2", pairdigest: protocol.publicReleaseDigest(pair), bodydigest: digest }));
        const url = request.url.replace(/([a-f0-9]{64})\.json$/, `${digest}.json`), count = puts.length;
        expect((await pairOwnerWriteRpc(new Request(url, { method: "PUT", headers, body }), bucket as any, authority())).status, fault).toBe(403);
        expect(puts.length).toBe(count); refused.push(fault);
      }
    }
    return await pairOwnerWriteRpc(request, bucket as any, authority());
    } catch (error) { transportFailure = error; throw error; }
  });
  owner = publicReleaseOwnerWriteStore({ pair, operationId });
  const story = (await firestore.doc("cmsPosts/story").get()).data()!;
  const nextDocument = { ...story, version: 10, publishBuildPending: true, publishBuildQueueId: operationId,
    published: { ...story.published, sourceVersion: 10, metadata: { ...story.published.metadata, title: "Original owner transport" } } };
  await firestore.runTransaction(async transaction => {
    const prepared = await family.preparePairContentPublication({ firestore, transaction, collection: "cmsPosts", documentId: "story",
      nextDocument, queueRef: firestore.doc(`cmsPublishQueue/${operationId}`), actor: { uid: "fixture-editor" }, kind: "post", family: "posts" });
    prepared.write(); transaction.set(firestore.doc("cmsPosts/story"), nextDocument);
  });
  expect((await firestore.collection(`${work.publicReleasePairPath(pair.pairId)}/work`).where("identity.sourceOperationId", "==", operationId).get()).empty).toBe(true);
  const queued = await recoverOriginalPublicReleaseWork({ firestore, store: owner, pair, operationId,
    storeForRecovery: ({ operationId, token }) => (recoveryStore = publicReleaseOwnerWriteStore({ pair, operationId, recoveryLease: token })),
    capture: { providerStore: fixture.providerStore, resourceRequest: async () => { throw new Error("No latest resource fallback"); } } });
  if (transportFailure) throw transportFailure;
  expect(queued.status).toBe("queued");
  expect(puts.some(key => key.includes("/objects/"))).toBe(true);
  expect(puts.some(key => key.includes("/manifests/"))).toBe(true);
  expect(refused).toHaveLength(18);
  staged = await stagedPublicReleasePairCompositeFixture({ ...fixture, taskId: queued.taskId! }, store);
}, 120_000);
afterAll(async () => { vi.unstubAllGlobals(); await fixture?.close(); await runtime?.dispose(); });

it("writes H before the original claim and actual post-G replay through the private adapters", async () => {
  const { firestore, pair } = fixture;
  expect((await firestore.doc(`cmsPublishQueue/${operationId}`).get()).data()!.execution).toBe(null);
  const head = (await firestore.doc("system/publicReleaseChanges").get()).data()!;
  const selected = staged.outputs.find(row => row.path === "/")!;
  // A completed target is sufficient even when a missed original wake has
  // not yet discovered the execution descriptor. No replacement claim exists.
  await writePublicReleasePairReplaySelection({ store: owner, pair, kind: "content",
    cursor: { baselineDigest: head.baselineDigest, sequence: head.sequence, lastDigest: head.lastDigest },
    members: [{ path: selected.path, bodyDigest: hash(selected.bytes), view: { identity: staged.claim.identity,
      claimDigest: staged.owner.claimDigest, manifestDigest: staged.rendered.manifestDigest, manifestBytes: staged.rendered.manifestBytes } }] });
  expect((await recoverOriginalPublicReleaseWork({ firestore, store: owner, pair, operationId, now: () => Date.now() + 31_000 })).status).toBe("rendered");
  const start = puts.length;
  await activateStagedPublicReleasePairPublication({ firestore, store: owner, pair, identity: staged.claim.identity,
    claimDigest: staged.owner.claimDigest, manifestDigest: staged.rendered.manifestDigest });
  expect(puts.slice(start).some(key => /\/pages\//.test(key))).toBe(true);
  expect(puts.slice(start).some(key => /\/selections\//.test(key))).toBe(true);
  const { ingress, store: terminalStore } = publicReleaseTerminalTransport(pair.environment);
  expect(lostEvidenceResponse).toBe(true);
  const proof = await preparePublicReleasePublicationTerminal({ firestore, store: terminalStore, ingress, operationId, fieldValues: FieldValue });
  expect((await settlePreparedPublicReleasePublication({ firestore, proof })).receipt.outcome).toBe("success");
  expect((await firestore.doc(`cmsPublishQueue/${operationId}`).get()).data()!.status).toBe("success");
  expect((await firestore.doc(`${admission.ADMISSIONS}/pending/${operationId}`).get()).exists).toBe(false);
}, 120_000);

it("permits subsequent own-pair replay only through the actual settled FACT and staged output bytes", async () => {
  const { firestore, pair } = fixture;
  const head = (await firestore.doc("system/publicReleaseChanges").get()).data()!;
  const cursor = { baselineDigest: head.baselineDigest, sequence: head.sequence, lastDigest: head.lastDigest };
  const reference = { identity: staged.claim.identity, claimDigest: staged.owner.claimDigest,
    manifestDigest: staged.rendered.manifestDigest, manifestBytes: staged.rendered.manifestBytes };
  const selected = staged.outputs.find(row => row.path === "/")!;
  const members = [{ path: selected.path, bodyDigest: hash(selected.bytes), view: reference }];
  const result = await writePublicReleasePairReplaySelection({ store: owner, pair, cursor, kind: "content", members });
  const read = [];
  for await (const member of readPublicReleasePairReplaySelection({ store: owner, pair, cursor, kind: "content", digest: result.digest })) read.push(member);
  expect(read).toEqual(members);
  // Identical retries are conditional misses; existing bytes stay unchanged.
  expect((await writePublicReleasePairReplaySelection({ store: owner, pair, cursor, kind: "content", members })).digest).toBe(result.digest);
  for (const invalid of [{ ...members[0], bodyDigest: "f".repeat(64) }, { ...members[0], path: "/absent-owner/" }]) {
    const count = puts.length;
    await expect(writePublicReleasePairReplaySelection({ store: owner, pair, cursor, kind: "content", members: [invalid] })).rejects.toThrow();
    expect(puts.length).toBe(count);
  }
  for (const value of [{ ...result.root, cursor: { ...cursor, sequence: cursor.sequence + 1 } },
    { ...result.root, count: result.root.count + 1 }, { ...result.root, unexpected: true },
    { ...result.root, pages: [{ ...result.root.pages[0], digest: "f".repeat(64) }] }]) {
    const bytes = new TextEncoder().encode(JSON.stringify(value)), digest = hash(bytes), count = puts.length;
    await expect(owner.put(`release-pair-replay/v2/${protocol.publicReleaseDigest(pair)}/selections/${digest}.json`, bytes,
      { onlyIf: { etagDoesNotMatch: "*" }, sha256: digest,
        customMetadata: { schemaversion: "2", pairdigest: protocol.publicReleaseDigest(pair), bodydigest: digest } })).rejects.toThrow();
    expect(puts.length).toBe(count);
  }
  const queue = firestore.doc(`cmsPublishQueue/${operationId}`), saved = (await queue.get()).data()!;
  try {
    await queue.update({ terminalReceipt: "f".repeat(64) });
    const count = puts.length;
    await expect(writePublicReleasePairReplaySelection({ store: owner, pair, cursor, kind: "content", members })).rejects.toThrow();
    expect(puts.length).toBe(count);
  } finally { await queue.set(saved); }
});

it("refuses pre-claim H after the real recovery lease is released or the operation settles", async () => {
  const count = puts.length;
  expect((await pairOwnerWriteRpc(objectRequest.clone(), bucket as any, authority())).status).toBe(403);
  expect(puts.length).toBe(count);
});

it.each(["GET", "DELETE", "POST", "HEAD"])("refuses %s on the write host before R2", async method => {
  const count = puts.length;
  expect((await pairOwnerWriteRpc(new Request(objectRequest.url, { method }), bucket as any, authority())).status).toBe(403);
  expect(puts.length).toBe(count);
});

it.each(["http://pair-owner-write.internal/public/latest.json", "http://pair-owner-write.internal/release-pairs/",
  "http://pair-owner-write.internal/?list=true", "https://pair-owner-write.internal/objects/", "http://other.internal/objects/"])(
  "refuses non-owner namespaces and destinations before R2: %s", async url => {
    const count = puts.length;
    expect((await pairOwnerWriteRpc(new Request(url, { method: "PUT", body: "{}" }), bucket as any, authority())).status).toBe(403);
    expect(puts.length).toBe(count);
  });
