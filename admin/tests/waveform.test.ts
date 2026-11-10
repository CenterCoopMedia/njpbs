import { afterEach, describe, expect, it, vi } from "vitest";
import {
  aggregateWaveformPeaks,
  deriveWaveformPeaks,
  WAVEFORM_BUCKET_COUNT,
} from "../src/lib/waveform";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("waveform peaks", () => {
  it("takes the real maximum amplitude across every decoded channel", () => {
    const peaks = aggregateWaveformPeaks([
      new Float32Array([0.25, -0.5, 0, 0.2]),
      new Float32Array([0.1, 0.25, -1, 0.1]),
    ], 4);

    expect(peaks).toHaveLength(4);
    expect(peaks[0]).toBeCloseTo(0.25);
    expect(peaks[1]).toBeCloseTo(0.5);
    expect(peaks[2]).toBe(1);
    expect(peaks[3]).toBeCloseTo(0.2);
  });

  it("keeps silent and invalid samples finite without inventing amplitude", () => {
    const peaks = aggregateWaveformPeaks([
      new Float32Array([0, -0, Number.NaN, Number.POSITIVE_INFINITY]),
    ]);

    expect(peaks).toHaveLength(WAVEFORM_BUCKET_COUNT);
    expect(peaks.every((peak) => peak === 0 && Number.isFinite(peak))).toBe(true);
  });

  it("rejects decode failures so playback callers can ignore waveform support", async () => {
    const failure = new Error("Audio decode failed");
    class FailingOfflineAudioContext {
      decodeAudioData() {
        return Promise.reject(failure);
      }
    }
    vi.stubGlobal("OfflineAudioContext", FailingOfflineAudioContext);

    const blob = {
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(1)),
    } as unknown as Blob;
    await expect(deriveWaveformPeaks(blob)).rejects.toBe(failure);
  });

  it("rejects cleanly when offline decoding is unavailable", async () => {
    vi.stubGlobal("OfflineAudioContext", undefined);
    vi.stubGlobal("webkitOfflineAudioContext", undefined);

    await expect(deriveWaveformPeaks(new Blob(["audio"]))).rejects.toThrow(
      "Waveform decoding is not supported in this browser.",
    );
  });
});
