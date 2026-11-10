import { describe, expect, it, vi } from "vitest";
import { cancelVideoTranscriptAlignment, clipResolutionAvailable, requestVideoClip, requestVideoTranscriptAlignment, estimateAwsTranscriptionCharge, transcriptionChargeLabel, getVideoTranscript, saveVideoTranscript, parseVideoTime, videoTime } from "../src/lib/video-production";
import { postFunction } from "../src/lib/functions";
import { videoSearchCacheRevision } from "../src/lib/video-search-session-cache";
vi.mock("../src/lib/functions", () => ({ postFunction: vi.fn() }));

it("estimates standard AWS recognition by whole seconds without a minimum", () => {
  expect(estimateAwsTranscriptionCharge(3600)).toBeCloseTo(0.36);
  expect(estimateAwsTranscriptionCharge(0.25)).toBeCloseTo(0.0001);
  expect(estimateAwsTranscriptionCharge(1.1)).toBeCloseTo(0.0002);
  expect(transcriptionChargeLabel(0.0001)).toBe("$0.0001");
  expect(transcriptionChargeLabel(0.36)).toBe("$0.36");
  for (const duration of [0, -1, NaN, Infinity]) expect(estimateAwsTranscriptionCharge(duration)).toBeNull();
});

it("limits explicit clip sizes to the known web-copy short edge", () => {
  expect(clipResolutionAvailable("source", undefined, undefined)).toBe(true);
  expect(clipResolutionAvailable("720p", 720, 1280)).toBe(true);
  expect(clipResolutionAvailable("1080p", 1280, 720)).toBe(false);
  expect(clipResolutionAvailable("480p", 640, 360)).toBe(false);
  for (const size of [undefined, 0, -1, 720.5, NaN]) expect(clipResolutionAvailable("480p", 1280, size)).toBe(false);
});

it("sends the selected clip settings with the saved retry range", async () => {
  vi.mocked(postFunction).mockClear();
  vi.mocked(postFunction).mockResolvedValue({ success: true, clip: {} });
  await requestVideoClip("token", { sourceId: "video-library", assetId: "asset" }, 1000, 2000, true, { resolution: "720p", quality: "high" });
  expect(postFunction).toHaveBeenCalledWith("cmsRequestVideoClip", "token", { sourceId: "video-library", assetId: "asset", inMs: 1000, outMs: 2000, retry: true, resolution: "720p", quality: "high" }, {}, { appCheck: true });
});

it("binds alignment requests and cancellation to the saved transcript revision", async () => {
  vi.mocked(postFunction).mockClear();
  vi.mocked(postFunction).mockResolvedValue({ success: true, cached: false,
    alignment: { state: "queued", timingBasis: "viewing-copy-elapsed" } });
  const identity = { sourceId: "video-library", assetId: "asset" };
  const transcriptId = "a".repeat(64);
  const requestId = "b".repeat(64);
  await requestVideoTranscriptAlignment("token", identity, transcriptId, 3, true);
  expect(postFunction).toHaveBeenLastCalledWith("cmsRequestVideoTranscriptAlignment", "token",
    { ...identity, transcriptId, revision: 3, retry: true }, {}, { appCheck: true });
  await cancelVideoTranscriptAlignment("token", identity, transcriptId, 3, requestId);
  expect(postFunction).toHaveBeenLastCalledWith("cmsCancelVideoTranscriptAlignment", "token",
    { ...identity, transcriptId, revision: 3, requestId }, {}, { appCheck: true });
});

describe("video selection time", () => {
  it.each([["00:00:00.250", 250], ["1.234", 1234], ["01:02:03.004", 3723004], [" 12.5 ", 12500]])("accepts %s", (input, expected) => {
    expect(parseVideoTime(input)).toBe(expected);
    expect(parseVideoTime(videoTime(expected / 1000))).toBe(expected);
  });
  it.each(["", "-1", "1e3", "00:60:00", "00:00:60", "1.1234", "99999999999999999999999", "00:00:01junk"])("rejects %s", input => {
    expect(parseVideoTime(input)).toBeNull();
  });
});
it("reads saved speaker segments and paging from the server transcript envelope", async () => {
  const segment = { speaker: "spk_0", startSeconds: 1, endSeconds: 2, text: "Saved words" };
  vi.mocked(postFunction).mockResolvedValue({ success: true, cached: true, transcript: { id: "saved", state: "ready", segments: [segment], nextCursor: "next" } });
  const response = await getVideoTranscript("token", { sourceId: "video-library", assetId: "asset" }, { languageCode: "en-US", maxSpeakers: 10 });
  expect(response.segments).toEqual([segment]);
  expect(response.nextCursor).toBe("next");
  expect(postFunction).toHaveBeenCalledWith("cmsGetVideoTranscript", "token", expect.any(Object), {}, { appCheck: "unless-automation" });
});

it("saves text and speaker corrections against the loaded revision without requesting transcription", async () => {
  vi.mocked(postFunction).mockClear();
  const transcript = { id: "saved", state: "ready", editRevision: 2, speakerNames: { spk_0: "Reporter" }, segments: [{ index: 0, speaker: "spk_0", startSeconds: 1, endSeconds: 2, text: "Correct words" }], nextCursor: null };
  vi.mocked(postFunction).mockResolvedValue({ success: true, cached: true, transcript });
  const edits = { revision: 1, segments: [{ index: 0, text: "Correct words" }], speakerNames: { spk_0: "Reporter" } };
  const cacheRevision = videoSearchCacheRevision();
  const response = await saveVideoTranscript("token", { sourceId: "video-library", assetId: "asset" }, { languageCode: "en-US", maxSpeakers: 10 }, edits);
  expect(videoSearchCacheRevision()).toBe(cacheRevision + 1);
  expect(response.transcript.editRevision).toBe(2);
  expect(response.segments).toEqual(transcript.segments);
  expect(postFunction).toHaveBeenCalledExactlyOnceWith("cmsSaveVideoTranscript", "token", { sourceId: "video-library", assetId: "asset", languageCode: "en-US", maxSpeakers: 10, ...edits }, {}, { appCheck: true });
});

it("sends rational Avid frame settings only for Avid downloads", async () => {
  const { readVideoTranscript } = await import("../src/lib/video-production");
  vi.mocked(postFunction).mockClear();
  vi.mocked(postFunction).mockResolvedValue({ success: true, url: "https://example.test/download", expiresAt: "2026-09-15" });
  const identity = { sourceId: "video-library", assetId: "asset" };
  const settings = { languageCode: "en-US", maxSpeakers: 10 } as const;
  const frames = { frameRate: "30000/1001", frameOffset: 1800 } as const;
  await readVideoTranscript("token", identity, settings, "avid", frames);
  expect(vi.mocked(postFunction).mock.lastCall?.[2]).toEqual({ ...identity, ...settings, format: "avid", ...frames });
  await readVideoTranscript("token", identity, settings, "premiere", frames);
  expect(vi.mocked(postFunction).mock.lastCall?.[2]).toEqual({ ...identity, ...settings, format: "premiere" });
});


it("preserves the server request policy when reading a transcript", async () => {
  const requestPolicy = { enabled: true, provider: "amazon-transcribe", fallbackEnabled: false };
  vi.mocked(postFunction).mockResolvedValue({ success: true, cached: false, requestPolicy, transcript: { state: "not_requested" } });
  const result = await getVideoTranscript("token", { sourceId: "video-library", assetId: "asset" }, { languageCode: "en-US", maxSpeakers: 10 });
  expect(result.requestPolicy).toEqual(requestPolicy);
});
