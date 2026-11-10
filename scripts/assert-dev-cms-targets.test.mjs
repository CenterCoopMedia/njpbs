import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Tuple from the development target specification, with synthetic account/app IDs.
const actual = JSON.parse(readFileSync(new URL("./fixtures/dev-targets.json", import.meta.url), "utf8"));
let sequence = 0;
async function configured(expectedWebApp) {
  const keys = { CMS_DEV_FIREBASE_WEB_APP_ID: expectedWebApp, CMS_DEV_CLOUDFLARE_ACCOUNT_ID: actual.CLOUDFLARE_ACCOUNT_ID };
  const previous = Object.fromEntries(Object.keys(keys).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(keys)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await import(`./assert-dev-cms-targets.mjs?fixture=${sequence++}`);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("development web app must match an independent expected identity", async () => {
  const { assertDevTargets } = await configured(actual.FIREBASE_WEB_APP_ID);
  assert.equal(assertDevTargets(actual), true);
  for (const value of ["", "1:123456789012:web:ffffffffffffffff", "invalid"]) {
    assert.throws(() => assertDevTargets({ ...actual, FIREBASE_WEB_APP_ID: value }), /FIREBASE_WEB_APP_ID/);
  }
});

test("a missing or malformed expected web app cannot authorize a matching input", async () => {
  for (const value of [undefined, "", "invalid", "REPLACE_ME"]) {
    const { assertDevTargets } = await configured(value);
    assert.throws(() => assertDevTargets({ ...actual, FIREBASE_WEB_APP_ID: value ?? "" }), /FIREBASE_WEB_APP_ID/);
  }
});
