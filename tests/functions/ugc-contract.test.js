import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import ugc from "../../functions/lib/ugc-contract.js";
import media from "../../functions/lib/media-contract.js";

const request = {
  requestId: "11111111-1111-4111-8111-111111111111",
  name: "A person", email: "person@example.org",
  message: "A short caption for the station.",
  consentVersion: "ugc-release-1", consentTextHash: "a".repeat(64),
  consentChecked: true, ageAttested: true,
  file: { name: "clip.mp4", type: "video/mp4", size: 123 },
};
const texts = Object.fromEntries(ugc.CONSENT_TEXT_FIELDS.map((field) => [field, `${field} text`]));

describe("UGC contract", () => {
  it("keeps UGC types and limits separate from the media library", () => {
    expect(Object.keys(ugc.UGC_TYPES)).toEqual([
      "image/jpeg", "image/png", "image/webp", "image/avif",
      "video/mp4", "video/quicktime", "video/webm",
    ]);
    expect(media.MEDIA_TYPES["video/mp4"]).toBeUndefined();
    expect(ugc.PHOTO_MAX_BYTES).toBe(25 * 1024 * 1024);
    expect(ugc.VIDEO_MAX_BYTES).toBe(500 * 1024 * 1024);
    expect(ugc.MAX_IMAGE_PIXELS).toBe(100_000_000);
    expect(ugc.RETENTION_DAYS).toBe(90);
    expect(ugc.UPLOAD_URL_LIFETIME_SECONDS).toBe(900);
    expect(ugc.UGC_STATUSES).toEqual(["pending", "rejected", "imported"]);
    expect(ugc.UGC_SCOPES).toEqual(["broadcast", "web", "social"]);
  });

  it("validates the required fields, attestation, and file", () => {
    expect(ugc.normalizeStartRequest(request).file).toEqual(request.file);
    for (const change of [
      { name: "" }, { name: "x".repeat(301) },
      { email: "bad" }, { message: "short" },
      { message: "x".repeat(2001) }, { consentChecked: false },
      { ageAttested: false },
    ]) {
      expect(() => ugc.normalizeStartRequest({ ...request, ...change })).toThrow("invalid");
    }
    expect(() => ugc.normalizeFile({ name: "x.gif", type: "image/gif", size: 1 })).toThrow("type");
    expect(() => ugc.normalizeFile({ name: "x.png", type: "image/png", size: ugc.PHOTO_MAX_BYTES + 1 })).toThrow("too_large");
    expect(() => ugc.normalizeFile({ name: "x.webm", type: "video/webm", size: ugc.VIDEO_MAX_BYTES + 1 })).toThrow("too_large");
  });

  it("builds a path-safe quarantine key", () => {
    expect(ugc.quarantineObjectKey("submission-1", "object-2"))
      .toBe("ugc-quarantine/submission-1/object-2");
    expect(() => ugc.quarantineObjectKey("../escape", "object-2")).toThrow("invalid");
  });

  it.each(["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty"])(
    "rejects inherited MIME name %s before accepting an upload", (type) => {
      const file = { ...request.file, type };
      expect(() => ugc.normalizeFile(file)).toThrow("type");
      expect(() => ugc.normalizeStartRequest({ ...request, file })).toThrow("type");
    },
  );

  it.each([null, undefined, 7, ["image/jpeg"], { toString: () => "image/jpeg" }])(
    "rejects a non-string MIME value %j", (type) => {
      expect(() => ugc.normalizeFile({ ...request.file, type })).toThrow("type");
    },
  );

  it.each(Object.keys(ugc.UGC_TYPES))("retains supported MIME %s and its byte limit", (type) => {
    const file = { ...request.file, type };
    expect(ugc.normalizeStartRequest({ ...request, file }).file).toEqual(file);
    const maxBytes = type.startsWith("video/") ? ugc.VIDEO_MAX_BYTES : ugc.PHOTO_MAX_BYTES;
    expect(ugc.normalizeFile({ ...file, size: maxBytes }).size).toBe(maxBytes);
    expect(() => ugc.normalizeFile({ ...file, size: maxBytes + 1 })).toThrow("too_large");
  });

  it("opens only for an approved full config and hashes the exact release", () => {
    const config = { consentVersion: "ugc-release-1", approvedBy: "jules", approvedAt: new Date(), texts };
    expect(ugc.readConsentConfig(config)).toEqual({
      open: true, consentVersion: "ugc-release-1",
      consentTextHash: createHash("sha256").update(texts.release).digest("hex"),
      texts,
    });
    expect(ugc.consentTextHash(" release ")).not.toBe(ugc.consentTextHash("release"));
    for (const incomplete of [null, { ...config, approvedBy: "" },
      { ...config, approvedAt: null },
      { ...config, texts: { ...texts, age: "" } }]) {
      expect(ugc.readConsentConfig(incomplete).open).toBe(false);
    }
  });
});
