import { describe, expect, it } from "vitest";
import { serveShadowStaffPost } from "../workers/src/shadow-staff-gateway";
const config = { SHADOW_POSTS_ENABLED: "true", SHADOW_POST_SLUGS: "shadow-fixture" };
const cookie = "__Host-njpbs-staff=fixture.session.token";
function harness(status = 204) {
  const calls: { kind: string; request: Request }[] = [];
  const serve = (kind: string) => async (request: Request) => {
    calls.push({ kind, request });
    return new Response(kind, { headers: { "cache-control": "public, max-age=300" } });
  };
  return { calls, dependencies: {
    async validateAccess() { return status; },
    shadow: { fetch: serve("shadow") }, serveAsset: serve("asset"), serveOrigin: serve("origin"),
  } };
}
function request(path: string, signedIn = true, method = "GET") {
  return new Request(`https://dev-public.example.org${path}`, { method, headers: signedIn ? { cookie, authorization: "Bearer private" } : {} });
}

describe("shadow preserves dev staff admission", () => {
  it.each(["/posts/shadow-fixture/", "/posts/_shadow-assets/_astro/script.js"])("requires current staff access for %s", async path => {
    for (const status of [401, 403, 429, 503]) {
      const h = harness(status);
      expect((await serveShadowStaffPost(request(path), config, h.dependencies)).status).toBe(status);
      expect(h.calls).toEqual([]);
    }
    const h = harness();
    expect((await serveShadowStaffPost(request(path, false), config, h.dependencies)).status).toBe(401);
    expect(h.calls).toEqual([]);
  });
  it("serves admitted HTML and assets after stripping staff credentials", async () => {
    const h = harness();
    for (const path of ["/posts/shadow-fixture/", "/posts/_shadow-assets/_astro/script.js"]) {
      const response = await serveShadowStaffPost(request(path), config, h.dependencies);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(h.calls.at(-1)!.request.headers.get("cookie")).toBeNull();
      expect(h.calls.at(-1)!.request.headers.get("authorization")).toBeNull();
    }
    expect(h.calls.map(call => call.kind)).toEqual(["shadow", "asset"]);
    expect(new URL(h.calls[1].request.url).pathname).toBe("/_astro/script.js");
  });
  it("keeps disabled, non-allowlisted and index routes on the authenticated origin", async () => {
    const h = harness();
    for (const path of ["/posts/", "/posts/another-post/"]) {
      await serveShadowStaffPost(request(path), config, h.dependencies);
    }
    await serveShadowStaffPost(request("/posts/shadow-fixture/"), { ...config, SHADOW_POSTS_ENABLED: "false" }, h.dependencies);
    expect(h.calls.map(call => call.kind)).toEqual(["origin", "origin", "origin"]);
  });
  it("refuses production and preview hosts before any upstream read", async () => {
    const h = harness();
    for (const host of ["njpbs.org", "preview.njpbs.org"]) {
      expect((await serveShadowStaffPost(new Request(`https://${host}/posts/shadow-fixture/`), config, h.dependencies)).status).toBe(404);
    }
    expect(h.calls).toEqual([]);
  });
});
