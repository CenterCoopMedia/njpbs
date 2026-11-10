import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseLiveBlogFeed } from "../../packages/content-core/src/live-blog-manifest";
import { main, parseArgs, planCheck, runCheck, inNewscastWindow } from "../../scripts/election-night-load-check.mjs";

const postUrl = "https://njpbs.org/posts/election-night/";
const headers = { "cf-cache-status": "HIT", "x-njpbs-render-cache": "MISS", age: "20" };
// Synthetic published-feed contract fixture.
const feed = { schemaVersion: 1, postId: "election-night", updatedAt: "2026-11-04T00:00:00Z",
  coverageState: "ongoing", totalCount: 1, updates: [{ id: "entry", updatedAt: "2026-11-04T00:00:00Z" }] };
const reply = (url: string) => new Response(url.includes("?live-blog=") ? JSON.stringify(parseLiveBlogFeed(feed)) : "<html>Published Post</html>",
  { headers: { ...headers, "content-type": url.includes("?") ? "application/json; charset=utf-8" : "text/html" } });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-04T00:00:00Z")); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each([
  "https://admin.njpbs.org/posts/election-night/", "https://dev-public.example.org/posts/election-night/",
  "https://example.cloudfunctions.net/posts/election-night/", "http://njpbs.org/posts/election-night/",
  "https://staff:editor-2@example.org/posts/election-night/", "https://njpbs.org:444/posts/election-night/",
  "https://njpbs.org/posts/election-night/?bypass=1", "https://njpbs.org/posts/election-night/#entry",
  "https://njpbs.org/contact/", "https://njpbs.org/posts/election-night/../admin/", "https://njpbs.org/posts/a%2fb/",
])("refuses a noncanonical or non-edge target: %s", url => {
  expect(() => planCheck({ postUrl: url })).toThrow();
});
it("derives only the exact feed query and refuses unknown/repeated CLI options", () => {
  expect(planCheck({ postUrl }).feedUrl).toBe(`${postUrl}?live-blog=updates`);
  expect(() => parseArgs(["--post-url", postUrl, "--rate", "100"])).toThrow();
  expect(() => parseArgs(["--post-url", postUrl, "--run", "--run"])).toThrow();
  expect(() => parseArgs(["--post-url"])).toThrow();
});
it("defaults to a dry run with zero network requests, including the explicit second tier", async () => {
  const request = vi.fn(); vi.stubGlobal("fetch", request); const output = vi.fn();
  expect(await main(["--post-url", postUrl], output)).toBe(0);
  expect(await main(["--post-url", postUrl, "--second-tier"], output)).toBe(0);
  expect(request).not.toHaveBeenCalled();
  expect(output.mock.calls[0][0]).toMatchObject({ dryRun: true, requestsPerSecond: 1, durationSeconds: 60, requestCap: 60 });
  expect(output.mock.calls[1][0]).toMatchObject({ dryRun: true, requestsPerSecond: 5, durationSeconds: 120, requestCap: 600 });
});
it.each([[false, 60, 1000], [true, 600, 200]])("enforces the fixed total rate/count/duration caps (second tier %s)", async (secondTier, count, interval) => {
  const starts: number[] = []; let inFlight = 0, peak = 0;
  const request = vi.fn(async (url: string, options: RequestInit) => {
    starts.push(Date.now()); inFlight++; peak = Math.max(peak, inFlight);
    expect(options.redirect).toBe("manual"); expect(options.headers).not.toHaveProperty("authorization");
    await Promise.resolve(); inFlight--; return reply(url);
  });
  const pending = runCheck({ postUrl, secondTier }, { fetch: request, now: Date.now });
  await vi.advanceTimersByTimeAsync(secondTier ? 120_000 : 60_000);
  const result = await pending;
  expect(request).toHaveBeenCalledTimes(count); expect(peak).toBe(1);
  expect(result.attempts).toBe(count); expect(result.elapsedSeconds).toBe(secondTier ? 120 : 60);
  expect(result.measuredRequestsPerSecond).toBe(secondTier ? 5 : 1);
  expect(result.endpoints.feed.requests).toBe(count / 2); expect(result.endpoints.page.requests).toBe(count / 2);
  expect(starts.slice(1).every((start, index) => start - starts[index] >= interval)).toBe(true);
  expect(result.endpoints.page.cfCacheStatus).toEqual({ HIT: count / 2 });
  expect(result.endpoints.page.renderCacheStatus).toEqual({ MISS: count / 2 });
  expect(result.endpoints.page.age).toEqual({ present: count / 2, missingOrInvalid: 0, min: 20, max: 20 });
  expect(result.originRequests).toBe("not measured by the checker"); expect(vi.getTimerCount()).toBe(0);
});
it.each([500, 502, 503, 599])("stops immediately on HTTP %s without another request or retry", async status => {
  const request = vi.fn(async () => new Response("Unavailable", { status, headers }));
  const result = await runCheck({ postUrl }, { fetch: request, now: Date.now });
  expect(result.stopReason).toBe(`http-${status}`); expect(request).toHaveBeenCalledTimes(1);
  expect(result.endpoints.feed.statuses).toEqual({ [status]: 1 }); expect(vi.getTimerCount()).toBe(0);
});
it.each([[false, 1000], [true, 200]])("rechecks the monotonic rate limit after an early timer wake (second tier %s)", async (secondTier, interval) => {
  let time = 0.25;
  const starts: number[] = [];
  const request = vi.fn(async (url: string) => {
    starts.push(time);
    return starts.length === 3 ? new Response(null, { status: 503 }) : reply(url);
  });
  const result = await runCheck({ postUrl, secondTier }, {
    fetch: request, now: () => time,
    wait: async (ms: number) => { time += Math.max(1, Math.floor(ms) - 1); },
  });
  expect(result.stopReason).toBe("http-503"); expect(starts).toHaveLength(3);
  expect(starts.slice(1).every((start, index) => start - starts[index] >= interval)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
it("keeps the full measured window when its final wait wakes early", async () => {
  let time = 0.25;
  const result = await runCheck({ postUrl }, {
    fetch: async (url: string) => reply(url), now: () => time,
    wait: async (ms: number) => { time += Math.max(1, Math.floor(ms) - 1); },
  });
  expect(result.attempts).toBe(60); expect(result.elapsedSeconds).toBeGreaterThanOrEqual(60);
  expect(result.measuredRequestsPerSecond).toBeLessThanOrEqual(1); expect(vi.getTimerCount()).toBe(0);
});
it("does not finish a stalled final request before the fractional absolute deadline", async () => {
  let reads = 0;
  const request = vi.fn(async (url: string) => request.mock.calls.length === 60 ? new Promise<Response>(() => {}) : reply(url));
  const pending = runCheck({ postUrl }, { fetch: request, now: () => Date.now() + (reads++ === 0 ? 0 : 0.25) });
  await vi.advanceTimersByTimeAsync(60_000); const result = await pending;
  expect(result.stopReason).toBe("duration-complete"); expect(result.attempts).toBe(60);
  expect(result.elapsedSeconds).toBeGreaterThanOrEqual(60); expect(result.measuredRequestsPerSecond).toBeLessThanOrEqual(1);
  expect(vi.getTimerCount()).toBe(0);
});
it.each([404, 302, 403])("refuses an undeployed/redirected/denied feed (%s) without following", async status => {
  const request = vi.fn(async () => new Response(null, { status, headers: { location: "https://example.cloudfunctions.net/private" } }));
  const result = await runCheck({ postUrl }, { fetch: request, now: Date.now });
  expect(result.stopReason).toBe(status === 404 ? "feed-not-deployed" : `http-${status}`); expect(request).toHaveBeenCalledTimes(1);
});
it.each([
  new Response("<html>Old reader ignored the query</html>", { headers: { "content-type": "text/html" } }),
  new Response("broken JSON", { headers: { "content-type": "application/json" } }),
  new Response("[]", { headers: { "content-type": "application/json" } }),
  new Response("{}", { headers: { "content-type": "application/json" } }),
])("refuses a non-feed response instead of measuring the old Post fallback", async response => {
  const request = vi.fn(async () => response);
  expect((await runCheck({ postUrl }, { fetch: request, now: Date.now })).stopReason).toBe("request-or-response-failed");
  expect(request).toHaveBeenCalledTimes(1);
});
it("bounds a stalled fetch even if its transport ignores cancellation", async () => {
  const request = vi.fn(() => new Promise<Response>(() => {}));
  const pending = runCheck({ postUrl }, { fetch: request, now: Date.now });
  await vi.advanceTimersByTimeAsync(5000);
  expect((await pending).stopReason).toBe("request-timeout"); expect(request).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
});
it("does not overlap or catch up when requests are slower than the allowed interval", async () => {
  const starts: number[] = [];
  const request = vi.fn(async (url: string) => { starts.push(Date.now()); await new Promise(resolve => setTimeout(resolve, 800)); return reply(url); });
  const pending = runCheck({ postUrl, secondTier: true }, { fetch: request, now: Date.now });
  await vi.advanceTimersByTimeAsync(120_000); const result = await pending;
  expect(result.elapsedSeconds).toBe(120); expect(result.attempts).toBeLessThanOrEqual(150);
  expect(starts.slice(1).every((start, index) => start - starts[index] >= 800)).toBe(true); expect(vi.getTimerCount()).toBe(0);
});
it("treats the absolute duration boundary as completion even when setup consumed time", async () => {
  let clockReads = 0;
  const now = () => Date.now() - (clockReads++ === 0 ? 20 : 0);
  const request = vi.fn(async (url: string) => { await new Promise(resolve => setTimeout(resolve, 800)); return reply(url); });
  const pending = runCheck({ postUrl, secondTier: true }, { fetch: request, now });
  await vi.advanceTimersByTimeAsync(120_000);
  expect((await pending).stopReason).toBe("duration-complete"); expect(vi.getTimerCount()).toBe(0);
});
it("refuses the newscast window and a second tier that would cross its start", async () => {
  const request = vi.fn(); vi.setSystemTime(new Date("2026-11-03T22:00:00Z"));
  expect(inNewscastWindow(Date.now())).toBe(true);
  await expect(runCheck({ postUrl }, { fetch: request })).rejects.toThrow("5–6 PM");
  vi.setSystemTime(new Date("2026-11-03T21:59:00Z"));
  await expect(runCheck({ postUrl, secondTier: true }, { fetch: request })).rejects.toThrow("5–6 PM");
  expect(request).not.toHaveBeenCalled();
});
it("stops an interrupted run", async () => {
  const signal = new AbortController(); const request = vi.fn(async () => {
    signal.abort(); return new Response("{}", { headers: { "content-type": "application/json" } });
  });
  const result = await runCheck({ postUrl }, { fetch: request, now: Date.now, signal: signal.signal });
  expect(result.stopReason).toBe("interrupted"); expect(request).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
});
it("records missing cache telemetry and optional feed headers without inventing origin hits", async () => {
  const request = vi.fn(async () => request.mock.calls.length === 1
    ? new Response('{"updatedAt":"2026-11-04T00:00:00Z","totalCount":0}', { headers: { "content-type": "application/json", "x-njpbs-live-blog-cache": "MISS" } })
    : new Response(null, { status: 503 }));
  const pending = runCheck({ postUrl }, { fetch: request, now: Date.now });
  await vi.advanceTimersByTimeAsync(1000); const result = await pending;
  expect(result.endpoints.feed.cfCacheStatus).toEqual({ MISSING: 1 });
  expect(result.endpoints.feed.renderCacheStatus).toEqual({ MISSING: 1 });
  expect(result.endpoints.feed.age).toEqual({ present: 0, missingOrInvalid: 1, min: null, max: null });
  expect(result.endpoints.feed.cfHitRatioAmongReportedStatuses).toBeNull();
  expect(result.endpoints.feed.feedCacheStatus).toEqual({ "x-njpbs-live-blog-cache": { MISS: 1 } });
  expect(result.originRequests).toBe("not measured by the checker"); expect(request).toHaveBeenCalledTimes(2);
});
it("bounds a response body that never finishes", async () => {
  const request = vi.fn(async () => new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "application/json" } }));
  const pending = runCheck({ postUrl }, { fetch: request, now: Date.now });
  await vi.advanceTimersByTimeAsync(5000);
  expect((await pending).stopReason).toBe("request-timeout"); expect(request).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
});

it("refuses the obsolete synthetic total field instead of accepting an undeployed feed", async () => {
  const request = vi.fn(async () => Response.json({ updatedAt: "2026-11-04T00:00:00Z", total: 1, ids: ["entry"] }));
  const result = await runCheck({ postUrl }, { fetch: request, now: Date.now });
  expect(result.stopReason).toBe("request-or-response-failed");
  expect(result.endpoints.feed.completed).toBe(0);
  expect(request).toHaveBeenCalledTimes(1);
});
