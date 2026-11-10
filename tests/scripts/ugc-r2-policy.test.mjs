import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assertUgcR2Policy, runUgcR2Policy } from "../../scripts/lib/ugc-r2-policy.mjs";

for (const kind of ["lifecycle", "cors"]) {
  test(`${kind} rule file is the approved policy`, () => {
    const policy = JSON.parse(readFileSync(new URL(`../../scripts/ugc-r2-${kind}.json`, import.meta.url)));
    assert.doesNotThrow(() => assertUgcR2Policy(kind, policy));
    assert.throws(() => assertUgcR2Policy(kind, { rules: [] }), /differ/);
  });
}

test("rejects an extra CORS origin or a shorter retention", () => {
  const cors = JSON.parse(readFileSync(new URL("../../scripts/ugc-r2-cors.json", import.meta.url)));
  cors.rules[0].allowed.origins.push("https://example.org");
  assert.throws(() => assertUgcR2Policy("cors", cors), /differ/);
  const lifecycle = JSON.parse(readFileSync(new URL("../../scripts/ugc-r2-lifecycle.json", import.meta.url)));
  lifecycle.rules[0].deleteObjectsTransition.condition.maxAge = 86400;
  assert.throws(() => assertUgcR2Policy("lifecycle", lifecycle), /differ/);
});

test("apply writes the policy and verifies a separate GET readback", async () => {
  const policy = JSON.parse(readFileSync(new URL("../../scripts/ugc-r2-cors.json", import.meta.url)));
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ success: true, result: policy }) };
  };
  try {
    await runUgcR2Policy("cors", ["--apply"], {
      CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), UGC_R2_BUCKET: "ugc-private",
      CLOUDFLARE_API_TOKEN: "test-token",
    });
    assert.deepEqual(calls.map(({ init }) => init.method), ["PUT", "GET"]);
    assert.deepEqual(JSON.parse(calls[0].init.body), policy);
    assert.match(calls[1].url, /\/r2\/buckets\/ugc-private\/cors$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
