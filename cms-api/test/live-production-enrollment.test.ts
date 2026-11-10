import { describe, expect, it } from "vitest";
import { createCmsApiHandler, type CmsApiEnv } from "../src/index";
import type { CmsRateLimiter } from "../src/rate-limiter";
const environment = (allowed = true): CmsApiEnv => ({
  ALLOW_LOCAL_ORIGINS: "false", CMS_EDGE_ORIGIN_SECRET: "synthetic-edge", FIREBASE_PROJECT_ID: "demo-njpbs",
  FUNCTIONS_ORIGIN: "https://functions.example.test",
  RATE_LIMITERS: { getByName: () => ({ consume: async () => ({ allowed, remaining: 1, retryAfterSeconds: 5 }) }) } as unknown as DurableObjectNamespace<CmsRateLimiter>,
} as CmsApiEnv);
const request = (endpoint: string, body = "{}", headers: Record<string, string> = {}) => new Request(`https://api.example.test/${endpoint}`, {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body,
});
describe("studio pairing edge boundary", () => {
  it("admits only device code redemption without a Firebase bearer token", async () => {
    const handler = createCmsApiHandler({ fetchOrigin: async () => new Response("{}") });
    expect((await handler.fetch(request("cmsPairLiveProductionDevice"), environment())).status).toBe(200);
    expect((await handler.fetch(request("cmsLiveProductionDevices"), environment())).status).toBe(401);
    expect((await handler.fetch(request("cmsLiveProductionDevices", "{}", { authorization: "Bearer pds_synthetic-premiere" }), environment())).status).toBe(401);
  });
  it("preserves origin, 2 KiB and rate-limit gates", async () => {
    const handler = createCmsApiHandler({ fetchOrigin: async () => { throw new Error("Rejected requests must not reach origin"); } });
    expect((await handler.fetch(request("cmsPairLiveProductionDevice", "{}", { origin: "https://untrusted.example.test" }), environment())).status).toBe(403);
    expect((await handler.fetch(request("cmsPairLiveProductionDevice", JSON.stringify({ code: "a".repeat(2100) })), environment())).status).toBe(413);
    const limited = await handler.fetch(request("cmsPairLiveProductionDevice"), environment(false));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("5");
  });
});
