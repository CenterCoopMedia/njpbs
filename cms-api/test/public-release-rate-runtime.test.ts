import { createExecutionContext, env as workerEnv } from "cloudflare:test";
import { runInDurableObject } from "cloudflare:test";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { PublicContentEntrypoint, type CmsApiEnv } from "../src/index";
import type { CmsRateLimiter } from "../src/rate-limiter";
import ingress, { PublicReleaseIngressProofEntrypoint, type PublicReleaseIngressEnvironment } from "../../workers/src/public-release-ingress-worker";
import { PublicReleaseSlotEntrypoint } from "../../workers/src/public-release-slot-worker";
import { sealedPair } from "../../tests/helpers/sealed-public-release-pair";
import { releasePair, releaseSelector } from "../../tests/helpers/private-public-release-pair.js";
import { writePublicReleasePairView } from "../../site/scripts/public-release-pair-view-storage";
import { pairReference } from "../../tests/helpers/private-public-release-pair.js";
import { releaseDigest } from "../../packages/content-core/src/public-release-routing";
import { routingPrefix } from "../../workers/src/public-release-code-assets";
import ratePolicy from "../../packages/content-core/src/public-release-rate-policy.json";

afterEach(() => vi.unstubAllGlobals());
function edgeRequest(path = "/contact/", method = "GET", cf = true) {
  const request = new Request(`https://dev-public.example.org${path}`, { method, headers: { "cf-connecting-ip": "203.0.113.29",
    "x-njpbs-proof": "true", "x-forwarded-for": "198.51.100.1", "x-njpbs-rate-allowed": "true" } });
  if (cf) Object.defineProperty(request, "cf", { value: { country: "US" } });
  return request;
}
function fixture(changes: Partial<CmsApiEnv> = {}) {
  const prefix = randomUUID(), selector = releaseSelector(), pair = sealedPair("https://reader.example.test").pair;
  const namespace = workerEnv.RATE_LIMITERS as unknown as DurableObjectNamespace<CmsRateLimiter>;
  const binding = { getByName: (name: string) => namespace.getByName(`${prefix}:${name}`) };
  const env = { ...workerEnv, RATE_LIMITERS: binding, PUBLIC_RELEASE_READERS_ENABLED: "true", PUBLIC_RELEASE_RATE_CONTROLS_ENABLED: "true",
    CMS_EDGE_ORIGIN_SECRET: "fixture-edge", CMS_DEPLOYMENT_ENVIRONMENT: "development", FIREBASE_PROJECT_ID: "njpbs-site-dev",
    FUNCTIONS_ORIGIN: "https://us-central1-njpbs-site-dev.cloudfunctions.net", ADMIN_ORIGIN: "https://dev-admin.example.org", ...changes } as CmsApiEnv;
  const cms = new PublicContentEntrypoint(createExecutionContext(), env);
  const api = { consumeReleaseAuthority: cms.consumeReleaseAuthority.bind(cms), consumeReleaseViewer: cms.consumeReleaseViewer.bind(cms), consumeReleaseProof: cms.consumeReleaseProof.bind(cms),
    getReleaseSelector: vi.fn(cms.getReleaseSelector.bind(cms)), getReleaseDecision: vi.fn(cms.getReleaseDecision.bind(cms)) };
  const { versionId, ...publicWorker } = pair.publicWorker, { readerReceiptDigest: _receipt, ...stable } = pair;
  const get = vi.fn(async (_key: string): Promise<{ size: number; customMetadata?: Record<string, string>; etag: string; body: ReadableStream<Uint8Array> } | null> => null), put = vi.fn();
  const slot = new PublicReleaseSlotEntrypoint(createExecutionContext(), { PUBLIC_PAIR_SLOT_ENABLED: "true",
    PUBLIC_PAIR_IDENTITY_JSON: JSON.stringify({ ...stable, publicWorker }), PAIR_PRIVATE_ORIGIN: "https://reader.example.test",
    PAIR_WORKER_VERSION: { id: versionId }, CMS_API: api, PAIR_CONTENT: { get } });
  const ingressEnv: PublicReleaseIngressEnvironment = { PUBLIC_PAIR_INGRESS_ENABLED: "true", PUBLIC_PAIR_BOOTSTRAP_ID: pair.pairId,
    PUBLIC_PAIR_IDENTITIES_JSON: JSON.stringify([pair, releasePair("b", "b".repeat(40))]), CMS_API: api,
    PAIR_CONTENT: { get, put }, PAIR_SLOT_OLD: slot, PAIR_SLOT_NEW: { serve: vi.fn() } };
  const modes: string[] = [], reselect = { once: false, decisions: 0 };
  const fetcher = vi.fn(async (_url: unknown, options: RequestInit) => {
    const body = JSON.parse(String(options.body)); modes.push(body.mode);
    if (body.mode === "release-selector-v2") return Response.json({ environment: "development", selector, readStartedAt: Date.now() });
    if (body.mode !== "release-decision-v2") throw new Error("Unexpected Functions mode");
    reselect.decisions++;
    return Response.json({ kind: "decision", pairId: pair.pairId, epoch: selector.epoch, path: body.path,
      authorityDigest: reselect.once && reselect.decisions === 1 ? "a".repeat(64) : "b".repeat(64), contentHead: selector.contentHead, locator: { manifestDigest: selector.contentHead.manifestDigest },
      route: { kind: "gone", operationId: "O".repeat(20), sourceVersion: 7, snapshotDigest: "a".repeat(64) } });
  });
  vi.stubGlobal("fetch", fetcher);
  const stub = (key: string, subject = "all") => binding.getByName(`public-release-v1:njpbs-site-dev:${key}:${createHash("sha256").update(subject).digest("hex")}`);
  return { env, ingressEnv, cms, api, get, put, fetcher, modes, reselect, stub, pair, selector };
}
async function exhaust(stub: DurableObjectStub<CmsRateLimiter>) {
  await runInDurableObject(stub, (_owner, state) => state.storage.sql.exec(
    "INSERT INTO token_bucket(singleton,tokens,updated_at) VALUES(1,0,?) ON CONFLICT(singleton) DO UPDATE SET tokens=0,updated_at=excluded.updated_at", Date.now() + 60_000));
}

it.each(["missing", "disabled", "binding", "error", "ip", "forged-identity"])(
  "refuses public %s admission before all selector/slot/R2/Functions work", async variant => {
    const changes = variant === "missing" ? { PUBLIC_RELEASE_RATE_CONTROLS_ENABLED: undefined } :
      variant === "disabled" ? { PUBLIC_RELEASE_RATE_CONTROLS_ENABLED: "false" } : variant === "binding" ? { RATE_LIMITERS: undefined } : {};
    const f = fixture(changes);
    if (variant === "error") f.env.RATE_LIMITERS = { getByName: () => { throw new Error("Unavailable"); } } as unknown as CmsApiEnv["RATE_LIMITERS"];
    for (const path of ["/contact/", "/_astro/app.abcdef12.js"]) {
      // Each path independently observes exhaustion. The real owner advances
      // its stored clock even when refusing the preceding request.
      if (variant === "ip") await exhaust(f.stub("viewerIp", "203.0.113.29"));
      const response = await ingress.fetch(edgeRequest(path, "GET", variant !== "forged-identity"), f.ingressEnv);
      expect(response.status).toBe(variant === "ip" ? 429 : 503);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(f.api.getReleaseSelector).not.toHaveBeenCalled(); expect(f.api.getReleaseDecision).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled(); expect(f.put).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  });
it.each(["selector", "decision"])("refuses an exhausted private %s RPC before forwarding to Functions", async mode => {
  const f = fixture(); await exhaust(f.stub("rpc"));
  await expect(mode === "selector" ? f.cms.getReleaseSelector() :
    f.cms.getReleaseDecision({ environment: "development", selector: f.selector, readStartedAt: Date.now() }, f.pair, "/contact/"))
    .rejects.toThrow("admission");
  expect(f.fetcher).not.toHaveBeenCalled();
});
it("reports malformed CMS configuration before any downstream work", async () => {
  const f = fixture({ FUNCTIONS_ORIGIN: "https://foreign.invalid" });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {}), at = Date.now() + 120_000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(at);
  try {
    expect(await f.cms.consumeReleaseViewer("203.0.113.29", 1_000)).toEqual({ status: 503, retryAfterSeconds: 1 });
    expect(warn).toHaveBeenCalledWith("Public release admission refused", expect.objectContaining({ component: "viewer", reason: "malformed", status: 503 }));
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.get).not.toHaveBeenCalled();
  } finally { clock.mockRestore(); warn.mockRestore(); }
});
it("preserves GET/HEAD withdrawal rechecks and private proofs with isolated admission", async () => {
  const f = fixture();
  for (const method of ["GET", "HEAD"]) {
    const response = await ingress.fetch(edgeRequest("/contact/", method), f.ingressEnv);
    expect(response.status).toBe(410); expect(await response.text()).toBe("");
    expect(response.headers.has("x-njpbs-publication-operation")).toBe(false);
  }
  expect(f.modes.filter(mode => mode === "release-decision-v2")).toHaveLength(4);
  // Anonymous exhaustion cannot spend or select private proof capacity.
  await exhaust(f.stub("rpc")); await exhaust(f.stub("viewerAggregate")); await exhaust(f.stub("viewerIp", "203.0.113.29"));
  const proof = new PublicReleaseIngressProofEntrypoint(createExecutionContext(), f.ingressEnv);
  const emptyDigest = createHash("sha256").update("").digest("hex");
  const response = await proof.prove(edgeRequest("/contact/", "GET", false), emptyDigest, { status: 410 });
  expect(response.status).toBe(410); expect(response.headers.get("x-njpbs-publication-operation")).toBe("O".repeat(20));
  expect(f.modes.filter(mode => mode === "release-decision-v2")).toHaveLength(6);
  expect(f.get).not.toHaveBeenCalled();
});
it("the RPC burst/refill covers actual cold-selector and reselection decision fan-out", async () => {
  const f = fixture(); f.reselect.once = true;
  expect((await ingress.fetch(edgeRequest(), f.ingressEnv)).status).toBe(410);
  expect(f.modes).toEqual(["release-selector-v2", "release-decision-v2", "release-decision-v2",
    "release-selector-v2", "release-decision-v2", "release-decision-v2"]);
  expect(ratePolicy.rpc.capacity).toBeGreaterThanOrEqual(ratePolicy.viewerAggregate.capacity * f.modes.length);
  expect(ratePolicy.rpc.refillPerSecond).toBeGreaterThanOrEqual(ratePolicy.viewerAggregate.refillPerSecond * f.modes.length);
});
it("slow viewer and selector admission cannot start Functions after the ingress deadline", async () => {
  const f = fixture(); let at = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => at);
  // The fake is only the Durable Object transport boundary. Actual ingress,
  // router and CMS entrypoint code decide whether Functions may start.
  f.env.RATE_LIMITERS = { getByName: (name: string) => ({
    consume: async () => {
      if (name.includes(":viewerIp:")) at = 2_000;
      if (name.includes(":rpc:")) at = 3_500;
      return { allowed: true, remaining: 1, retryAfterSeconds: 0 };
    },
  }) } as unknown as CmsApiEnv["RATE_LIMITERS"];
  try {
    expect((await ingress.fetch(edgeRequest(), f.ingressEnv)).status).toBe(503);
    expect(f.api.getReleaseSelector).toHaveBeenCalledOnce();
    expect(f.api.getReleaseSelector.mock.calls[0][0]).toBeLessThanOrEqual(1_000);
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.api.getReleaseDecision).not.toHaveBeenCalled(); expect(f.get).not.toHaveBeenCalled();
  } finally { clock.mockRestore(); }
});
it("slot rechecks inherit the remaining request budget after earlier decision I/O", async () => {
  const f = fixture(); let at = 0, quotaCalls = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => at), network = f.fetcher.getMockImplementation()!;
  f.env.RATE_LIMITERS = { getByName: (name: string) => ({
    consume: async () => {
      if (name.includes(":rpc:")) { quotaCalls++; at = [1_000, 1_500, 3_300][quotaCalls - 1]; }
      return { allowed: true, remaining: 1, retryAfterSeconds: 0 };
    },
  }) } as unknown as CmsApiEnv["RATE_LIMITERS"];
  f.fetcher.mockImplementation(async (url, options) => {
    const reply = await network(url, options);
    if (JSON.parse(String(options.body)).mode === "release-decision-v2") at = 2_100;
    return reply;
  });
  try {
    expect((await ingress.fetch(edgeRequest(), f.ingressEnv)).status).toBe(503);
    expect(f.api.getReleaseDecision).toHaveBeenCalledTimes(2);
    expect(f.api.getReleaseDecision.mock.calls[1][3]).toBeLessThanOrEqual(150);
    expect(f.modes).toEqual(["release-selector-v2", "release-decision-v2"]);
    expect(f.get).not.toHaveBeenCalled();
  } finally { clock.mockRestore(); }
});

// External R2 transport only; actual native view writer, ingress, recovery and
// withdrawal readers verify every identity, digest and namespace below.
function retainedStore(f: ReturnType<typeof fixture>) {
  const objects = new Map<string, { bytes: Uint8Array; customMetadata: Record<string, string> }>();
  const put = async (key: string, bytes: Uint8Array, options: { customMetadata: Record<string, string> }) => {
    objects.set(key, { bytes: new Uint8Array(bytes), customMetadata: options.customMetadata }); return { etag: "1" };
  };
  f.get.mockImplementation(async (key: string) => {
    const row = objects.get(key);
    return row ? { size: row.bytes.length, customMetadata: row.customMetadata, etag: "1", body: new Blob([new Uint8Array(row.bytes)]).stream() } : null;
  });
  const json = (key: string, value: unknown) => put(key, new TextEncoder().encode(JSON.stringify(value)), { customMetadata: {} });
  return { objects, store: { get: f.get, put }, json };
}
it.each(["viewerAggregate", "rpc"])("exhausted %s cannot block verified retained assets", async quota => {
  const f = fixture(), r = retainedStore(f), body = new TextEncoder().encode("export const current = true;");
  const members = [{ path: "/_astro/app.abcdef12.js", mime: "application/javascript; charset=utf-8", size: body.length,
    sha256: createHash("sha256").update(body).digest("hex"), family: "clientAsset", source: "compiled", dynamic: false }];
  const pair = { ...f.pair, codeAssetManifestDigest: await releaseDigest(JSON.stringify(members)) };
  const pairDigest = await releaseDigest(pair), identity = { schemaVersion: 2 as const, pair: pairReference(pair), kind: "qualification" as const,
    sourceOperationId: "baseline", sourceVersion: 1, snapshotDigest: "a".repeat(64), contextSequence: 0, inputManifestDigest: "b".repeat(64) };
  const claimDigest = "c".repeat(64);
  const view = await writePublicReleasePairView({ store: r.store, pair, identity, claimDigest,
    cursor: { baselineDigest: "d".repeat(64), sequence: 0, lastDigest: "d".repeat(64) },
    outputs: (async function* () { yield { path: members[0].path, status: 200 as const, bytes: body,
      headers: { "cache-control": "no-store", "content-type": members[0].mime, "x-njpbs-renderer-sha": pair.commitSha } }; })() });
  await r.json(`${routingPrefix(pair)}code-assets-v1.json`, { schemaVersion: 1, pairDigest, codeAssetManifestDigest: pair.codeAssetManifestDigest,
    view: { pairDigest, identity, claimDigest, manifestDigest: view.manifestDigest, manifestBytes: view.manifestBytes }, members });
  await r.json(`${routingPrefix(pair)}lifecycle-v1.json`, { schemaVersion: 1, pairDigest, status: "retained", validUntil: Date.now() + 10_000 });
  f.ingressEnv.PUBLIC_PAIR_BOOTSTRAP_ID = pair.pairId;
  f.ingressEnv.PUBLIC_PAIR_IDENTITIES_JSON = JSON.stringify([pair, releasePair("b", "b".repeat(40))]);
  await exhaust(f.stub(quota));
  const response = await ingress.fetch(edgeRequest(members[0].path), f.ingressEnv);
  expect(response.status).toBe(200); expect(await response.text()).toBe("export const current = true;");
  expect(f.api.getReleaseSelector).not.toHaveBeenCalled(); expect(f.api.getReleaseDecision).not.toHaveBeenCalled();
  expect(f.fetcher).not.toHaveBeenCalled(); expect(f.get).toHaveBeenCalled(); expect(f.put).not.toHaveBeenCalled();
});
it.each(["viewerAggregate", "rpc"])("exhausted %s keeps current withdrawal recovery and refuses a missing namespace", async quota => {
  const f = fixture(), r = retainedStore(f), at = Date.now(), pairDigest = await releaseDigest(f.pair);
  await r.json("public-release-routing/development/committed-v2.json", { schemaVersion: 2,
    selection: { environment: "development", selector: f.selector, readStartedAt: at }, selectorDigest: await releaseDigest(f.selector),
    capturedAt: at, validUntil: at + 10_000 });
  await r.json(`${routingPrefix(f.pair)}lifecycle-v1.json`, { schemaVersion: 1, pairDigest, status: "retained", validUntil: at + 10_000 });
  const namespace = `${routingPrefix(f.pair)}namespace-v1.json`;
  await r.json(namespace, { schemaVersion: 1, pairDigest, revision: 1, validUntil: at + 10_000,
    routes: [{ path: "/contact/", state: "gone", canonicalPath: "/contact/" }] });
  await exhaust(f.stub(quota));
  const response = await ingress.fetch(edgeRequest(), f.ingressEnv);
  expect(response.status).toBe(410); expect(await response.text()).toBe("");
  expect(response.headers.get("publication-refresh")).toBe("pending");
  expect(response.headers.has("x-njpbs-publication-operation")).toBe(false);
  expect(f.api.getReleaseDecision).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  if (quota === "viewerAggregate") expect(f.api.getReleaseSelector).not.toHaveBeenCalled();
  r.objects.delete(namespace); await exhaust(f.stub(quota));
  expect((await ingress.fetch(edgeRequest(), f.ingressEnv)).status).toBe(503);
  expect(f.fetcher).not.toHaveBeenCalled(); expect(f.put).not.toHaveBeenCalled();
});
