import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCmsApiHandler, type CmsApiEnv } from "../src/index";

let nextIp = 1;

function fixture() {
  let nowMs = 1_000;
  const upstreamBodies: unknown[] = [];
  const ip = `203.0.113.${nextIp++}`;
  const uid = crypto.randomUUID();
  const worker = createCmsApiHandler({
    now: () => nowMs,
    verifyToken: async (token) => ({ uid: token }),
    fetchOrigin: async (_url, init) => {
      upstreamBodies.push(JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer)));
      return new Response('{"success":true}', { headers: { "content-type": "application/json" } });
    },
  });
  const bindings: CmsApiEnv = {
    ...env, PREVIEW_RENDERER: undefined,
    ALLOW_LOCAL_ORIGINS: "false", CMS_EDGE_ORIGIN_SECRET: "test-edge-secret",
  };
  return {
    upstreamBodies,
    advance: (milliseconds: number) => { nowMs += milliseconds; },
    send: (body: Record<string, unknown>, actor: string = uid, endpoint = "cmsListSourceMedia") => worker.fetch(
      new Request(`https://api.example.org/${endpoint}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${actor}`,
          "cf-connecting-ip": ip,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }), bindings,
    ),
  };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("source poster request budget", () => {
  it("charges a 100-poster batch before forwarding and leaves ordinary reads available", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const api = fixture();
    const body = { sourceId: "video-library", limit: 100, posters: true };
    for (let page = 0; page < 3; page += 1) expect((await api.send(body)).status).toBe(200);
    const denied = await api.send(body);
    expect(denied.status).toBe(200);
    expect(api.upstreamBodies).toEqual([...Array(3).fill(body), { sourceId: "video-library", limit: 100 }]);
    expect((await api.send({ sourceId: "video-library", limit: 100 })).status).toBe(200);
    expect((await api.send({}, undefined, "cmsGetSettings")).status).toBe(200);
    api.advance(50_000);
    expect((await api.send(body)).status).toBe(200);
    expect(api.upstreamBodies.at(-1)).toEqual(body);
  });

  it.each([
    [undefined, 10], [24, 12], [48, 6], [96, 3],
  ])("bounds default and Admin page size %s without splitting a page", async (limit, acceptedPages) => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const api = fixture();
    const body = { sourceId: "video-library", posters: true, ...(limit === undefined ? {} : { limit }) };
    for (let page = 0; page < acceptedPages; page += 1) {
      expect((await api.send(body)).status).toBe(200);
    }
    expect((await api.send(body)).status).toBe(200);
    expect(api.upstreamBodies).toEqual([
      ...Array(acceptedPages).fill(body),
      { sourceId: "video-library", ...(limit === undefined ? {} : { limit }) },
    ]);
  });

  it("charges one poster for an exact asset lookup", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const api = fixture();
    expect((await api.send({ sourceId: "video-library", limit: 100, posters: true })).status).toBe(200);
    expect((await api.send({ sourceId: "video-library", limit: 100, posters: true })).status).toBe(200);
    expect((await api.send({ sourceId: "video-library", limit: 80, posters: true })).status).toBe(200);
    expect((await api.send({ sourceId: "video-library", assetId: "video-1", posters: true })).status).toBe(200);
    const denied = await api.send({ sourceId: "video-library", limit: 20, posters: true });
    expect(denied.status).toBe(200);
    expect(api.upstreamBodies.at(-1)).toEqual({ sourceId: "video-library", limit: 20 });
    expect(api.upstreamBodies).toHaveLength(5);
  });

  it("shares the IP poster budget across browser accounts and Premiere sessions", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const api = fixture();
    const body = { sourceId: "video-library", limit: 100, posters: true };
    const desktopBody = { operation: "cmsListSourceMedia", payload: { limit: 100, posters: true } };
    const forwarded = [];
    for (let account = 0; account < 12; account += 1) {
      if (account % 2) {
        const session = `pds_${crypto.randomUUID()}abcdefg`;
        expect((await api.send(desktopBody, session, "cmsPremiereRequest")).status).toBe(200);
        forwarded.push(desktopBody);
      } else {
        expect((await api.send(body, crypto.randomUUID())).status).toBe(200);
        forwarded.push(body);
      }
    }
    const denied = await api.send(body, crypto.randomUUID());
    expect(denied.status).toBe(200);
    expect(api.upstreamBodies).toEqual([...forwarded, { sourceId: "video-library", limit: 100 }]);
  });

  it("admits opening the 48-item picker, searching and loading more", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const api = fixture();
    const pages = [
      { sourceId: "video-library", limit: 48, posters: true },
      { sourceId: "video-library", limit: 48, posters: true, q: "county" },
      { sourceId: "video-library", limit: 48, posters: true, q: "county", cursor: "next-page" },
    ];
    for (const body of pages) expect((await api.send(body)).status).toBe(200);
    expect(api.upstreamBodies).toEqual(pages);
  });

  it("charges nested Premiere poster lists to the desktop session", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const api = fixture();
    const session = `pds_${crypto.randomUUID()}abcdefg`;
    const body = { operation: "cmsListSourceMedia", payload: { limit: 100, posters: true } };
    for (let page = 0; page < 3; page += 1) {
      expect((await api.send(body, session, "cmsPremiereRequest")).status).toBe(200);
    }
    const denied = await api.send(body, session, "cmsPremiereRequest");
    const plain = { operation: "cmsListSourceMedia", payload: { limit: 100 } };
    expect(denied.status).toBe(200);
    expect(api.upstreamBodies).toEqual([...Array(3).fill(body), plain]);
    expect((await api.send(plain, session, "cmsPremiereRequest")).status).toBe(200);
  });

  it("keeps an exhausted actor from spending the newsroom IP poster budget", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const api = fixture();
    const body = { sourceId: "video-library", limit: 100, posters: true };
    for (let page = 0; page < 3; page += 1) await api.send(body);
    for (let denied = 0; denied < 10; denied += 1) expect((await api.send(body)).status).toBe(200);
    expect(api.upstreamBodies).toEqual([
      ...Array(3).fill(body), ...Array(10).fill({ sourceId: "video-library", limit: 100 }),
    ]);
    for (let colleague = 0; colleague < 3; colleague += 1) {
      const uid = crypto.randomUUID();
      for (let page = 0; page < 3; page += 1) expect((await api.send(body, uid)).status).toBe(200);
    }
    expect(api.upstreamBodies.filter((value) => (value as { posters?: boolean }).posters)).toEqual(Array(12).fill(body));
  });

  it.each(["cmsListSourceMedia", "cmsPremiereRequest"])("preserves list filters and cursors on poster fallback through %s", async (endpoint) => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const api = fixture();
    const actor = endpoint === "cmsPremiereRequest" ? `pds_${crypto.randomUUID()}abcdefg` : crypto.randomUUID();
    const wrap = (payload: Record<string, unknown>) => endpoint === "cmsPremiereRequest"
      ? { operation: "cmsListSourceMedia", payload } : payload;
    for (let page = 0; page < 3; page += 1) {
      expect((await api.send(wrap({ sourceId: "video-library", limit: 100, posters: true }), actor, endpoint)).status).toBe(200);
    }
    const filters = { sourceId: "video-library", limit: 48, q: "county", tag: "Local", sort: "name_asc", cursor: "next-page" };
    expect((await api.send(wrap({ ...filters, posters: true }), actor, endpoint)).status).toBe(200);
    expect(api.upstreamBodies.at(-1)).toEqual(wrap(filters));
  });
});
