import { describe, expect, it } from "vitest";
import { createCmsApiHandler, type CmsApiEnv } from "../src/index";
import type { CmsRateLimiter } from "../src/rate-limiter";

function environment(allowed = true): CmsApiEnv {
  return {
    ALLOW_LOCAL_ORIGINS: "false",
    CMS_EDGE_ORIGIN_SECRET: "local-edge-test",
    FIREBASE_PROJECT_ID: "demo-njpbs" as CmsApiEnv["FIREBASE_PROJECT_ID"],
    FUNCTIONS_ORIGIN: "https://functions.example.test" as CmsApiEnv["FUNCTIONS_ORIGIN"],
    RATE_LIMITERS: {
      getByName: () => ({ consume: async () => ({ allowed, remaining: 1, retryAfterSeconds: 5 }) }),
    } as unknown as DurableObjectNamespace<CmsRateLimiter>,
  };
}

function request(endpoint: string, headers: Record<string, string> = {}, body = "{}") {
  return new Request(`https://api.example.test/${endpoint}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body,
  });
}

describe("Premiere desktop edge boundary", () => {
  it("admits only pairing endpoints without Firebase credentials", async () => {
    const handler = createCmsApiHandler({ fetchOrigin: async () => new Response("{}") });
    for (const endpoint of ["cmsStartPremierePairing", "cmsPollPremierePairing"]) {
      expect((await handler.fetch(request(endpoint), environment())).status).toBe(200);
    }
    for (const endpoint of ["cmsApprovePremierePairing", "cmsListSourceMedia", "cmsPremiereRequest", "cmsRevokePremiereSession"]) {
      expect((await handler.fetch(request(endpoint), environment())).status).toBe(401);
    }
  });

  it("forwards opaque session credentials only to desktop handlers, without client principal headers", async () => {
    const headers = { authorization: `Bearer pds_${"A".repeat(43)}`, "x-desktop-uid": "forged-user", "x-njpbs-cms-edge": "forged-edge" };
    let forwarded: Headers | undefined;
    const handler = createCmsApiHandler({ fetchOrigin: async (_url, init) => {
      forwarded = new Headers(init?.headers);
      return new Response("{}", { status: 401 });
    } });
    expect((await handler.fetch(request("cmsPremiereRequest", headers), environment())).status).toBe(401);
    expect(forwarded?.get("authorization")).toBe(headers.authorization);
    expect(forwarded?.get("x-desktop-uid")).toBeNull();
    expect(forwarded?.get("x-njpbs-cms-edge")).toBe("local-edge-test");
    forwarded = undefined;
    expect((await handler.fetch(request("cmsListSourceMedia", headers), environment())).status).toBe(401);
    expect(forwarded).toBeUndefined();
    expect((await handler.fetch(request("cmsApprovePremierePairing", headers), environment())).status).toBe(401);
  });

  it("preserves origin, size, and IP gates for the new surface", async () => {
    const handler = createCmsApiHandler({ fetchOrigin: async () => { throw new Error("Rejected requests must not reach the origin"); } });
    expect((await handler.fetch(request("cmsStartPremierePairing", { origin: "https://untrusted.example.test" }), environment())).status).toBe(403);
    expect((await handler.fetch(request("cmsStartPremierePairing", {}, JSON.stringify({ deviceName: "a".repeat(3000) })), environment())).status).toBe(413);
    const limited = await handler.fetch(request("cmsStartPremierePairing"), environment(false));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("5");
  });
});
