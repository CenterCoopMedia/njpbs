import assert from "node:assert/strict";
import { test } from "node:test";
import { assertConsentVersionChange, validateUgcConsentFile } from
  "../../scripts/write-ugc-consent-config.mjs";

function reviewed(overrides = {}) {
  return { open: true, consentVersion: "release-1", approvedBy: "an administrator",
    texts: { release: "I grant NJ PBS permission.", checkbox: "I agree.",
      age: "I am 18 or older.", ageHelp: "Ask a parent or guardian.",
      privacy: "See the privacy policy.", closed: "Submissions are closed.",
      thanks: "Thank you." }, ...overrides };
}

test("validates the reviewed config and hashes the exact release paragraph", () => {
  const result = validateUgcConsentFile(reviewed());
  assert.equal(result.consentTextHash,
    "92b03266ed2e2ac7b8a66318d8268b2b9be3e61a8d5513ef7d09d6b237f39f7b");
  assert.equal(result.open, true);
});

test("refuses empty text in every consent field", () => {
  for (const field of Object.keys(reviewed().texts)) {
    const input = reviewed();
    input.texts[field] = "  ";
    assert.throws(() => validateUgcConsentFile(input), /nonempty texts/);
  }
});

test("refuses missing approval, malformed data and unsupported fields", () => {
  for (const input of [reviewed({ approvedBy: "" }), reviewed({ consentVersion: "" }),
    reviewed({ consentVersion: "release/1" }),
    reviewed({ open: "true" }), reviewed({ extra: "ignored" }),
    reviewed({ texts: { ...reviewed().texts, hash: "untrusted" } })]) {
    assert.throws(() => validateUgcConsentFile(input));
  }
});

test("requires a new version when any wording changes, including while closed", () => {
  const current = reviewed();
  const changed = validateUgcConsentFile(reviewed({ open: false,
    texts: { ...current.texts, release: "A revised release." } }));
  assert.throws(() => assertConsentVersionChange(current, changed), /new consentVersion/);
  assert.doesNotThrow(() => assertConsentVersionChange(current,
    validateUgcConsentFile(reviewed({ consentVersion: "release-2" }))));
});
