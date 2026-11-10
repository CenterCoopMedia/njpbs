import { describe, expect, it } from "vitest";
import { buildShareStartRequest, parseShareConfig, photoDimensionsAllowed, shareErrorMessage, validateShareFields, type ShareConfig, type ShareFields } from "../src/lib/share-form";

const config: ShareConfig = {
  open: true,
  consentVersion: "ugc-release-1",
  consentTextHash: "a".repeat(64),
  texts: { release: "Release", checkbox: "I agree", age: "I am 18 or older", ageHelp: "Ask a parent", privacy: "Privacy", closed: "Closed", thanks: "Thanks" },
};
const fields: ShareFields = {
  name: " Jane Doe ", email: " jane@example.com ", message: "A story worth sharing", file: { name: "story.jpg", type: "image/jpeg", size: 100 }, consentChecked: true, ageAttested: true,
};

describe("share form contract", () => {
  it("fails closed on incomplete or unapproved config", () => {
    expect(parseShareConfig({ ...config, texts: { closed: "Closed" } })).toBeNull();
    expect(parseShareConfig({ ...config, consentTextHash: "wrong" })).toBeNull();
    expect(parseShareConfig({ ...config, open: false, texts: { ...config.texts, release: "" } })?.texts.closed).toBe("Closed");
    expect(parseShareConfig(config)).toEqual(config);
  });

  it("checks every required field and the separate photo and video limits", () => {
    expect(validateShareFields(fields)).toEqual({});
    expect(validateShareFields({ ...fields, name: " ", email: "bad", message: "short", file: { name: "x.pdf", type: "application/pdf", size: 1 }, consentChecked: false, ageAttested: false })).toMatchObject({ name: expect.any(String), email: expect.any(String), message: expect.any(String), file: expect.any(String), consentChecked: expect.any(String), ageAttested: expect.any(String) });
    expect(validateShareFields({ ...fields, file: { name: "big.jpg", type: "image/jpeg", size: 25 * 1024 * 1024 + 1 } }).file).toMatch(/25 MiB/);
    expect(validateShareFields({ ...fields, file: { name: "big.mp4", type: "video/mp4", size: 500 * 1024 * 1024 + 1 } }).file).toMatch(/500 MiB/);
    expect(validateShareFields({ ...fields, email: `${"a".repeat(310)}@example.com` }).email).toMatch(/320 characters/);
    expect(photoDimensionsAllowed(10_000, 10_000)).toBe(true);
    expect(photoDimensionsAllowed(10_001, 10_000)).toBe(false);
  });

  it("builds the exact start payload with stable request metadata", () => {
    const request = buildShareStartRequest(fields, config, { requestId: "00000000-0000-4000-8000-000000000000", timeElapsed: 3000, turnstileToken: "token", website: "" });
    expect(request).toEqual({ requestId: "00000000-0000-4000-8000-000000000000", name: "Jane Doe", email: "jane@example.com", message: "A story worth sharing", consentVersion: "ugc-release-1", consentTextHash: "a".repeat(64), consentChecked: true, ageAttested: true, file: { name: "story.jpg", type: "image/jpeg", size: 100 }, turnstileToken: "token", website: "", timeElapsed: 3000 });
    expect(() => buildShareStartRequest(fields, { ...config, open: false }, { requestId: "id", timeElapsed: 3000, turnstileToken: "token", website: "" })).toThrow();
    expect(() => buildShareStartRequest(fields, config, { requestId: "invalid", timeElapsed: 3000, turnstileToken: "token", website: "" })).toThrow();
  });

  it("maps each contract error to a specific message", () => {
    for (const code of ["closed", "invalid", "too_large", "type", "turnstile", "rejected_file", "missing_upload", "expired"]) {
      expect(shareErrorMessage(code)).not.toBe(shareErrorMessage("unknown"));
    }
    expect(shareErrorMessage("rate_limited", 60, Date.UTC(2026, 8, 28, 12))).toMatch(/Try again at/);
  });
});
