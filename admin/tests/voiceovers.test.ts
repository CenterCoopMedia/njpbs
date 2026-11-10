import { beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  list: vi.fn(),
  save: vi.fn(),
  audio: vi.fn(),
}));

vi.mock("../src/lib/functions", () => ({
  cmsListVoiceoverReviews: transport.list,
  cmsSaveVoiceoverReview: transport.save,
  cmsGetVoiceoverAudioResponse: transport.audio,
}));

import {
  cmsGetVoiceoverAudio,
  cmsListVoiceovers,
  cmsSaveVoiceoverReview,
} from "../src/lib/voiceovers";

const signal = new AbortController().signal;

beforeEach(() => {
  transport.list.mockReset();
  transport.save.mockReset();
  transport.audio.mockReset();
});

describe("voiceover transport adapter", () => {
  it("sends the versioned list and save bodies through the CMS wrappers", async () => {
    transport.list.mockResolvedValue({ success: true, takes: [], reviews: {} });
    transport.save.mockResolvedValue({
      success: true,
      takeId: "soft-spoken-watching-station-01",
      review: { favorite: true, moreLikeThis: false, notes: "Warm.", version: 1, updatedAt: null },
    });

    await cmsListVoiceovers("id-token", signal);
    await cmsSaveVoiceoverReview("id-token", {
      manifestVersion: 1,
      takeId: "soft-spoken-watching-station-01",
      baseVersion: 0,
      favorite: true,
      moreLikeThis: false,
      notes: "Warm.",
    }, signal);

    expect(transport.list).toHaveBeenCalledWith(
      "id-token",
      { action: "list", schemaVersion: 1 },
      signal,
    );
    expect(transport.save).toHaveBeenCalledWith(
      "id-token",
      {
        action: "save",
        schemaVersion: 1,
        manifestVersion: 1,
        takeId: "soft-spoken-watching-station-01",
        baseVersion: 0,
        favorite: true,
        moreLikeThis: false,
        notes: "Warm.",
      },
      signal,
    );
  });

  it("accepts only a complete WAV response with its declared length", async () => {
    const bytes = new Blob(["wav"], { type: "audio/wav" });
    transport.audio.mockResolvedValue({
      headers: {
        get: (name: string) => {
          if (name === "content-type") return "audio/wav";
          if (name === "content-length") return String(bytes.size);
          return null;
        },
      },
      blob: async () => bytes,
    });

    const result = await cmsGetVoiceoverAudio(
      "id-token",
      "soft-spoken-watching-station-01",
      signal,
    );

    expect(result.type).toBe("audio/wav");
    expect(result.size).toBe(bytes.size);
    expect(transport.audio).toHaveBeenCalledWith(
      "id-token",
      { schemaVersion: 1, takeId: "soft-spoken-watching-station-01" },
      signal,
    );
  });

  it("rejects incomplete bytes and cancels malformed response bodies", async () => {
    const cancel = vi.fn(async () => undefined);
    transport.audio.mockResolvedValueOnce({
      headers: { get: (name: string) => name === "content-type" ? "application/octet-stream" : "3" },
      body: { cancel },
    });
    await expect(cmsGetVoiceoverAudio("id-token", "take-a")).rejects.toThrow(
      "WAV content type",
    );
    expect(cancel).toHaveBeenCalledTimes(1);

    transport.audio.mockResolvedValueOnce({
      headers: {
        get: (name: string) => {
          if (name === "content-type") return "audio/wav";
          if (name === "content-length") return "99";
          return null;
        },
      },
      blob: async () => new Blob(["short"], { type: "audio/wav" }),
    });
    await expect(cmsGetVoiceoverAudio("id-token", "take-b")).rejects.toThrow(
      "incomplete",
    );
  });

  it("does not change a CMS transport refusal into an audio result", async () => {
    const refused = Object.assign(new Error("Denied"), { status: 403, data: {} });
    transport.audio.mockRejectedValue(refused);
    await expect(cmsGetVoiceoverAudio("id-token", "take-c")).rejects.toBe(refused);
  });
});
