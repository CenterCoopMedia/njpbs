import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { createCmsApiHandler, type CmsApiEnv } from "../src/index";

function request(endpoint: string, ip: string) {
  return new Request(`https://api.example.org/${endpoint}`, { method: "POST",
    headers: { authorization: "Bearer test-token", "cf-connecting-ip": ip,
      "content-type": "application/json", origin: "https://admin.njpbs.org" }, body: "{}" });
}

const settings: CmsApiEnv = {
  ALLOW_LOCAL_ORIGINS: "false",
  CMS_EDGE_ORIGIN_SECRET: "test-edge-secret",
  FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID,
  FUNCTIONS_ORIGIN: env.FUNCTIONS_ORIGIN,
  RATE_LIMITERS: env.RATE_LIMITERS,
};

describe("alignment admission rate limits", () => {
  it("keeps alignment limited while allowing local transcript batches and cancellation", async () => {
    let clock = 1000;
    const forwarded: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const api = createCmsApiHandler({ now: () => clock, verifyToken: async () => ({ uid: "alignment-actor" }),
        fetchOrigin: async (url) => { forwarded.push(String(url)); return new Response('{"success":true}'); } });
      const ip = "203.0.113.28";
      for (let index = 0; index < 30; index++) {
        expect((await api.fetch(request("cmsRequestVideoTranscript", ip), settings)).status).toBe(200);
      }
      expect((await api.fetch(request("cmsRequestVideoTranscriptAlignment", ip), settings)).status).toBe(200);
      expect((await api.fetch(request("cmsRequestVideoTranscriptAlignment", ip), settings)).status).toBe(200);
      const denied = await api.fetch(request("cmsRequestVideoTranscriptAlignment", ip), settings);
      expect(denied.status).toBe(429);
      expect(denied.headers.get("x-rate-limit-scope")).toBe("actor");
      expect(denied.headers.get("retry-after")).toBe("300");
      clock += 1000;
      expect((await api.fetch(request("cmsCancelVideoTranscriptAlignment", ip), settings)).status).toBe(200);
      expect(forwarded.map((url) => new URL(url).pathname)).toEqual([
        ...Array(30).fill("/cmsRequestVideoTranscript"), "/cmsRequestVideoTranscriptAlignment",
        "/cmsRequestVideoTranscriptAlignment", "/cmsCancelVideoTranscriptAlignment",
      ]);
    } finally { log.mockRestore(); }
  });

  it("bounds alignment requests from several accounts on the same IP before origin work", async () => {
    let forwarded = 0;
    let actor = 0;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const api = createCmsApiHandler({ now: () => 1000,
        verifyToken: async () => ({ uid: `alignment-ip-actor-${++actor}` }),
        fetchOrigin: async () => { forwarded += 1; return new Response('{"success":true}'); } });
      const ip = "203.0.113.29";
      for (let index = 0; index < 8; index += 1) {
        expect((await api.fetch(request("cmsRequestVideoTranscriptAlignment", ip), settings)).status).toBe(200);
      }
      const denied = await api.fetch(request("cmsRequestVideoTranscriptAlignment", ip), settings);
      expect(denied.status).toBe(429);
      expect(denied.headers.get("x-rate-limit-scope")).toBe("ip");
      expect(denied.headers.get("retry-after")).toBe("75");
      expect(forwarded).toBe(8);
    } finally { log.mockRestore(); }
  });
});
