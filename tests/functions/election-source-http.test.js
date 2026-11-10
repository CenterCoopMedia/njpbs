import { describe, expect, it, vi } from "vitest";
import provider from "../../functions/lib/election-source-http.js";
import { readFileSync } from "node:fs";
import { apV3Fixture } from "../fixtures/election-sources/ap-v3.js";

const fixture = name => JSON.parse(readFileSync(new URL(`../fixtures/election-sources/${name}.json`, import.meta.url), "utf8"));
describe("bounded election source HTTP and credential boundaries", () => {
  it.each([
    [new DOMException("synthetic-private-detail", "TimeoutError"), "timeout"],
    [new DOMException("synthetic-private-detail", "AbortError"), "timeout"],
    [Object.assign(new TypeError("synthetic-private-detail"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }), "timeout"],
    [Object.assign(new TypeError("synthetic-private-detail"), { cause: { code: "ENOTFOUND" } }), "dns"],
    [Object.assign(new TypeError("synthetic-private-detail"), { cause: { code: "CERT_HAS_EXPIRED" } }), "tls"],
    [Object.assign(new TypeError("synthetic-private-detail"), { cause: { code: "ERR_TLS_CERT_ALTNAME_INVALID" } }), "tls"],
    [Object.assign(new TypeError("synthetic-private-detail"), { cause: { code: "ECONNRESET" } }), "network"],
    [new Error("synthetic-private-detail"), "network"],
  ])("records a bounded %s transport failure as %s", async (raw, code) => {
    const error = await provider.jsonGet("https://user:synthetic-url-secret@results.example.test/", {
      headers: { Authorization: "Bearer synthetic-header-secret" }, fetchImpl: async () => { throw raw; },
    }).catch(error => error);
    expect(error.code).toBe("source-unavailable");
    expect(provider.fetchFailure(error)).toEqual({ code });
    const stored = JSON.stringify(error);
    for (const secret of ["synthetic-private-detail", "synthetic-url-secret", "synthetic-header-secret"]) expect(stored).not.toContain(secret);
    expect(error.cause).toBeUndefined();
  });
  it.each([[401, "auth"], [403, "auth"], [429, "quota"], [404, "http-4xx"], [503, "http-5xx"], [302, "http"]])(
    "records HTTP %s as %s without retaining provider content", async (status, code) => {
      const error = await provider.jsonGet("https://results.example.test/", {
        fetchImpl: async () => new Response("synthetic-provider-secret", { status }),
      }).catch(error => error);
      expect(provider.fetchFailure(error)).toEqual({ code, httpStatus: status });
      expect(JSON.stringify(error)).not.toContain("synthetic-provider-secret");
    });
  it.each([
    [() => new Response("synthetic-invalid-json"), "parse"],
    [() => new Response(null), "empty"],
    [() => new Response(JSON.stringify({ value: "x".repeat(256) })), "size"],
    [() => new Response(new ReadableStream({ start(controller) {
      controller.error(new DOMException("synthetic-stream-secret", "TimeoutError"));
    } })), "timeout"],
  ])("records a bounded response body failure as %s", async (response, code) => {
    const error = await provider.jsonGet("https://results.example.test/", {
      fetchImpl: async () => response(), limit: 128,
    }).catch(error => error);
    expect(provider.fetchFailure(error)).toEqual({ code, httpStatus: 200 });
    expect(JSON.stringify(error)).not.toContain("synthetic-");
  });
  it("classifies AP's documented 403 as quota while preserving generic 403 and AP 401 authentication failures", async () => {
    for (const [url, status, code] of [["https://api.ap.org/v3/elections/2026-11-03", 403, "quota"],
      ["https://api.ap.org/v3/elections/2026-11-03", 401, "auth"], ["https://results.example.test/", 403, "auth"],
      ["https://results.example.test/", 429, "quota"]]) {
      const error = await provider.jsonGet(url, { fetchImpl: async () => new Response("private-provider-body", { status }) }).catch(error => error);
      expect(provider.fetchFailure(error)).toEqual({ code, httpStatus: status });
      expect(JSON.stringify(error)).not.toContain("private-provider-body");
      if (code === "quota" && url.includes("api.ap.org")) expect(error.message).toContain("quota");
      if (url.includes("results.example.test")) expect(error.message).not.toContain("configured budget");
    }
  });
  it("drops arbitrary diagnostic fields and rejects unknown cause codes or invalid statuses", () => {
    expect(provider.fetchFailure({ fetchCause: "synthetic-private-detail", httpStatus: 503 })).toBeNull();
    for (const httpStatus of ["503", NaN, 99, 600]) {
      expect(provider.fetchFailure({ fetchCause: "network", httpStatus, message: "synthetic-private-detail" })).toEqual({ code: "network" });
    }
  });
  it("refuses oversized, malformed and non-2xx responses without copying provider bodies", async () => {
    for (const response of [new Response("sensitive provider body", { status: 503 }), new Response("invalid json"),
      new Response(JSON.stringify({ body: "x".repeat(1024) }))]) {
      const fetchImpl = vi.fn().mockResolvedValue(response);
      await expect(provider.jsonGet("https://results.example.test/", { fetchImpl, limit: 128 })).rejects.toThrow();
      expect(fetchImpl.mock.calls[0][1].redirect).toBe("error");
    }
    await expect(provider.jsonGet("https://results.example.test/", {
      fetchImpl: async () => { throw new Error("do not surface request headers or raw failure"); },
    })).rejects.toThrow("source could not be read");
  });
  it.each([
    "http://api.ap.org/v3/elections/2026-11-03?statePostal=NJ",
    "https://other.example.test/v3/elections/2026-11-03?statePostal=NJ",
    "https://api.ap.org/v3/elections/2024-11-05?statePostal=NJ",
    "https://api.ap.org/v3/elections/2026-11-03?statePostal=NJ&apikey=synthetic",
    "https://user:fixture-a1316aef88@example.org/v3/elections/2026-11-03?statePostal=NJ",
    "https://api.ap.org/v3/elections/2026-11-03?statePostal=PA",
  ])("refuses an unsafe AP cursor %s", url => { expect(() => provider.apCursor(url)).toThrow(); });
  it("reads the optional AP secret only at request time and sends it only as the AP header", async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).startsWith("http://metadata.google.internal/")) return Response.json({ access_token: "synthetic-runtime-token" });
      if (String(url).startsWith("https://secretmanager.googleapis.com/")) return Response.json({ payload: {
        data: Buffer.from("synthetic-fixture-key").toString("base64"),
      } });
      return Response.json({ nextrequest: "https://api.ap.org/v3/elections/2026-11-03?statePostal=NJ&raceID=100&minDateTime=2026-11-04T02:00:00Z" });
    };
    const roster = fixture("roster");
    const mapping = { "100": { raceId: "us-senate", candidateIds: Object.fromEntries(
      roster.races[0].candidateIds.map((cid, index) => [String(index), cid])) } };
    await provider.readSource({ connection: { config: { source: { kind: "ap", mapping }, raceIds: ["us-senate"] } },
      roster, now: "2026-11-04T03:00:00Z", fetchImpl, projectId: "demo-njpbs" });
    expect(calls).toHaveLength(3);
    expect(calls.every(call => !call.url.includes("synthetic-fixture-key"))).toBe(true);
    expect(calls[2].options.headers["x-api-key"]).toBe("synthetic-fixture-key");
    expect(calls[2].options.headers["Accept-Encoding"]).toBe("gzip");
    expect(calls[2].url).toContain("raceID=100");
    expect(calls[2].options.redirect).toBe("error");
  });
  it("reports a missing AP secret as disabled without attempting an AP request", async () => {
    const fetchImpl = vi.fn(async url => String(url).startsWith("http://metadata.google.internal/")
      ? Response.json({ access_token: "synthetic-runtime-token" }) : new Response("unavailable", { status: 404 }));
    await expect(provider.readApSecret({ fetchImpl, projectId: "demo-njpbs" })).rejects.toThrow("AP is not configured");
    expect(fetchImpl.mock.calls.every(([url]) => !String(url).startsWith("https://api.ap.org/"))).toBe(true);
  });
});


describe("AP rehearsal query isolation", () => {
  it("preserves the exact capture-shaped six-digit continuation link, including its virtual source clock", () => {
    for (const kind of ["live", "test"]) {
      const raw = apV3Fixture(kind);
      const options = kind === "test" ? { apRehearsal: true, mapping: { "100": {}, "101": {} } } : {};
      expect(provider.apCursor(raw.nextrequest, options)).toBe(raw.nextrequest);
      expect(new URL(provider.apCursor(raw.nextrequest, options)).searchParams.get("minDateTime")).toBe("2026-11-04T02:59:40.023512Z");
    }
  });
  const mapping = { "100": { raceId: "us-senate", candidateIds: {} } };
  const cursor = "https://api.ap.org/v3/elections/2026-11-03?statePostal=NJ&raceID=100&level=state&resultsType=t&candidateInfo=brief&format=json&minDateTime=2026-11-04T01:00:00Z";
  it("requires the exact test query in every returned cursor", () => {
    const options = { apRehearsal: true, mapping };
    expect(provider.apCursor(cursor, options)).toBe(cursor);
    for (const value of [cursor.replace("resultsType=t", "resultsType=b"), cursor.replace("raceID=100", "raceID=101"),
      cursor.replace("level=state", "level=RU"), cursor + "&RESULTSTYPE=t"]) {
      expect(() => provider.apCursor(value, options)).toThrow();
    }
  });
  it("sends resultsType=t with a header credential and retains only a matching test cursor", async () => {
    const roster = fixture("roster");
    const fullMapping = { "100": { raceId: "us-senate", candidateIds: Object.fromEntries(
      roster.races[0].candidateIds.map((cid, index) => [String(index), cid])) } };
    const apUrls = [];
    const fetchImpl = async (url, options) => {
      if (String(url).startsWith("http://metadata.google.internal/")) return Response.json({ access_token: "synthetic-runtime-token" });
      if (String(url).startsWith("https://secretmanager.googleapis.com/")) return Response.json({ payload: { data: Buffer.from("synthetic-fixture-key").toString("base64") } });
      apUrls.push(String(url)); expect(options.headers["x-api-key"]).toBe("synthetic-fixture-key");
      return Response.json({ nextrequest: cursor });
    };
    const result = await provider.readSource({ connection: { config: { source: { kind: "ap", mapping: fullMapping }, raceIds: ["us-senate"],
      apRehearsal: { sourceTimeOrigin: "2026-11-04T01:00:00Z", replayTimeOrigin: "2026-10-30T14:00:00Z" } } },
      roster, now: "2026-10-30T14:01:00Z", fetchImpl, projectId: "demo-njpbs" });
    expect(new URL(apUrls[0]).searchParams.get("resultsType")).toBe("t");
    expect(result.cursor).toBe(cursor);
    expect(apUrls.every(url => !url.includes("synthetic-fixture-key"))).toBe(true);
  });
});
