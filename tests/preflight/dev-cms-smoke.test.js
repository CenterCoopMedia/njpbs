import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEPLOYED_FUNCTION_NAMES, runCmsFunctionSmoke, runDevCmsFunctionSmoke } from "../../scripts/smoke-cms-functions.mjs";

beforeAll(() => vi.stubEnv("CMS_DEV_ACCESS_ORIGIN", "https://fixture.cloudflareaccess.com"));
afterAll(() => vi.unstubAllEnvs());

const { DEV_FUNCTIONS } = createRequire(import.meta.url)("../../functions/dev-manifest.js");

async function devResponse(url, init = {}) {
  const { origin, pathname } = new URL(url);
  if (origin === "https://dev-admin.example.org") return new Response(null, { status: 302, headers: {
    location: "https://fixture.cloudflareaccess.com/cdn-cgi/access/login/dev-admin.example.org",
  } });
  if (origin === "https://us-central1-njpbs-site-dev.cloudfunctions.net") return new Response(null, { status: 403 });
  expect(origin).toBe("https://dev-api.example.org");
  if (pathname === "/health") return new Response(null, { status: 200 });
  if (init.method === "OPTIONS") return new Response(null, { status: 204, headers: {
    "access-control-allow-origin": "https://dev-admin.example.org", "access-control-allow-methods": "POST",
    "access-control-allow-headers": "authorization,content-type,x-firebase-appcheck",
  } });
  return new Response(null, { status: init.method === "GET" ? 405 : 401 });
}

describe("isolated development smoke target", () => {
  it("checks the real dev surface through dev origins with the shared refusal checks", async () => {
    const names = Object.keys(DEV_FUNCTIONS);
    const calls = [];
    const request = async (url, init = {}) => {
      calls.push([url, init]);
      return devResponse(url, init);
    };
    const result = await runDevCmsFunctionSmoke({ deployedFunctionNames: names, request });
    expect(result.checked).toBe(calls.length);
    const endpoints = new Set(calls.map(([url]) => new URL(url).pathname.slice(1)));
    for (const name of names.filter(name => !name.startsWith("on"))) expect(endpoints.has(name), name).toBe(true);
    for (const [url, init] of calls) {
      expect(url).not.toMatch(/https:\/\/(?:cms-api|admin)\.njpbs\.org|njpbs-site\.cloudfunctions/);
      expect(init.redirect).toBe("manual");
      expect(new Headers(init.headers).has("authorization")).toBe(false);
    }
    const publish = calls.filter(([url]) => url.endsWith("/cmsPublishSettings"));
    expect(publish).toHaveLength(2);
    expect(publish.map(([url]) => new URL(url).origin)).toEqual([
      "https://dev-api.example.org", "https://us-central1-njpbs-site-dev.cloudfunctions.net",
    ]);
  });

  it.each([undefined, DEPLOYED_FUNCTION_NAMES, Object.keys(DEV_FUNCTIONS).filter(name => name !== "cmsReaderV2"),
    [...Object.keys(DEV_FUNCTIONS), "cmsUnexpected"]])("rejects an unverified or incomplete manifest before HTTP", async deployedFunctionNames => {
    const request = vi.fn();
    await expect(runDevCmsFunctionSmoke({ deployedFunctionNames, request })).rejects.toThrow("complete dev manifest");
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    { baseUrl: "https://dev-api.example.org" },
    { functionsOrigin: "https://us-central1-njpbs-site-dev.cloudfunctions.net" },
    { adminOrigin: "https://dev-admin.example.org" },
  ])("keeps the production entry closed to a dev target: %j", async patch => {
    const request = vi.fn();
    await expect(runCmsFunctionSmoke({ ...patch, request })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it("refuses an anonymously exposed dev Admin", async () => {
    await expect(runDevCmsFunctionSmoke({ deployedFunctionNames: Object.keys(DEV_FUNCTIONS),
      request: (url, init) => new URL(url).hostname === "dev-admin.example.org"
        ? Promise.resolve(new Response(null, { status: 200 })) : devResponse(url, init),
    })).rejects.toThrow("Dev anonymous refusal failed");
  });
  it("fails the dev smoke when a deployed settings boundary stops refusing anonymous writes", async () => {
    const request = async url => new Response(null, { status: url.endsWith("/health") ? 200 : 404 });
    await expect(runDevCmsFunctionSmoke({ deployedFunctionNames: Object.keys(DEV_FUNCTIONS), request })).rejects.toThrow("expected 401");
  });
});
