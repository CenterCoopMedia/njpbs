import { createExecutionContext, env as workerEnv } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicContentEntrypoint, type CmsApiEnv, type NoBuildPostReply } from "../src/index";

const rendererSha = "a".repeat(40);
const functionsOrigin = "https://us-central1-njpbs-site-dev.cloudfunctions.net";
function environment(): CmsApiEnv {
  return { ...workerEnv, PREVIEW_RENDERER: undefined, CMS_EDGE_ORIGIN_SECRET: "fixture-edge", CMS_DEPLOYMENT_ENVIRONMENT: "development",
    FIREBASE_PROJECT_ID: "njpbs-site-dev", FUNCTIONS_ORIGIN: functionsOrigin, ADMIN_ORIGIN: "https://dev-admin.example.org" };
}
function entrypoint(env = environment()) {
  return new PublicContentEntrypoint(createExecutionContext(), env);
}
const receipt: NonNullable<NoBuildPostReply["receipt"]> = {
  schemaVersion: 1, postId: "post-one", operationId: "11111111111111111111", rendererSha,
  sourceVersion: 7, slug: "first-post", ownedSlugs: ["first-post"], generation: 2,
  visible: true, contextDigest: "b".repeat(64), admissionRevision: 3,
};
const catalog: NonNullable<NoBuildPostReply["catalog"]> = {
  schemaVersion: 1, rendererSha, generation: 2, contextDigest: "c".repeat(64), admissionRevision: 9,
  posts: [receipt, { ...receipt, postId: "post-two", operationId: "22222222222222222222", slug: "second-post",
    ownedSlugs: ["second-post"], sourceVersion: 4, admissionRevision: 8 }],
};
afterEach(() => vi.unstubAllGlobals());

describe("dev Post reader RPC boundary", () => {
  it("uses only the complete dev Function tuple and keeps the edge credential in the request header", async () => {
    const probe = { buildBatchId: "cms-fixture", versionId: "11111111-2222-3333-4444-555555555555" };
    const network = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${functionsOrigin}/cmsGetPublicPage`);
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("x-njpbs-cms-edge")).toBe("fixture-edge");
      // The Function gzips only when asked; the runtime decompresses the reply.
      expect(new Headers(init?.headers).get("accept-encoding")).toBe("gzip");
      expect(JSON.parse(String(init?.body))).toEqual({ mode: "no-build-post-v1", path: "/posts/first-post/",
        rendererSha, method: "HEAD", probe });
      return Response.json({ kind: "post", receipt });
    });
    vi.stubGlobal("fetch", network);
    expect(await entrypoint().getNoBuildPost("/posts/first-post/", rendererSha, "HEAD", probe)).toEqual({ kind: "post", receipt });
    expect(network).toHaveBeenCalledOnce();
  });

  it.each([
    { CMS_DEPLOYMENT_ENVIRONMENT: "production" }, { FIREBASE_PROJECT_ID: "njpbs-site" },
    { FUNCTIONS_ORIGIN: "https://us-central1-njpbs-site.cloudfunctions.net" }, { ADMIN_ORIGIN: "https://admin.njpbs.org" },
    { CMS_DEPLOYMENT_ENVIRONMENT: undefined }, { CMS_DEPLOYMENT_ENVIRONMENT: "staging" },
    { CMS_DEPLOYMENT_ENVIRONMENT: "production", FIREBASE_PROJECT_ID: "njpbs-site" },
  ])("refuses a mixed dev tuple before HTTP: %j", async mixed => {
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    await expect(entrypoint({ ...environment(), ...mixed }).getNoBuildPost("/posts/first-post/", rendererSha))
      .rejects.toThrow("Dev API target was refused");
    expect(network).not.toHaveBeenCalled();
  });

  it("retains the production RPC tuple", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      expect(url).toBe("https://us-central1-njpbs-site.cloudfunctions.net/cmsGetPublicPage");
      return Response.json({ kind: "receipts", receipt });
    }));
    const env = { ...environment(), CMS_DEPLOYMENT_ENVIRONMENT: "production", FIREBASE_PROJECT_ID: "njpbs-site",
      FUNCTIONS_ORIGIN: "https://us-central1-njpbs-site.cloudfunctions.net", ADMIN_ORIGIN: "https://admin.njpbs.org" };
    expect(await entrypoint(env).getNoBuildPost("/_publication.json", rendererSha)).toEqual({ kind: "receipts", receipt });
  });

  it("accepts the catalog revision without a scalar Post receipt", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ kind: "receipts", catalog })));
    expect(await entrypoint().getNoBuildPost("/_content-status.json", rendererSha)).toEqual({ kind: "receipts", catalog });
  });

  it.each([
    undefined, { ...catalog, schemaVersion: 2 }, { ...catalog, rendererSha: "d".repeat(40) },
    { ...catalog, admissionRevision: undefined }, { ...catalog, admissionRevision: 0 },
    { ...catalog, admissionRevision: 1.5 }, { ...catalog, generation: 0 },
    { ...catalog, contextDigest: "invalid" }, { ...catalog, posts: null },
  ])("refuses a missing or invalid catalog: %j", async invalid => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ kind: "receipts", catalog: invalid })));
    await expect(entrypoint().getNoBuildPost("/_publication.json", rendererSha)).rejects.toThrow("Invalid admission receipt");
  });

  it.each([undefined, 0, 1.5])("refuses a scalar receipt with invalid admission revision %s", async admissionRevision => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ kind: "receipts", receipt: { ...receipt, admissionRevision } })));
    await expect(entrypoint().getNoBuildPost("/_publication.json", rendererSha)).rejects.toThrow("Invalid admission receipt");
  });

  it("keeps a withdrawn route gone when its admission is absent", async () => {
    const withdrawn = { ...receipt, visible: false, admissionRevision: null };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ kind: "gone", receipt: withdrawn })));
    expect(await entrypoint().getNoBuildPost("/posts/first-post/", rendererSha)).toEqual({ kind: "gone", receipt: withdrawn });
  });
});
