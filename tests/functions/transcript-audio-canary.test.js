import { afterAll, describe, expect, it, vi } from "vitest";
vi.stubEnv("CMS_MEDIA_AWS_VIDEO_ACCOUNT_ID", "123456789012");
const { validateManifest } = await import("../../scripts/transcript-audio-provider-canary.mjs");
afterAll(() => vi.unstubAllEnvs());

const manifest = () => ({ campaignId: "a".repeat(64), actorUid: "approved-agent", keyVersion: "1",
  credentialRevision: 1, languageCode: "en-US", maxSpeakers: 3,
  bucket: "njpbs-video-renditions-123456789012-us-east-2", ffmpegArtifactSha256: "b".repeat(64),
  job: { sourceId: "video-library", assetId: "canary", sourceBucket: "njpbs-video-originals-123456789012-us-east-2",
    sourceObjectKey: "objects/canary.mov", sourceObjectVersionId: "original-version", sourceSizeBytes: 10000,
    durationSeconds: 30, input: { objectKey: "outputs/canary/web.mp4", objectVersionId: "web-version",
      sizeBytes: 9000, durationSeconds: 30 } } });

describe("bounded provider canary manifest", () => {
  it("accepts an exact source-bound two-minute-or-less canary", () => {
    expect(validateManifest(manifest())).toEqual(manifest());
  });
  it("rejects another account, long media, unpinned inputs and invalid provider settings", () => {
    for (const change of [{ bucket: "another-bucket" }, { campaignId: "unsafe/id" }, { actorUid: "" },
      { credentialRevision: 0 }, { maxSpeakers: 100 }, { keyVersion: "latest" },
      { job: { ...manifest().job, durationSeconds: 121 } },
      { job: { ...manifest().job, input: { ...manifest().job.input, sizeBytes: 50_000_001 } } },
      { job: { ...manifest().job, input: { ...manifest().job.input, objectVersionId: "" } } }]) {
      expect(() => validateManifest({ ...manifest(), ...change })).toThrow();
    }
  });
});
