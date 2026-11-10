// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/home-sources/newscast-documented-schema.json";
import { fetchHomeNewscast, homeNewscastForSync } from "../scripts/sync-home-newscast.mjs";
import { HOME_NEWSCAST_ASSETS_URL } from "../../packages/content-core/src/home-newscast-source";
const now = () => "2026-10-11T15:00:00Z";
const config = { authorization: "fixture authorization" };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

describe("normal PBS sync's automatic newscast packet", () => {
  it("collects all approved pages before selecting the title-date winner and exports no raw/private siblings", async () => {
    const older = fixture.data.find(item => item.attributes.title.endsWith("October 8, 2026"))!;
    const next = `${HOME_NEWSCAST_ASSETS_URL}&page=2`;
    const requests: { url: string; redirect: string | undefined; authorized: boolean }[] = [];
    const result = await fetchHomeNewscast(config, async (input, options) => {
      const url = String(input);
      requests.push({ url, redirect: options?.redirect, authorized: Boolean((options?.headers as Record<string, string>).Authorization) });
      return json(url === next ? { data: [{ ...fixture.data[0], privateCredential: "PRIVATE fixture" }], links: { next: null } }
        : { data: [older], links: { next } });
    }, now);
    expect(requests).toEqual([{ url: HOME_NEWSCAST_ASSETS_URL, redirect: "error", authorized: true }, { url: next, redirect: "error", authorized: true }]);
    expect(result.episode).toMatchObject({ id: "a22562ab-3442-42e7-a9e4-192c2d0bd190", episodeDate: "2026-10-09", premieredOn: "2026-10-09" });
    expect(result.episode?.playerSrc).toBe("https://player.pbs.org/partnerplayer/3114511752/");
    expect(result.checkedAt).toBe(now());
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|Authorization|privateCredential|requestUrl|availabilities|cutoffAt/);
  });
  it.each(["headers", "body"])("bounds the entire pagination to 60 seconds when page %s are slow and falls back safely", async phase => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const started = Date.now();
    let requests = 0;
    try {
      const pending = homeNewscastForSync(config, async (_input, options) => {
        requests++;
        const signal = options!.signal!;
        const payload = { data: requests === 1 ? [fixture.data[0]] : [],
          links: { next: requests < 6 ? `${HOME_NEWSCAST_ASSETS_URL}&page=${requests + 1}` : null } };
        // Every page fits the existing 20-second request cap, but six pages
        // would take 114 seconds without the overall optional-source deadline.
        const delay = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 19_000);
          function abort() { clearTimeout(timer); reject(signal.reason); }
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
        if (phase === "headers") { await delay; return json(payload); }
        return new Response(new ReadableStream({
          async start(controller) {
            try { await delay; controller.enqueue(new TextEncoder().encode(JSON.stringify(payload))); controller.close(); }
            catch (error) { controller.error(error); }
          },
        }));
      }, now);
      let settled = false;
      void pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(59_999);
      expect(settled).toBe(false);
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({ checkedAt: null, episode: null, emptyReason: "source_error", liveHref: "/live/" });
      expect(Date.now() - started).toBe(60_000);
      expect(requests).toBe(4);
      expect(warn).toHaveBeenCalledOnce();
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/Authorization|fixture authorization/);
    } finally { vi.useRealTimers(); warn.mockRestore(); }
  });
  it("never sends authorization to an off-origin, redirected, changed-filter or looping next page", async () => {
    const changed = new URL(HOME_NEWSCAST_ASSETS_URL); changed.searchParams.set("show-id", "another-program");
    for (const next of ["https://example.test/assets/", changed.href, HOME_NEWSCAST_ASSETS_URL,
      `${HOME_NEWSCAST_ASSETS_URL}&available=passport`, `${HOME_NEWSCAST_ASSETS_URL}#fragment`]) {
      let requests = 0;
      await expect(fetchHomeNewscast(config, async () => {
        requests++; return json({ data: [fixture.data[0]], links: { next } });
      }, now)).rejects.toThrow("complete approved newscast provider snapshot is unavailable");
      expect(requests).toBe(1);
    }
    await expect(fetchHomeNewscast(config, async () => new Response("PRIVATE error body", { status: 403 }), now))
      .rejects.toThrow("complete approved newscast provider snapshot is unavailable");
    const redirected = new Response("PRIVATE body"); Object.defineProperty(redirected, "redirected", { value: true });
    await expect(fetchHomeNewscast(config, async () => redirected, now)).rejects.toThrow("complete approved newscast provider snapshot is unavailable");
  });
  it("refuses incomplete, malformed and oversized pages rather than certifying a partial latest result", async () => {
    const cases = [json({ data: fixture.data }), json({ data: fixture.data, links: { next: 2 } }),
      json({ data: {}, links: { next: null } }), new Response("PRIVATE malformed JSON"),
      new Response("{}", { headers: { "content-length": String(4 * 1024 * 1024 + 1) } })];
    for (const response of cases) {
      await expect(fetchHomeNewscast(config, async () => response, now)).rejects.toThrow("complete approved newscast provider snapshot is unavailable");
    }
  });
  it("uses no provider call without credentials and isolates an optional newscast failure from the broader refresh", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let requests = 0;
    const network = async () => { requests++; throw new Error("PRIVATE network request"); };
    try {
      expect(await fetchHomeNewscast({ authorization: null }, network, now)).toMatchObject({ checkedAt: null, episode: null, emptyReason: "source_error" });
      expect(requests).toBe(0);
      expect(await homeNewscastForSync(config, network, now)).toMatchObject({ checkedAt: null, episode: null, emptyReason: "source_error", liveHref: "/live/" });
      expect(requests).toBe(1);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]).toEqual([expect.stringMatching(/newscast.*source_error/i)]);
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/PRIVATE|Authorization|fixture authorization/);
    } finally { warn.mockRestore(); }
  });
  it("refuses a new observation whose latest episode has no approved player, without choosing an older one", async () => {
    for (const player_code of [undefined, '<iframe src="https://evil.example.test/player"></iframe>']) {
      const response = structuredClone(fixture);
      Object.assign(response.data[0].attributes, { player_code });
      const result = await homeNewscastForSync(config, async () => json(response), now);
      expect(result).toMatchObject({ episode: null, emptyReason: "source_error", checkedAt: null });
    }
  });
});
