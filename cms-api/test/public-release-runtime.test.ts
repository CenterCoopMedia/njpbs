import { createExecutionContext, env as workerEnv } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { releasePair, releaseSelector, pairReference } from "../../tests/helpers/private-public-release-pair.js";
import { PublicReleaseSlotEntrypoint, assertEmbeddedPublicSlot, type PublicReleaseSlotEnvironment } from "../../workers/src/public-release-slot-worker";
import ingress, { PublicReleaseIngressProofEntrypoint, type PublicReleaseIngressEnvironment } from "../../workers/src/public-release-ingress-worker";
import type { PairServingDecision } from "../../functions/lib/public-release-serving";
import { sealedPair } from "../../tests/helpers/sealed-public-release-pair";
import { PublicContentEntrypoint, type CmsApiEnv } from "../src/index";
const rateOwner = new PublicContentEntrypoint(createExecutionContext(), { ...workerEnv, PUBLIC_RELEASE_RATE_CONTROLS_ENABLED: "true",
  PREVIEW_RENDERER: undefined,
  CMS_EDGE_ORIGIN_SECRET: "fixture-edge",
  CMS_DEPLOYMENT_ENVIRONMENT: "development", FIREBASE_PROJECT_ID: "njpbs-site-dev",
  FUNCTIONS_ORIGIN: "https://us-central1-njpbs-site-dev.cloudfunctions.net", ADMIN_ORIGIN: "https://dev-admin.example.org" } as CmsApiEnv);
const admission = { consumeReleaseAuthority: (budget: number) => rateOwner.consumeReleaseAuthority(budget),
  consumeReleaseViewer: (ip: string, budget: number) => rateOwner.consumeReleaseViewer(ip, budget),
  consumeReleaseProof: (budget: number) => rateOwner.consumeReleaseProof(budget) };
function edgeRequest(url: string, init?: RequestInit) {
  const headers = new Headers(init?.headers); headers.set("cf-connecting-ip", "203.0.113.17");
  const request = new Request(url, { ...init, headers });
  Object.defineProperty(request, "cf", { value: { country: "US" } }); return request;
}
const readerOrigin = "https://private-reader.example.test";
const pair = sealedPair(readerOrigin).pair, other = releasePair("b", "b".repeat(40));
const embedded = () => { const { versionId, ...publicWorker } = pair.publicWorker;
  const { readerReceiptDigest: _runtimeReceipt, ...stable } = pair; return JSON.stringify({ ...stable, publicWorker }); };
it("keeps the disabled ingress and public slot handlers private before any binding access", async () => {
  const env = { PUBLIC_PAIR_INGRESS_ENABLED: "false", get CMS_API(): never { throw new Error("Touched authority"); } } as unknown as PublicReleaseIngressEnvironment;
  expect((await ingress.fetch(edgeRequest("https://dev-public.example.org/"), env)).status).toBe(404);
  const slot = new PublicReleaseSlotEntrypoint(createExecutionContext(), { PUBLIC_PAIR_SLOT_ENABLED: "false" } as PublicReleaseSlotEnvironment);
  await expect(slot.serve(edgeRequest("https://dev-public.example.org/"), { environment: "development", selector: releaseSelector(), readStartedAt: Date.now() }, pair)).rejects.toThrow();
});
it("checks the actual provider version and every stable embedded identity field", () => {
  const env = { PUBLIC_PAIR_IDENTITY_JSON: embedded(), PAIR_PRIVATE_ORIGIN: readerOrigin,
    PAIR_WORKER_VERSION: { id: pair.publicWorker.versionId } } as PublicReleaseSlotEnvironment;
  expect(assertEmbeddedPublicSlot(env, pair)).toEqual(pair);
  expect(() => assertEmbeddedPublicSlot(env, { ...pair, commitSha: other.commitSha })).toThrow();
  expect(() => assertEmbeddedPublicSlot({ ...env, PAIR_WORKER_VERSION: { id: other.publicWorker.versionId } }, pair)).toThrow();
  expect(() => assertEmbeddedPublicSlot(env, { ...pair, readerReceiptDigest: "f".repeat(64) })).toThrow();
  expect(() => assertEmbeddedPublicSlot({ ...env, PAIR_PRIVATE_ORIGIN: "https://other.example.test" }, pair)).toThrow();
});
it("runs the inert ingress-to-slot withdrawal path and private fresh proof in workerd", async () => {
  const selector = releaseSelector(), operationId = "O".repeat(20), snapshotDigest = "a".repeat(64);
  const getDecision = vi.fn(async (): Promise<PairServingDecision> => ({ kind: "decision", epoch: 1, pairId: pair.pairId, contentHead: selector.contentHead,
    path: "/contact/", authorityDigest: "b".repeat(64), targetProof: null,
    locator: { pairDigest: "c".repeat(64), identity: { schemaVersion: 2, pair: pairReference(pair), kind: "qualification", sourceOperationId: operationId,
      sourceVersion: 7, snapshotDigest, contextSequence: 0, inputManifestDigest: "d".repeat(64) }, claimDigest: "e".repeat(64),
      manifestDigest: selector.contentHead.manifestDigest, manifestBytes: 100 },
    route: { kind: "gone", family: "page", id: "contact", canonicalPath: "/contact/", operationId, sourceVersion: 7, snapshotDigest,
      ownerPath: "system/publicDeployment/noBuildPageOwners/contact", owner: { operationId, sourceVersion: 7, snapshotDigest } } }));
  const slot = new PublicReleaseSlotEntrypoint(createExecutionContext(), { PUBLIC_PAIR_SLOT_ENABLED: "true", PUBLIC_PAIR_IDENTITY_JSON: embedded(),
    PAIR_PRIVATE_ORIGIN: readerOrigin,
    PAIR_WORKER_VERSION: { id: pair.publicWorker.versionId }, PAIR_CONTENT: { get: vi.fn() }, CMS_API: { getReleaseDecision: getDecision } });
  const read = vi.fn(async () => ({ environment: "development" as const, selector, readStartedAt: Date.now() }));
  const env = { PUBLIC_PAIR_INGRESS_ENABLED: "true", PUBLIC_PAIR_IDENTITIES_JSON: JSON.stringify([pair, other]), PUBLIC_PAIR_BOOTSTRAP_ID: pair.pairId,
    CMS_API: { ...admission, getReleaseSelector: read }, PAIR_SLOT_OLD: { serve: (...args: Parameters<typeof slot.serve>) => slot.serve(...args) },
    PAIR_SLOT_NEW: { serve: vi.fn() }, PAIR_CONTENT: { get: vi.fn(), put: vi.fn() } } satisfies PublicReleaseIngressEnvironment;
  const request = edgeRequest("https://dev-public.example.org/contact/", { headers: { "x-njpbs-publication-operation": "forged" } });
  const response = await ingress.fetch(request, env);
  expect(response.status).toBe(410); expect(response.headers.has("x-njpbs-publication-operation")).toBe(false);
  const proof = new PublicReleaseIngressProofEntrypoint(createExecutionContext(), env);
  const empty = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array())), b => b.toString(16).padStart(2, "0")).join("");
  const proven = await proof.prove(request, empty, { status: 410 });
  expect(proven.status).toBe(410); expect(proven.headers.get("x-njpbs-publication-operation")).toBe(operationId);
  expect(proven.headers.get("x-njpbs-publication-origin")).toBe("template-dev-public"); expect(read).toHaveBeenCalledTimes(3);
  expect(env.PAIR_SLOT_NEW.serve).not.toHaveBeenCalled();
});
it("refuses post-commit capture of NEW while bootstrap is pinned to OLD", async () => {
  const selector = releaseSelector();
  const next = { ...selector, epoch: 2, selectedPair: selector.recoveryPair, recoveryPair: selector.selectedPair,
    activeCommitSha: other.commitSha, contentHead: { ...selector.contentHead, pairId: other.pairId } };
  const get = vi.fn(), put = vi.fn();
  const env = { PUBLIC_PAIR_INGRESS_ENABLED: "true", PUBLIC_PAIR_RECOVERY_CAPTURE_ENABLED: "true", PUBLIC_PAIR_BOOTSTRAP_ID: pair.pairId,
    PUBLIC_PAIR_IDENTITIES_JSON: JSON.stringify([pair, other]), PAIR_SLOT_OLD: { serve: vi.fn() }, PAIR_SLOT_NEW: { serve: vi.fn() },
    PAIR_CONTENT: { get, put }, CMS_API: { ...admission, getReleaseSelector: async () => ({ environment: "development" as const, selector: next, readStartedAt: Date.now() }) } };
  await expect(new PublicReleaseIngressProofEntrypoint(createExecutionContext(), env).captureRecovery()).rejects.toThrow();
  expect(get).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
});
it("uses fresh selected routing when a retained pair's claimed asset body is missing", async () => {
  const digest = async (value: unknown) => (await import("../../packages/content-core/src/public-release-routing")).releaseDigest(value);
  const members = [{ path: "/_astro/app.abcdef12.js", mime: "application/javascript; charset=utf-8", size: 1,
    sha256: "a".repeat(64), family: "clientAsset", source: "compiled", dynamic: false }];
  const old = { ...pair, codeAssetManifestDigest: await digest(JSON.stringify(members)) }, pairDigest = await digest(old);
  const prefix = `public-release-routing/development/pairs/${pairDigest}/`;
  const records: Record<string, unknown> = {
    [`${prefix}lifecycle-v1.json`]: { schemaVersion: 1, pairDigest, status: "retained", validUntil: Date.now() + 10_000 },
    [`${prefix}code-assets-v1.json`]: { schemaVersion: 1, pairDigest, codeAssetManifestDigest: old.codeAssetManifestDigest, members,
      view: { pairDigest, identity: { schemaVersion: 2, pair: pairReference(old), kind: "qualification", sourceOperationId: "baseline",
        sourceVersion: 1, snapshotDigest: "b".repeat(64), contextSequence: 0, inputManifestDigest: "c".repeat(64) },
        claimDigest: "d".repeat(64), manifestDigest: "e".repeat(64), manifestBytes: 500 } },
  };
  const get = vi.fn(async (key: string) => {
    if (!records[key]) return null;
    const bytes = new TextEncoder().encode(JSON.stringify(records[key]));
    return { size: bytes.length, body: new Blob([bytes]).stream(), etag: "1" };
  });
  const selector = releaseSelector(), next = { ...selector, epoch: 2, activeCommitSha: other.commitSha,
    selectedPair: selector.recoveryPair, recoveryPair: selector.selectedPair, contentHead: { ...selector.contentHead, pairId: other.pairId } };
  const oldServe = vi.fn(), newServe = vi.fn(async () => ({ kind: "response" as const, response: new Response("verified selected asset") }));
  const env = { PUBLIC_PAIR_INGRESS_ENABLED: "true", PUBLIC_PAIR_IDENTITIES_JSON: JSON.stringify([old, other]),
    PAIR_CONTENT: { get, put: vi.fn() }, CMS_API: { ...admission, getReleaseSelector: async () => ({ environment: "development" as const, selector: next, readStartedAt: Date.now() }) },
    PAIR_SLOT_OLD: { serve: oldServe }, PAIR_SLOT_NEW: { serve: newServe } };
  const response = await ingress.fetch(edgeRequest("https://dev-public.example.org/_astro/app.abcdef12.js"), env);
  expect(response.status).toBe(200); expect(await response.text()).toBe("verified selected asset");
  expect(get.mock.calls.some(([key]) => key.includes("/views/"))).toBe(true);
  expect(oldServe).not.toHaveBeenCalled(); expect(newServe).toHaveBeenCalledOnce();
});
it("keeps the retained asset lookup pinned to OLD during bootstrap", async () => {
  const get = vi.fn(async (_key: string) => null), selector = releaseSelector(), selected = vi.fn(async () => ({ kind: "response" as const, response: new Response("OLD asset") }));
  const env = { PUBLIC_PAIR_INGRESS_ENABLED: "true", PUBLIC_PAIR_BOOTSTRAP_ID: pair.pairId,
    PUBLIC_PAIR_IDENTITIES_JSON: JSON.stringify([pair, other]), PAIR_CONTENT: { get, put: vi.fn() },
    CMS_API: { ...admission, getReleaseSelector: async () => ({ environment: "development" as const, selector, readStartedAt: Date.now() }) },
    PAIR_SLOT_OLD: { serve: selected }, PAIR_SLOT_NEW: { serve: vi.fn() } };
  const response = await ingress.fetch(edgeRequest("https://dev-public.example.org/_astro/bootstrap.abcdef12.js"), env);
  expect(await response.text()).toBe("OLD asset");
  const otherDigest = await (await import("../../packages/content-core/src/public-release-routing")).releaseDigest(other);
  expect(get.mock.calls.some(([key]) => String(key).includes(otherDigest))).toBe(false);
  expect(env.PAIR_SLOT_NEW.serve).not.toHaveBeenCalled();
});

it.each(["epoch", "head"])("uses current warm authority and preserves the namespace floor across %s changes", async variant => {
  const { releaseDigest } = await import("../../packages/content-core/src/public-release-routing");
  const old = releaseSelector(), pairDigest = await releaseDigest(pair), at = Date.now(), prefix = `public-release-routing/development/pairs/${pairDigest}/`;
  const records: Record<string, unknown> = {
    "public-release-routing/development/committed-v2.json": { schemaVersion: 2, selection: { environment: "development", selector: old, readStartedAt: at },
      selectorDigest: await releaseDigest(old), capturedAt: at, validUntil: at + 10_000 },
    [`${prefix}lifecycle-v1.json`]: { schemaVersion: 1, pairDigest, status: "retained", validUntil: at + 10_000 },
    [`${prefix}namespace-v1.json`]: { schemaVersion: 1, pairDigest, revision: 1, validUntil: at + 10_000,
      routes: [{ path: "/contact/", state: "gone", canonicalPath: "/contact/" }] },
  };
  if (variant === "epoch") {
    const otherDigest=await releaseDigest(other),otherPrefix=`public-release-routing/development/pairs/${otherDigest}/`;
    records[`${otherPrefix}lifecycle-v1.json`]={schemaVersion:1,pairDigest:otherDigest,status:"retained",validUntil:at+10_000};
    // OLD may help only after the actual selected namespace is available and
    // explicitly allows fallback. Missing/refused selected authority is 503.
    records[`${otherPrefix}namespace-v1.json`]={schemaVersion:2,pairDigest:otherDigest,sourceDigest:"a".repeat(64),revision:1,validUntil:at+10_000,
      routes:[{path:"/contact/",state:"fallback",canonicalPath:"/contact/",body:null}]};
  }
  const get = async (key: string) => { const value = records[key]; if (!value) return null;
    const bytes = new TextEncoder().encode(JSON.stringify(value)); return { size: bytes.length, body: new Blob([bytes]).stream(), etag: "1" }; };
  const next = variant === "epoch" ? { ...old, epoch: 2, selectedPair: old.recoveryPair, recoveryPair: old.selectedPair,
    activeCommitSha: other.commitSha, contentHead: { ...old.contentHead, pairId: other.pairId } } :
    { ...old, contentHead: { ...old.contentHead, contextSequence: old.contentHead.contextSequence + 1 } };
  let failed = false;
  const serve = vi.fn(async () => { if (failed) throw new Error("Slot unavailable"); return { kind: "response" as const, response: new Response("current") }; });
  const env = { PUBLIC_PAIR_INGRESS_ENABLED: "true", PUBLIC_PAIR_IDENTITIES_JSON: JSON.stringify([pair, other]), PAIR_CONTENT: { get, put: vi.fn() },
    CMS_API: { ...admission, getReleaseSelector: async () => ({ environment: "development" as const, selector: next, readStartedAt: Date.now() }) },
    PAIR_SLOT_OLD: { serve }, PAIR_SLOT_NEW: { serve } };
  const request = edgeRequest("https://dev-public.example.org/contact/");
  expect(await (await ingress.fetch(request, env)).text()).toBe("current"); failed = true;
  // Retained OLD may supply a missing body, never replace the selected
  // live route with its own tombstone or override a newer known head.
  const degraded = await ingress.fetch(request, env);
  expect(degraded.status).toBe(503);
  expect(degraded.headers.has("x-njpbs-renderer-sha")).toBe(false);
  const cold = { ...env, CMS_API: { ...admission, getReleaseSelector: async (): Promise<never> => { throw new Error("Authority unavailable"); } } };
  expect((await ingress.fetch(request, cold)).status).toBe(410);
});
