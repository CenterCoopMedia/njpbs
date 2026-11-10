import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCmsApiHandler, type CmsApiEnv } from "../src/index";

function fixture() {
  let nowMs = 1_000;
  const upstreamBodies: Record<string, unknown>[] = [];
  const ip = crypto.randomUUID();
  const uid = crypto.randomUUID();
  const worker = createCmsApiHandler({
    now: () => nowMs,
    verifyToken: async token => ({ uid: token }),
    fetchOrigin: async (_url, init) => {
      const body = JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer));
      upstreamBodies.push(body);
      // A missing epoch returns a cheap invalidation, requiring a manifest.
      return Response.json(body.action === "check"
        ? { schema: 1, unchanged: false, freshnessMs: 60_000 }
        : { schema: 1, initializing: true, shards: [], tombstones: [] });
    },
  });
  const bindings: CmsApiEnv = { ...env, PREVIEW_RENDERER: undefined,
    ALLOW_LOCAL_ORIGINS: "false", CMS_EDGE_ORIGIN_SECRET: "test-edge-secret" };
  return {
    upstreamBodies,
    advance: (milliseconds: number) => { nowMs += milliseconds; },
    send: (action: string, actor = uid) => worker.fetch(new Request(
      "https://api.example.org/cmsGetVideoSearchCorpus", {
        method: "POST", headers: { authorization: `Bearer ${actor}`,
          "cf-connecting-ip": ip, "content-type": "application/json" },
        body: JSON.stringify({ sourceId: "video-library", action }),
      }), bindings),
  };
}

beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => undefined); });
afterEach(() => { vi.restoreAllMocks(); });

describe("video search manifest work budget", () => {
  it("allows entry and two conflict retries, then refuses scans until refill", async () => {
    const api = fixture();
    for (let index = 0; index < 3; index++) expect((await api.send("manifest")).status).toBe(200);
    const denied = await api.send("manifest");
    expect(denied.status).toBe(429);
    expect(denied.headers.get("x-rate-limit-scope")).toBe("actor");
    expect(denied.headers.get("retry-after")).toBe("60");
    expect(api.upstreamBodies).toHaveLength(3);
    expect((await api.send("check")).status).toBe(200);
    expect((await api.send("shards")).status).toBe(200);
    api.advance(60_000);
    expect((await api.send("manifest")).status).toBe(200);
    expect(api.upstreamBodies.map(body => body.action)).toEqual([
      "manifest", "manifest", "manifest", "check", "shards", "manifest",
    ]);
  });

  it("charges missing-state recovery scans and returns 429 after the burst", async () => {
    const api = fixture();
    const check = await api.send("check");
    expect(await check.json()).toMatchObject({ unchanged: false });
    for (let index = 0; index < 3; index++) expect((await api.send("manifest")).status).toBe(200);
    expect((await api.send("manifest")).status).toBe(429);
    expect(api.upstreamBodies.map(body => body.action)).toEqual(["check", "manifest", "manifest", "manifest"]);
  });

  it("shares a bounded IP budget across accounts and refills one scan per 15 seconds", async () => {
    const api = fixture();
    for (let index = 0; index < 12; index++) {
      expect((await api.send("manifest", crypto.randomUUID())).status).toBe(200);
    }
    const denied = await api.send("manifest", crypto.randomUUID());
    expect(denied.status).toBe(429);
    expect(denied.headers.get("x-rate-limit-scope")).toBe("ip");
    expect(denied.headers.get("retry-after")).toBe("15");
    expect(api.upstreamBodies).toHaveLength(12);
    api.advance(15_000);
    expect((await api.send("manifest", crypto.randomUUID())).status).toBe(200);
  });

  it("keeps refused actors from spending the shared IP scan budget", async () => {
    const api = fixture();
    for (let index = 0; index < 3; index++) await api.send("manifest");
    for (let index = 0; index < 5; index++) expect((await api.send("manifest")).status).toBe(429);
    for (let index = 0; index < 9; index++) {
      expect((await api.send("manifest", crypto.randomUUID())).status).toBe(200);
    }
    expect(api.upstreamBodies).toHaveLength(12);
  });
});
