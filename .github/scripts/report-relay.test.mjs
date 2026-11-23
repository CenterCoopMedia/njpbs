import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyReportRelay } from "./report-relay.mjs";

const expected = { id: 1234567890, username: "example_report_bot" };
const env = (patch = {}) => ({
  CMS_BUG_REPORT_TELEGRAM_BOT_TOKEN: "1234567890:" + "a".repeat(35),
  CMS_BUG_REPORT_TELEGRAM_CHAT_ID: "42",
  CMS_BUG_REPORT_TELEGRAM_BOT_ID: String(expected.id),
  CMS_BUG_REPORT_TELEGRAM_BOT_USERNAME: expected.username,
  ...patch,
});

// Each entry answers one request in order: an Error, a status number, or a
// Telegram result for that method. Unlisted requests get the correct answer.
function telegram(options = {}, script = []) {
  const calls = [];
  const sleeps = [];
  const fetch = async (input) => {
    const method = new URL(input).pathname.split("/").at(-1);
    calls.push(method);
    const next = script.shift();
    if (next instanceof Error) throw next;
    if (typeof next === "number") return Response.json({ ok: false, parameters: next === 429 ? { retry_after: 3 } : undefined }, { status: next });
    const results = {
      getMe: { id: options.wrongIdentity ? 1234567891 : expected.id, username: expected.username },
      getWebhookInfo: { url: options.webhook ? "https://hooks.example.org/" : "" },
      getChat: { id: 42, type: options.publicChat ? "group" : "private" },
    };
    if (!Object.hasOwn(results, method)) throw new Error("Unexpected relay method");
    return Response.json({ ok: true, result: results[method] });
  };
  return { calls, sleeps, deps: { fetch, sleep: async ms => { sleeps.push(ms); } } };
}

test("report relay retries a response body that fails to arrive", async () => {
  const relay = telegram();
  const fetch = relay.deps.fetch;
  let dropped = false;
  relay.deps.fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (dropped) return response;
    dropped = true;
    return { ok: true, status: 200, headers: response.headers, json: async () => { throw new DOMException("timed out", "TimeoutError"); } };
  };
  await verifyReportRelay(env(), relay.deps);
  assert.deepEqual(relay.calls, ["getMe", "getMe", "getWebhookInfo", "getChat"]);
  assert.deepEqual(relay.sleeps, [2_000]);
});

const timeout = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } });

test("report relay verifies configured identity, polling, and private recipient without sending", async () => {
  const relay = telegram();
  await verifyReportRelay(env(), relay.deps);
  assert.deepEqual(relay.calls, ["getMe", "getWebhookInfo", "getChat"]);
});

test("report relay retries connection failures, server errors and rate limits", async () => {
  const relay = telegram({}, [timeout(), 502, undefined, 429]);
  await verifyReportRelay(env(), relay.deps);
  assert.deepEqual(relay.calls, ["getMe", "getMe", "getMe", "getWebhookInfo", "getWebhookInfo", "getChat"]);
  assert.deepEqual(relay.sleeps, [2_000, 4_000, 3_000]);
});

test("report relay fails after repeated connection failures without printing the token", async () => {
  const relay = telegram({}, [timeout(), timeout(), timeout(), timeout()]);
  await assert.rejects(verifyReportRelay(env(), relay.deps), error => {
    assert.match(error.message, /getMe unreachable after 4 attempts \(ETIMEDOUT\)/);
    assert.doesNotMatch(error.message, /aaaa/);
    return true;
  });
  assert.equal(relay.calls.length, 4);
});

test("report relay does not retry a definite refusal", async () => {
  const relay = telegram({}, [401]);
  await assert.rejects(verifyReportRelay(env(), relay.deps), /getMe check failed \(HTTP 401\)/);
  assert.deepEqual(relay.calls, ["getMe"]);
});

for (const [name, options, patch, methods] of [
  ["missing configured identity", {}, { CMS_BUG_REPORT_TELEGRAM_BOT_ID: "" }, []],
  ["malformed token", {}, { CMS_BUG_REPORT_TELEGRAM_BOT_TOKEN: "bad" }, []],
  ["wrong bot identity", { wrongIdentity: true }, {}, ["getMe"]],
  ["active webhook", { webhook: true }, {}, ["getMe", "getWebhookInfo"]],
  ["public recipient", { publicChat: true }, {}, ["getMe", "getWebhookInfo", "getChat"]],
]) {
  test(`report relay refuses ${name}`, async () => {
    const relay = telegram(options);
    await assert.rejects(verifyReportRelay(env(patch), relay.deps));
    assert.deepEqual(relay.calls, methods);
  });
}
