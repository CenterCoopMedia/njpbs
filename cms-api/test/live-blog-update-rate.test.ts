import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCmsApiHandler, type CmsApiEnv } from "../src/index";

afterEach(() => vi.restoreAllMocks());

function gateway() {
  let now = 1_000;
  let forwarded = 0;
  const ip = crypto.randomUUID();
  const uid: string = crypto.randomUUID();
  vi.spyOn(console, "log").mockImplementation(() => {});
  const worker = createCmsApiHandler({ now: () => now,
    verifyToken: async (token) => ({ uid: token }),
    fetchOrigin: async () => { forwarded++; return new Response("{}"); },
  });
  const bindings: CmsApiEnv = { ...env, PREVIEW_RENDERER: undefined,
    ALLOW_LOCAL_ORIGINS: "false", CMS_EDGE_ORIGIN_SECRET: "test-edge-secret" };
  const send = (body: Record<string, unknown>, actor = uid) => worker.fetch(new Request("https://api.example.org/cmsSaveContent", {
    method: "POST", headers: { authorization: `Bearer ${actor}`, "cf-connecting-ip": ip,
      origin: "https://admin.njpbs.org", "content-type": "application/json" },
    body: JSON.stringify(body),
  }), bindings);
  return {
    advance: (milliseconds: number) => { now += milliseconds; },
    get forwarded() { return forwarded; },
    liveUpdate: (actor?: string) => send({ collection: "cmsPosts", id: "post-one", baseVersion: 5, publish: true,
      liveBlogUpdate: true, document: { liveBlog: { schemaVersion: 1, coverageState: "ongoing", updates: [] } } }, actor),
    save: (actor?: string) => send({ collection: "cmsPosts", id: "post-one", baseVersion: 5, document: { title: "Election night" } }, actor),
  };
}

describe("direct live blog update budget", () => {
  it("refuses the seventh rapid live update and accepts one after the 10-second refill", async () => {
    const api = gateway();
    for (let index = 0; index < 6; index++) expect((await api.liveUpdate()).status).toBe(200);
    const blocked = await api.liveUpdate();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("x-rate-limit-scope")).toBe("actor");
    expect(blocked.headers.get("retry-after")).toBe("10");
    expect((await blocked.json() as { error: string }).error).toContain("Too many live updates");
    expect(api.forwarded).toBe(6);
    api.advance(10_000);
    expect((await api.liveUpdate()).status).toBe(200);
    expect((await api.liveUpdate()).status).toBe(429);
  });

  it("leaves ordinary saves on the mutation budget alone", async () => {
    const api = gateway();
    // Twenty ordinary saves do not spend the live update budget.
    for (let index = 0; index < 20; index++) expect((await api.save()).status).toBe(200);
    for (let index = 0; index < 6; index++) expect((await api.liveUpdate()).status).toBe(200);
    expect((await api.liveUpdate()).status).toBe(429);
    // An exhausted live update budget does not block an ordinary save.
    expect((await api.save()).status).toBe(200);
    expect(api.forwarded).toBe(27);
  });

  it("keeps the 30-request mutation budget for live updates too", async () => {
    const api = gateway();
    for (let index = 0; index < 28; index++) expect((await api.save()).status).toBe(200);
    expect((await api.liveUpdate()).status).toBe(200);
    expect((await api.liveUpdate()).status).toBe(200);
    const blocked = await api.liveUpdate();
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: "Too many requests. Try again later." });
  });
});
