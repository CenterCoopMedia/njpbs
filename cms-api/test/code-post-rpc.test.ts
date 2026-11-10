import { createExecutionContext, env as workerEnv } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { PublicContentEntrypoint, type CmsApiEnv } from "../src/index";

const rendererSha = "a".repeat(40), path = "/posts/example/";
const origin = "https://us-central1-njpbs-site-dev.cloudfunctions.net";
const environment = (): CmsApiEnv => ({ ...workerEnv, PREVIEW_RENDERER: undefined, CMS_EDGE_ORIGIN_SECRET: "fixture-edge",
  CMS_DEPLOYMENT_ENVIRONMENT: "development", FIREBASE_PROJECT_ID: "njpbs-site-dev",
  FUNCTIONS_ORIGIN: origin, ADMIN_ORIGIN: "https://dev-admin.example.org" });
const entry = (changes = {}) => new PublicContentEntrypoint(createExecutionContext(), { ...environment(), ...changes });
afterEach(() => vi.unstubAllGlobals());

it("relays only the fixed private code Post mode, path and renderer", async () => {
  vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
    expect(url).toBe(origin + "/cmsGetPublicPage");
    expect(options.redirect).toBe("manual");
    expect(options.method).toBe("POST");
    expect(new Headers(options.headers).get("x-njpbs-cms-edge")).toBe("fixture-edge");
    expect(JSON.parse(String(options.body))).toEqual({ mode: "no-build-code-post-v1", path, rendererSha, method: "HEAD" });
    return Response.json({ kind: "pass" });
  });
  expect(await entry().getNoBuildCodePost(path, rendererSha, "HEAD")).toEqual({ kind: "pass" });
});

it.each([{ FIREBASE_PROJECT_ID: "njpbs-site" }, { FUNCTIONS_ORIGIN: "https://foreign.example" },
  { ADMIN_ORIGIN: "https://admin.njpbs.org" }, { CMS_DEPLOYMENT_ENVIRONMENT: "production" }])(
  "refuses a mixed environment before a network request: %j", async mixed => {
    vi.stubGlobal("fetch", () => { throw new Error("Unexpected network request"); });
    await expect(entry(mixed).getNoBuildCodePost(path, rendererSha)).rejects.toThrow("request was refused");
  });

it.each(["/posts/example/?x=1", "/posts/%65xample/", "/posts/../", "/programs/example/"])(
  "refuses an invalid code Post path: %s", async invalid => {
    await expect(entry().getNoBuildCodePost(invalid, rendererSha)).rejects.toThrow("request was refused");
  });

it.each([{ kind: "unknown" }, { kind: "code-post", receipt: { path, rendererSha: "b".repeat(40) } },
  { kind: "code-post-alias", receipt: { path: "/posts/other/", rendererSha } }])(
  "refuses mixed or unknown replies: %j", async reply => {
    vi.stubGlobal("fetch", async () => Response.json(reply));
    await expect(entry().getNoBuildCodePost(path, rendererSha)).rejects.toThrow("Invalid code Post context");
  });
