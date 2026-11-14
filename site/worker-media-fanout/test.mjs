import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "./njpbs-media-fanout.mjs";

const recipients = ["first@example.org", "second@example.org", "third@example.org"];
const env = {
  MEDIA_FANOUT_ADDRESS: "media@example.org",
  MEDIA_FANOUT_RECIPIENTS_JSON: JSON.stringify(recipients),
};

test("forwards every configured destination, including after a rejection", async () => {
  const forwarded = [];
  await assert.rejects(worker.email({
    to: "MEDIA@example.org",
    setReject() { assert.fail("Unexpected rejection"); },
    async forward(address) {
      forwarded.push(address);
      if (address === recipients[1]) throw new Error("Private provider details");
    },
  }, env), { message: "Media forwarding failed for 1 destination(s)." });
  assert.deepEqual(forwarded, recipients);
});

test("accepts all-success forwards and rejects other inbound addresses", async () => {
  const forwarded = [];
  await worker.email({ to: "media@example.org", async forward(address) { forwarded.push(address); } }, env);
  assert.deepEqual(forwarded, recipients);
  let reason;
  await worker.email({
    to: "other@example.org",
    setReject(value) { reason = value; },
    async forward() { assert.fail("Unexpected forward"); },
  }, env);
  assert.equal(reason, "This handler accepts media@example.org only.");
});

test("missing or malformed bindings fail without disclosing configuration", async () => {
  for (const settings of [
    {}, { ...env, MEDIA_FANOUT_RECIPIENTS_JSON: "private-canary" },
    { ...env, MEDIA_FANOUT_RECIPIENTS_JSON: "[]" },
    { ...env, MEDIA_FANOUT_RECIPIENTS_JSON: '["first@example.org", null]' },
    { ...env, MEDIA_FANOUT_ADDRESS: undefined },
  ]) {
    await assert.rejects(worker.email({
      to: "media@example.org", async forward() { assert.fail("Unexpected forward"); },
    }, settings), { message: "Media forwarding configuration is invalid." });
  }
});
