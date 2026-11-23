import { describe, expect, it, vi } from "vitest";
import { createDonationHealthHandler } from "../../functions/lib/pbs/donation-health.js";
import { donateUrl } from "../../packages/content-core/src/launch-fallback.ts";

const htmlForm = () => new Response(null, { headers: { "Content-Type": "text/html; charset=utf-8" } });

function request(method = "GET", headers = {}, originalUrl = "/") {
  return { method, originalUrl, get: name => headers[name] };
}

async function run(handler, req = request()) {
  const response = { headers: {} };
  const res = {
    set(name, value) { response.headers[name] = value; },
    status(code) { response.code = code; return res; },
    json(body) { response.body = body; },
    end() {},
  };
  await handler(req, res);
  return response;
}

describe("donation-form health boundary", () => {
  it.each([
    [htmlForm, "reachable"],
    [() => new Response(null, { status: 403 }), "forbidden"],
    [() => new Response(null, { status: 401 }), "forbidden"],
    [() => new Response(null, { status: 429 }), "rateLimited"],
    [() => new Response(null, { status: 302, headers: { Location: "https://foreign.example.org" } }), "error"],
    [() => new Response(null, { status: 503 }), "error"],
    [() => new Response(null, { status: 204 }), "error"],
    [() => new Response(null, { headers: { "Content-Type": "application/json" } }), "error"],
    [() => { throw new Error("private upstream detail"); }, "error"],
  ])("returns a finite status (%s → %s)", async (upstream, status) => {
    const fetchImpl = vi.fn(upstream);
    const result = await run(createDonationHealthHandler({ fetchImpl }));
    expect(result).toMatchObject({ code: 200, body: { status } });
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      donateUrl,
      { method: "HEAD", redirect: "manual", signal: expect.any(AbortSignal) },
    );
  });

  it("times out a stalled probe and makes no retry", async () => {
    const fetchImpl = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const result = await run(createDonationHealthHandler({ fetchImpl, timeoutMs: 10 }));
    expect(result.body).toEqual({ status: "timeout" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    [request("POST"), 405],
    [request("HEAD"), 405],
    [request("GET", { origin: "https://foreign.example.org" }), 403],
    [request("GET", { "sec-fetch-site": "cross-site" }), 403],
    [request("GET", { "sec-fetch-site": "cross-site", origin: "https://njpbs.org" }), 403],
    [request("GET", {}, "/?target=https://foreign.example.org"), 400],
    [request("GET", {}, "/?"), 400],
    [request("GET", {}, "/https://foreign.example.org"), 400],
    [request("GET", { cookie: "fixture=present" }), 400],
    [request("GET", { authorization: "fixture" }), 400],
    [request("GET", { "content-length": "10" }), 400],
    [request("GET", { "transfer-encoding": "chunked" }), 400],
  ])("rejects a caller outside the read-only contract", async (req, code) => {
    const fetchImpl = vi.fn();
    const result = await run(createDonationHealthHandler({ fetchImpl }), req);
    expect(result).toMatchObject({ code, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    expect(result.body).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("answers an allowed CORS preflight without probing", async () => {
    const fetchImpl = vi.fn();
    const result = await run(createDonationHealthHandler({ fetchImpl }), request("OPTIONS", { origin: "https://njpbs.org" }));
    expect(result).toMatchObject({ code: 204, headers: {
      "Access-Control-Allow-Origin": "https://njpbs.org",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      Vary: "Origin, Sec-Fetch-Site",
    } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("shares one in-flight probe and expires a refusal sooner than a success", async () => {
    let now = 0;
    let release;
    const firstProbe = new Promise(resolve => { release = resolve; });
    const fetchImpl = vi.fn(htmlForm).mockReturnValueOnce(firstProbe);
    const handler = createDonationHealthHandler({ fetchImpl, now: () => now });
    const first = run(handler);
    const concurrent = run(handler);
    release(new Response(null, { status: 403 }));
    for (const result of await Promise.all([first, concurrent])) {
      expect(result.body).toEqual({ status: "forbidden" });
    }
    now = 9_999;
    expect((await run(handler)).body).toEqual({ status: "forbidden" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    now = 10_000;
    expect((await run(handler)).body).toEqual({ status: "reachable" });
    now = 69_999;
    expect((await run(handler)).body).toEqual({ status: "reachable" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    now = 70_000;
    expect((await run(handler)).body).toEqual({ status: "reachable" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
