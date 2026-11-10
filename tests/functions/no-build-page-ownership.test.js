import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
const require = createRequire(import.meta.url);
const ownership = require("../../functions/lib/no-build-page-ownership.js");
const recovery = require("../../functions/lib/no-build-page-recovery.js");
const { withinDeadline } = require("../../functions/lib/no-build-post-recovery.js");
const compatibility = require("../../functions/lib/data-figure-compatibility.js");
const sha = "a".repeat(40);
const operationId = "A".repeat(20);
const owner = overrides => ({ schemaVersion: 1, pageId: "contact", rendererSha: sha,
  servingEnabled: true, generation: 3, operationId, sourceVersion: 2,
  path: "/contact/", ownedPaths: ["/contact/", "/contact-us/"], visible: true,
  snapshotDigest: "b".repeat(64), runtime: { owner: "cloudflare", release: sha }, ...overrides });

it.each(["r2-last-good", "assets"])("bounds a permanently pending %s Page by the proof deadline", async source => {
  let reads = 0, cancelled = false;
  await expect(withinDeadline(30, signal => recovery.readPublicPageReceipt({ state: owner({ ownedPaths: ["/contact/"] }),
    target: { origin: "https://example.test" }, headers: new Headers(), signal, fetchPublic: async () => {
      reads++;
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: {
        "x-njpbs-content-source": source, "x-njpbs-publication-refresh": "pending", "retry-after": "1" } });
    } }))).rejects.toThrow("Public Post confirmation timed out");
  expect(reads).toBe(1);
  expect(cancelled).toBe(true);
});

describe("retained Page owner contract", () => {
  it("retains aliases and tombstones when a compatible capability advances", () => {
    const state = owner({ visible: false });
    const capability = { schemaVersion: 1, rendererSha: "c".repeat(40), servingEnabled: true, generation: 8 };
    expect(ownership.effectiveNoBuildPageState(state, capability)).toEqual({ ...state,
      rendererSha: capability.rendererSha, generation: 8 });
    expect(state.rendererSha).toBe(sha);
  });
  it("keeps data figure capability optional and accepts only renderer version 1", () => {
    const legacy = { schemaVersion: 1, rendererSha: sha, servingEnabled: true, generation: 8 };
    const current = { ...legacy, dataFigureVersion: 1 };
    expect(compatibility.supportsDataFigures(ownership.validateNoBuildPageCapability(legacy))).toBe(false);
    expect(compatibility.supportsDataFigures(ownership.validateNoBuildPageCapability(current))).toBe(true);
    expect(() => ownership.validateNoBuildPageCapability({ ...legacy, dataFigureVersion: 2 })).toThrow();
  });
  it("validates Home's two routes in the shared owner", () => {
    expect(ownership.validateNoBuildPageState(owner({ pageId: "home", path: "/",
      ownedPaths: ["/", "/_home-sources.json"] })).pageId).toBe("home");
  });
  it.each([
    { pageId: "unknown" }, { pageId: ["contact"], path: "/renamed/", ownedPaths: ["/renamed/"] },
    { operationId: "bad" }, { operationId: 1e19 }, { sourceVersion: 0 },
    { generation: Number.MAX_SAFE_INTEGER + 1 }, { snapshotDigest: "bad" },
    { ownedPaths: ["/contact/", "/contact/"] }, { ownedPaths: ["/about/"] },
    { ownedPaths: ["/contact/", "/posts/story/"] }, { path: "/authors/" },
    { ownedPaths: ["/contact/", "/../contact/"] }, { runtime: { owner: "node-compute", release: sha } },
    { pageId: "home", path: "/", ownedPaths: ["/"] },
  ])("refuses malformed or cross-family ownership %j", overrides => {
    expect(() => ownership.validateNoBuildPageState(owner(overrides))).toThrow();
  });
  it("requires an exact candidate Page contract and source", () => {
    const contract = { schemaVersion: 1, rendererSha: sha, enabled: true, authoritative: true };
    expect(ownership.candidateNoBuildPageContract(contract)).toEqual(contract);
    expect(ownership.candidateNoBuildPageContract(undefined)).toBeNull();
    for (const invalid of [{ ...contract, extra: true }, { ...contract, authoritative: false },
      { ...contract, rendererSha: "bad" }, { ...contract, schemaVersion: 2 }]) {
      expect(() => ownership.candidateNoBuildPageContract(invalid)).toThrow();
    }
    const withDataFigures = { ...contract, dataFigureVersion: 1 };
    expect(ownership.candidateNoBuildPageContract(withDataFigures)).toEqual(withDataFigures);
    expect(() => ownership.candidateNoBuildPageContract({ ...contract, dataFigureVersion: 2 })).toThrow();
  });
  it("binds an optional data figure digest to the Page owner snapshot", () => {
    expect(ownership.validateNoBuildPageState(owner({ datasetFiguresDigest: "c".repeat(64) })).datasetFiguresDigest)
      .toBe("c".repeat(64));
    expect(() => ownership.validateNoBuildPageState(owner({ datasetFiguresDigest: "bad" }))).toThrow();
  });
});

it("requires exact optional data figure receipt parity while legacy Page receipts remain valid", async () => {
  const datasetFiguresDigest = "c".repeat(64);
  const state = owner({ visible: false, ownedPaths: ["/contact/"], datasetFiguresDigest });
  const response = digest => new Response(null, { status: 410, headers: {
    "cache-control": "no-store",
    "x-njpbs-content-source": "cms-page-no-build",
    "x-njpbs-publication-operation": state.operationId,
    "x-njpbs-source-version": String(state.sourceVersion),
    "x-njpbs-snapshot-sha256": state.snapshotDigest,
    ...(digest ? { "x-njpbs-dataset-figures-sha256": digest } : {}),
    "x-njpbs-renderer-sha": state.rendererSha,
    "x-njpbs-context-sha256": "d".repeat(64),
    "x-njpbs-admission-revision": "unavailable",
    "x-njpbs-durable-withdrawal-operation": state.operationId,
    "x-njpbs-withdrawal-revision": String(state.generation),
  } });
  const input = { state, target: { origin: "https://example.test" }, headers: new Headers(),
    signal: new AbortController().signal };
  await expect(recovery.readPublicPageReceipt({ ...input, fetchPublic: async () => response(datasetFiguresDigest) }))
    .resolves.toMatchObject({ datasetFiguresDigest });
  await expect(recovery.readPublicPageReceipt({ ...input, fetchPublic: async () => response() }))
    .rejects.toThrow("Public Page receipt is unavailable");
  const legacy = { ...state };
  delete legacy.datasetFiguresDigest;
  await expect(recovery.readPublicPageReceipt({ ...input, state: legacy, fetchPublic: async () => response() }))
    .resolves.not.toHaveProperty("datasetFiguresDigest");
});

it("seals the same immutable snapshot across Firestore map ordering", () => {
  expect(ownership.digest({ metadata: { title: "Contact", slug: "contact" }, blocks: [] }))
    .toBe(ownership.digest({ blocks: [], metadata: { slug: "contact", title: "Contact" } }));
});

it("accepts only the exact legacy meeting alias with a separately proved canonical Page", async () => {
  const state = owner({ pageId: "public-meetings", path: "/meeting-notices/",
    ownedPaths: ["/public-meetings/", "/meeting-notices/"] });
  const html = "<!doctype html><html>Public meetings</html>";
  const { createHash } = require("node:crypto");
  const canonical = () => new Response(html, { headers: {
    "cache-control": "no-store", "content-type": "text/html; charset=utf-8", "x-njpbs-content-source": "cms-page-no-build",
    "x-njpbs-publication-operation": operationId, "x-njpbs-source-version": "2", "x-njpbs-snapshot-sha256": state.snapshotDigest,
    "x-njpbs-renderer-sha": sha, "x-njpbs-context-sha256": "d".repeat(64), "x-njpbs-admission-revision": "7",
    "x-njpbs-input-sha256": "e".repeat(64), "x-njpbs-record-source-sha256": "f".repeat(64),
    "x-njpbs-html-sha256": createHash("sha256").update(html).digest("hex") } });
  const target = { origin: "https://njpbs.org" };
  const read = (redirect, currentState = state, response = canonical) => recovery.readPublicPageReceipt({
    state: currentState, target, headers: new Headers(), signal: new AbortController().signal,
    fetchPublic: async url => new URL(url).pathname === "/public-meetings/" ? new Response(null, { status: 301, headers: redirect }) : response() });
  const redirect = { location: "https://njpbs.org/meeting-notices/" };
  await expect(read(redirect)).resolves.toMatchObject({ rendererSha: sha, routes: [
    { path: "/public-meetings/", status: 301, location: "/meeting-notices/", legacyRedirect: true },
    { path: "/meeting-notices/", status: 200 } ] });
  for (const invalid of [{ location: "https://example.org/meeting-notices/" }, { location: "/wrong/" },
    { location: "/meeting-notices/?stale=1" }, { location: "/meeting-notices/#stale" },
    { ...redirect, "x-njpbs-content-source": "assets" }, { ...redirect, "x-njpbs-source-version": "1" }]) {
    await expect(read(invalid)).rejects.toThrow();
  }
  await expect(read(redirect, { ...state, visible: false })).rejects.toThrow();
  await expect(read(redirect, { ...state, ownedPaths: ["/public-meetings/"] })).rejects.toThrow();
  await expect(read(redirect, state, () => new Response("stale Assets"))).rejects.toThrow();
});

it("keeps Home catalog JSON at 2 MiB while Page HTML allows 4 MiB", async () => {
  const { createHash } = require("node:crypto");
  const state = owner({ pageId: "home", path: "/", ownedPaths: ["/", "/_home-sources.json"] });
  const json = "{}" + " ".repeat(2 * 1024 * 1024 - 1);
  await expect(recovery.readPublicPageReceipt({ state, target: { origin: "https://njpbs.org" },
    headers: new Headers(), signal: new AbortController().signal, fetchPublic: async url => {
      const catalog = new URL(url).pathname === "/_home-sources.json";
      const body = catalog ? json : "<!doctype html><html>Home</html>";
      return new Response(body, { headers: { "cache-control": "no-store",
        "content-type": catalog ? "application/json" : "text/html", "x-njpbs-content-source": "cms-page-no-build",
        "x-njpbs-publication-operation": operationId, "x-njpbs-source-version": "2", "x-njpbs-snapshot-sha256": state.snapshotDigest,
        "x-njpbs-renderer-sha": sha, "x-njpbs-context-sha256": "d".repeat(64), "x-njpbs-admission-revision": "7",
        "x-njpbs-home-refresh-revision": "0", "x-njpbs-input-sha256": "e".repeat(64), "x-njpbs-record-source-sha256": "f".repeat(64),
        "x-njpbs-html-sha256": createHash("sha256").update(body).digest("hex") } });
    } })).rejects.toThrow("Public Post bytes exceed their bound");
});
