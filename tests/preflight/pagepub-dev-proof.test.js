import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { proveDevPagePublication } from "../../scripts/pagepub-dev-proof.mjs";

const sha = "a".repeat(40), contextDigest = "b".repeat(64), snapshotDigest = "c".repeat(64);
const operationId = "A".repeat(20);
const state = { schemaVersion: 1, pageId: "contact", path: "/contact/", ownedPaths: ["/contact/", "/former-contact/"],
  rendererSha: sha, servingEnabled: true, generation: 2, operationId, sourceVersion: 7, snapshotDigest, visible: true,
  runtime: { owner: "cloudflare", release: sha } };
const authority = { pageId: state.pageId, sourceVersion: 7, path: state.path, ownedPaths: state.ownedPaths, visible: true,
  operationId, snapshotDigest, rendererSha: sha, contextDigest, admissionRevision: 3 };
const publication = { queueStatus: "success", publicUpdatePending: false, publishedSourceVersion: 7,
  publiclyVisible: true, publicSourceVersion: 7, pageReceipt: { operationId, sourceVersion: 7, visible: true } };
const baseline = { generation: 1, buildBatchId: "baseline", runAttempts: [] };
function options(overrides = {}) {
  return { state, rendererSha: sha, contextDigest, admissionRevision: 3,
    readAuthority: async () => authority, readBaseline: async () => baseline, readPublication: async () => publication,
    fetchPublic: async (url, options) => {
      expect(new URL(url).origin).toBe("https://dev-public.example.org");
      expect(options.redirect).toBe("manual");
      const body = "<!doctype html><html><body>Fixture</body></html>";
      return new Response(url.includes("former") ? null : body, { status: url.includes("former") ? 308 : 200,
        headers: { "cache-control": "no-store", "content-type": "text/html; charset=utf-8", "location": "/contact/", "x-njpbs-content-source": "cms-page-no-build",
          "x-njpbs-publication-operation": operationId, "x-njpbs-source-version": "7", "x-njpbs-snapshot-sha256": snapshotDigest,
          "x-njpbs-renderer-sha": sha, "x-njpbs-context-sha256": contextDigest, "x-njpbs-admission-revision": "3",
          "x-njpbs-input-sha256": "d".repeat(64), "x-njpbs-record-source-sha256": createHash("sha256").update("[]").digest("hex"),
          "x-njpbs-html-sha256": createHash("sha256").update(body).digest("hex") } });
    }, ...overrides };
}
it("proves all retained dev paths and CMS completion with no full build, retaining no bodies or headers", async () => {
  const receipt = await proveDevPagePublication(options());
  expect(receipt).toMatchObject({ result: "pass", noFullBuild: true, routes: [{ path: "/contact/", status: 200 }, { path: "/former-contact/", status: 308 }] });
  expect(JSON.stringify(receipt)).not.toContain("Fixture");
});
it.each([
  { readPublication: async () => ({ ...publication, pageReceipt: { ...publication.pageReceipt, operationId: "B".repeat(20) } }) },
  { readPublication: async () => ({ ...publication, queueStatus: "pending" }) },
  { readPublication: async () => ({ ...publication, publicUpdatePending: true }) },
  { readAuthority: async () => ({ ...authority, rendererSha: "d".repeat(40) }) },
  { readAuthority: async () => ({ ...authority, ownedPaths: [...authority.ownedPaths, "/omitted-alias/"] }) },
])("refuses incomplete or different public/CMS operation identity", async override => {
  await expect(proveDevPagePublication(options(override))).rejects.toThrow("page_proof_not_confirmed");
});
it("refuses a changed context and a full-build rerun during proof", async () => {
  let reads = 0;
  await expect(proveDevPagePublication(options({ readAuthority: async () => ++reads === 1 ? authority : { ...authority, contextDigest: "d".repeat(64) } })))
    .rejects.toThrow("page_proof_not_confirmed");
  reads = 0;
  await expect(proveDevPagePublication(options({ readBaseline: async () => ++reads === 1 ? baseline : { ...baseline, runAttempts: ["100:2"] } })))
    .rejects.toThrow("full_build_observed");
});
it("refuses a metadata body even when its checksum and operation headers match", async () => {
  const real = options().fetchPublic;
  await expect(proveDevPagePublication(options({ fetchPublic: async (url, config) => {
    const response = await real(url, config);
    if (url.includes("former")) return response;
    const body = JSON.stringify({ sourceVersion: 7 });
    response.headers.set("x-njpbs-html-sha256", createHash("sha256").update(body).digest("hex"));
    return new Response(body, { headers: response.headers });
  } }))).rejects.toThrow("document is incomplete");
});
it("proves the supported retained-route bound with bounded parallel public reads", async () => {
  const paths = ["/contact/", ...Array.from({ length: 100 }, (_, index) => `/former-${index}/`)];
  let active = 0, peak = 0;
  const response = options().fetchPublic;
  const receipt = await proveDevPagePublication(options({ state: { ...state, ownedPaths: paths },
    readAuthority: async () => ({ ...authority, ownedPaths: paths }),
    fetchPublic: async (url, config) => {
      active++; peak = Math.max(peak, active);
      try { await Promise.resolve(); return await response(url, config); } finally { active--; }
    } }));
  expect(receipt.routes).toHaveLength(101);
  expect(peak).toBeLessThanOrEqual(8);
});
