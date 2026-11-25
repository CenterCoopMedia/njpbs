import { afterEach, expect, it, vi } from "vitest";
import releaseWait from "../../functions/lib/release-wait.js";
import recovery from "../../functions/lib/no-build-post-recovery.js";
import targets from "../../functions/lib/publication-target.js";

const config = { zoneId: "a".repeat(32), token: "fixture-token" };
afterEach(() => vi.restoreAllMocks());

it.each([500, 408, 502, 529])("repeats a cache purge after HTTP %s and settles on the next success", async status => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const fetchPurge = vi.fn(async () => Response.json({ success: true }));
  fetchPurge.mockResolvedValueOnce(new Response(null, { status }));
  await recovery.purgePublicHome({ target: targets.publicationTarget("production"), purgeConfig: config, fetchPurge });
  expect(fetchPurge).toHaveBeenCalledTimes(2);
});

it.each([400, 401, 403])("ends a cache purge on Cloudflare's own HTTP %s", async status => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const fetchPurge = vi.fn(async () => new Response(null, { status }));
  await expect(recovery.purgePublicHome({ target: targets.publicationTarget("production"), purgeConfig: config, fetchPurge }))
    .rejects.toMatchObject({ code: "public_purge_refused" });
  expect(fetchPurge).toHaveBeenCalledTimes(1);
});

it.each([
  ["a socket reset", { code: "ECONNRESET" }, true],
  ["a prohibited redirect", new Error("unexpected redirect"), false],
  ["a rejected certificate", Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }), false],
  ["no reported cause", undefined, true],
])("reads %s as the service's answer or its absence", (_label, cause, expected) => {
  expect(releaseWait.noAnswer(Object.assign(new TypeError("fetch failed"), cause === undefined ? {} : { cause }))).toBe(expected);
});

it("goes on without an optional read that does not answer, and keeps one that does", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await releaseWait.optionalRead("silent", () => new Promise(() => {}), "fallback")).toBe("fallback");
  expect(await releaseWait.optionalRead("answered", async () => "value", "fallback")).toBe("value");
  await expect(releaseWait.optionalRead("failed", async () => { throw new Error("refused"); }, "fallback")).rejects.toThrow("refused");
});

it("keeps arbitrary error text out of the journal", async () => {
  const lines = [];
  releaseWait.setJournal(line => lines.push(line));
  const secret = "private provider body";
  try {
    await expect(releaseWait.callOutside("refused", async () => { throw new Error(secret); })).rejects.toThrow(secret);
    await expect(releaseWait.waitFor("failed", async () => ({ failed: new Error(secret) }))).rejects.toThrow(secret);
    let calls = 0;
    await releaseWait.callOutside("lost", async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error(secret), { code: "ECONNRESET" });
    });
  } finally { releaseWait.setJournal(line => console.error(JSON.stringify({ severity: "INFO", ...line }))); }
  expect(JSON.stringify(lines)).not.toContain(secret);
  expect(lines.find(line => line.event === "retry").problem).toBe("ECONNRESET");
});
