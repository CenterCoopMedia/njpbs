import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { fetchMembership } = require("../../functions/lib/pbs/mvault-lookup");

const API_KEY = "mvault-test-key";
const API_SECRET = "mvault-test-secret";
const BASIC_AUTH = Buffer.from(`${API_KEY}:${API_SECRET}`).toString("base64");
const CONTACT_EMAIL = "donor@example.org";
const CONFIG = {
  stationId: "njpbs",
  pbsUid: "viewer-123",
  apiKey: API_KEY,
  apiSecret: API_SECRET,
  signInEmail: CONTACT_EMAIL,
  now: Date.parse("2026-09-07T12:00:00Z"),
};

function membership(patch = {}) {
  const { status = "On", timing = "within_start_expire_dates", ...fields } = patch;
  return {
    status,
    offer: "passport",
    email: CONTACT_EMAIL,
    provisional: false,
    current_state: {
      has_access: status === "On" && ["within_start_expire_dates", "within_grace_period"].includes(timing),
      explanation: { status, timing, token_activated: true },
    },
    ...fields,
  };
}

function response(body = [membership()], status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), { status });
}

async function lookup(fetchImpl, overrides = {}) {
  const result = await fetchMembership({ ...CONFIG, fetchImpl, ...overrides });
  const encoded = JSON.stringify(result);
  for (const privateValue of [API_KEY, API_SECRET, BASIC_AUTH, CONTACT_EMAIL]) {
    expect(encoded).not.toContain(privateValue);
  }
  return result;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("MVault lookup request boundary", () => {
  it("encodes each path segment and sends credentials only in the Basic header", async () => {
    const fetchImpl = vi.fn(async () => response());
    await expect(lookup(fetchImpl, {
      stationId: "station/one?view=#%",
      pbsUid: "viewer/two?token=#%",
    })).resolves.toEqual({
      status: "ok",
      entitlement: { entitled: true, state: "active" },
      identityMismatch: false,
      passportResetOffered: false,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, options] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(
      "https://mvault.services.pbs.org/api/station%2Fone%3Fview%3D%23%25/memberships/filter/uid/viewer%2Ftwo%3Ftoken%3D%23%25/",
    );
    expect(options).toMatchObject({ method: "GET", redirect: "error", cache: "no-store" });
    expect(options.body).toBeUndefined();
    expect(options.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(options.headers);
    expect(headers.get("authorization")).toBe(`Basic ${BASIC_AUTH}`);
    headers.delete("authorization");
    const publicRequest = JSON.stringify({ url: String(url), ...options, headers: [...headers] });
    for (const privateValue of [API_KEY, API_SECRET, BASIC_AUTH, CONTACT_EMAIL]) {
      expect(publicRequest).not.toContain(privateValue);
    }
  });

  it.each([
    { stationId: "" },
    { apiKey: undefined },
    { apiSecret: "   " },
  ])("does not fetch without configuration: %j", async (overrides) => {
    const fetchImpl = vi.fn();
    await expect(lookup(fetchImpl, overrides)).resolves.toEqual({ status: "not-configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    { stationId: "." },
    { stationId: ".." },
    { pbsUid: "." },
    { pbsUid: ".." },
    { pbsUid: undefined },
    { pbsUid: "" },
  ])("rejects an invalid identity before fetching: %j", async (overrides) => {
    const fetchImpl = vi.fn();
    await expect(lookup(fetchImpl, overrides)).resolves.toEqual({ status: "error" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("MVault response boundary", () => {
  it.each([
    [401, "forbidden"],
    [403, "forbidden"],
    [429, "rate-limited"],
    [404, "not-found"],
    [302, "error"],
    [201, "error"],
    [204, "error"],
    [500, "error"],
  ])("maps HTTP %i to %s without returning its body", async (status, expected) => {
    const fetchImpl = vi.fn(async () => response({
      apiKey: API_KEY, apiSecret: API_SECRET, authorization: BASIC_AUTH, email: CONTACT_EMAIL,
    }, status));
    await expect(lookup(fetchImpl)).resolves.toEqual({ status: expected });
  });

  it.each([
    ["no memberships", [], "not-found"],
    ["multiple memberships", [membership(), membership()], "error"],
    ["an object", membership(), "error"],
    ["null", null, "error"],
    ["an unreadable membership", [null], "error"],
  ])("handles %s without granting an entitlement", async (_label, body, status) => {
    await expect(lookup(vi.fn(async () => response(body)))).resolves.toEqual({ status });
  });

  it("rejects invalid JSON without returning the raw response", async () => {
    const raw = `${API_KEY} ${API_SECRET} ${BASIC_AUTH} ${CONTACT_EMAIL}`;
    await expect(lookup(vi.fn(async () => new Response(raw)))).resolves.toEqual({ status: "error" });
  });

  it.each([
    { timing: "unknown_timing" },
    { status: 1 },
    { offer: { passport: true } },
    { provisional: "false" },
  ])("rejects unreadable membership fields: %j", async (patch) => {
    await expect(lookup(vi.fn(async () => response([membership(patch)])))).resolves.toEqual({ status: "error" });
  });

  it("does not accept top-level timing in place of current_state", async () => {
    const record = membership();
    delete record.current_state;
    record.timing = "within_start_expire_dates";
    await expect(lookup(vi.fn(async () => response([record])))).resolves.toEqual({ status: "error" });
  });

  it("rejects current_state when its status disagrees with the membership", async () => {
    const record = membership();
    record.current_state.explanation.status = "Off";
    await expect(lookup(vi.fn(async () => response([record])))).resolves.toEqual({ status: "error" });
  });

  it.each(["token_activated", "has_access"])("never grants when upstream %s is false", async (field) => {
    const record = membership();
    if (field === "token_activated") record.current_state.explanation.token_activated = false;
    else record.current_state.has_access = false;
    await expect(lookup(vi.fn(async () => response([record])))).resolves.toMatchObject({
      status: "ok",
      entitlement: { entitled: false },
    });
  });

  it.each(["token_activated", "has_access"])("rejects a string in the upstream %s boolean", async (field) => {
    const record = membership();
    if (field === "token_activated") record.current_state.explanation.token_activated = "true";
    else record.current_state.has_access = "true";
    await expect(lookup(vi.fn(async () => response([record])))).resolves.toEqual({ status: "error" });
  });

  it.each([
    [{}, true, "active"],
    [{ timing: "within_grace_period" }, true, "grace"],
    [{ timing: "expired" }, false, "expired"],
    [{ timing: "before_start" }, false, "inactive"],
    [{ status: "Off" }, false, "inactive"],
    [{ provisional: true }, false, "inactive"],
  ])("maps policy fields %j to %s/%s", async (patch, entitled, state) => {
    await expect(lookup(vi.fn(async () => response([membership(patch)])))).resolves.toEqual({
      status: "ok",
      entitlement: { entitled, state },
      identityMismatch: false,
      passportResetOffered: false,
    });
  });

  it.each([
    ["  DONOR@EXAMPLE.ORG ", "within_start_expire_dates", false, false],
    ["other@example.org", "within_start_expire_dates", true, false],
    ["other@example.org", "expired", true, true],
    [undefined, "expired", false, false],
  ])("returns only identity booleans for %s and %s", async (signInEmail, timing, mismatch, reset) => {
    await expect(lookup(vi.fn(async () => response([membership({ timing })])), { signInEmail })).resolves.toEqual({
      status: "ok",
      entitlement: { entitled: timing !== "expired", state: timing === "expired" ? "expired" : "active" },
      identityMismatch: mismatch,
      passportResetOffered: reset,
    });
  });

  it.each(["headers", "body"])("does not return private text from a thrown %s failure", async (stage) => {
    const failure = new Error(`${API_KEY} ${API_SECRET} ${BASIC_AUTH} ${CONTACT_EMAIL}`);
    const fetchImpl = vi.fn(async () => {
      if (stage === "headers") throw failure;
      return new Response(new ReadableStream({ start(controller) { controller.error(failure); } }));
    });
    await expect(lookup(fetchImpl)).resolves.toEqual({ status: "error" });
  });
});

describe("MVault timeout covers the complete response", () => {
  it.each(["headers", "body"])("settles a stalled %s promise even when the fetch ignores abort", async (stage) => {
    vi.useFakeTimers();
    const never = new Promise(() => {});
    const fetchImpl = vi.fn(() => stage === "headers"
      ? never
      : Promise.resolve(new Response(new ReadableStream({ start() {} }))));
    let completed = false;
    const pending = lookup(fetchImpl, { timeoutMs: 50 }).then((result) => {
      completed = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(49);
    expect(completed).toBe(false);
    const signal = fetchImpl.mock.calls[0][1].signal;
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ status: "timeout" });
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline after a completed lookup", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => response());
    await expect(lookup(fetchImpl, { timeoutMs: 50 })).resolves.toMatchObject({ status: "ok" });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
