import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCmsApiHandler, type CmsApiEnv } from "../src/index";
import { leaveOneRateToken } from "./rate-budget-fixture";

afterEach(() => vi.restoreAllMocks());

function gateway(ip: string) {
  let now = 1_000;
  let forwarded = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  const worker = createCmsApiHandler({ now: () => now,
    verifyToken: async (token) => ({ uid: token }),
    fetchOrigin: async () => { forwarded++; return new Response("{}"); },
  });
  const bindings: CmsApiEnv = {
    RATE_LIMITERS: env.RATE_LIMITERS,
    ALLOW_LOCAL_ORIGINS: "false", CMS_EDGE_ORIGIN_SECRET: "test-edge-secret",
    FIREBASE_PROJECT_ID: "njpbs-site", FUNCTIONS_ORIGIN: "https://us-central1-njpbs-site.cloudfunctions.net",
  };
  return { advance: (milliseconds: number) => { now += milliseconds; },
    get forwarded() { return forwarded; },
    save: (actor = ip, endpoint = "cmsSaveVideoTranscript") => worker.fetch(new Request(`https://api.example.org/${endpoint}`, {
      method: "POST", headers: { authorization: `Bearer ${actor}`, "cf-connecting-ip": ip,
        origin: "https://admin.njpbs.org", "content-type": "application/json" },
      body: JSON.stringify({ sourceId: "video-library", assetId: "asset", revision: 0,
        segments: [{ index: 0, text: "Corrected" }] }),
    }), bindings),
  };
}

describe("transcript save upload admission", () => {
  it("limits an actor to eight saves, refills after 30 seconds and keeps reads available", async () => {
    const api = gateway("203.0.113.101");
    for (let index = 0; index < 8; index++) expect((await api.save()).status).toBe(200);
    const blocked = await api.save();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("x-rate-limit-scope")).toBe("actor");
    expect(blocked.headers.get("retry-after")).toBe("30");
    expect(api.forwarded).toBe(8);
    expect((await api.save(undefined, "cmsGetVideoTranscript")).status).toBe(200);
    api.advance(30_000);
    expect((await api.save()).status).toBe(200);
  });

  it("shares the save IP budget across actors and limits it to 32 saves", async () => {
    const api = gateway("203.0.113.102");
    expect((await api.save("ip-budget-actor-first")).status).toBe(200);
    await leaveOneRateToken("ip", "upload", "203.0.113.102", 31, 1_000);
    expect((await api.save("ip-budget-actor-last")).status).toBe(200);
    const blocked = await api.save("ip-budget-extra");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("x-rate-limit-scope")).toBe("ip");
    expect(blocked.headers.get("retry-after")).toBe("8");
    expect(api.forwarded).toBe(2);
  });

  it("shares the existing upload budget with video upload starts", async () => {
    const api = gateway("203.0.113.103");
    for (let index = 0; index < 8; index++) {
      expect((await api.save(undefined, "cmsStartSourceMediaUpload")).status).toBe(200);
    }
    expect((await api.save()).status).toBe(429);
    expect(api.forwarded).toBe(8);
  });
});
