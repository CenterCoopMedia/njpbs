import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDevMachineReceipt } from "../../scripts/check-dev-machine-receipt.mjs";

const env = { CMS_DEV_ACCESS_CLIENT_ID: "fixture-client", CMS_DEV_ACCESS_CLIENT_SECRET: "fixture-secret" };
const headers = { "content-type": "application/json", "cache-control": "private, no-store" };

test("machine receipt GET and HEAD use the fixed dev origin and log statuses plus exact GET digest", async () => {
  const logs = [], methods = [];
  await checkDevMachineReceipt({ env, log: line => logs.push(line), fetchImpl: async (url, options) => {
    assert.equal(url, "https://dev-public.example.org/_publication.json");
    assert.equal(options.redirect, "manual");
    assert.deepEqual(options.headers, { "CF-Access-Client-Id": "fixture-client", "CF-Access-Client-Secret": "fixture-secret" });
    methods.push(options.method);
    return new Response(options.method === "HEAD" ? null : '{"generation":0}', { headers });
  } });
  assert.deepEqual(methods, ["GET", "HEAD"]);
  assert.deepEqual(logs, ["GET /_publication.json: 200", JSON.stringify({ kind: "dev-machine-receipt-bytes", method: "GET",
    bytes: 16, sha256: "08dea33b559cbb92aa5275db116fb757d56c88e0fa488369a64fc49f9ed0faee" }), "HEAD /_publication.json: 200"]);
});

test("receipt digest binds raw UTF-8 bytes without emitting the JSON body", async () => {
  const logs = [];
  await checkDevMachineReceipt({ env, log: line => logs.push(line), fetchImpl: async (_url, options) =>
    new Response(options.method === "HEAD" ? null : '{"title":"é"}', { headers }) });
  assert.deepEqual(JSON.parse(logs[1]), { kind: "dev-machine-receipt-bytes", method: "GET", bytes: 14,
    sha256: "17fc9dbaed22ce2d07e9a2bb624e57b3cd39cd72e937e0dd0eb4ddf8f03190d6" });
  assert(!logs.join("\n").includes("title"));
  assert(!logs.join("\n").includes("fixture-secret"));
});

for (const [name, status, body, responseHeaders] of [
  ["Access redirect", 302, "private challenge", { location: "https://example.test/?token=private" }],
  ["missing receipt", 404, "private missing page", headers],
  ["HTML fallback", 200, "<html></html>", { ...headers, "content-type": "text/html" }],
  ["malformed JSON", 200, "private invalid JSON", headers],
  ["JSON array", 200, "[]", headers],
  ["cacheable receipt", 200, "{}", { ...headers, "cache-control": "public" }],
]) {
  test(`refuses ${name} without logging response content`, async () => {
    const logs = [];
    await assert.rejects(checkDevMachineReceipt({ env, log: line => logs.push(line), fetchImpl: async () =>
      new Response(body, { status, headers: responseHeaders }),
    }), /Dev machine receipt proof failed/);
    assert.deepEqual(logs, [`GET /_publication.json: ${status}`, `HEAD /_publication.json: ${status}`]);
  });
}

test("missing credentials cannot start a request", async () => {
  await assert.rejects(checkDevMachineReceipt({ env: {}, fetchImpl: () => assert.fail("No request allowed") }), /Missing dev Access credentials/);
});
