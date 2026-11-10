export const WAVEFORM_BUCKET_COUNT = 48;

type OfflineAudioContextConstructor = new (
  numberOfChannels: number,
  length: number,
  sampleRate: number,
) => OfflineAudioContext;

function offlineAudioContextConstructor(): OfflineAudioContextConstructor | undefined {
  const browser = globalThis as typeof globalThis & {
    webkitOfflineAudioContext?: OfflineAudioContextConstructor;
  };
  return browser.OfflineAudioContext ?? browser.webkitOfflineAudioContext;
}

export function aggregateWaveformPeaks(
  channels: readonly Float32Array[],
  bucketCount = WAVEFORM_BUCKET_COUNT,
): number[] {
  if (!Number.isInteger(bucketCount) || bucketCount <= 0) {
    throw new RangeError("Waveform bucket count must be a positive integer.");
  }

  const sampleCount = channels.reduce(
    (largest, channel) => Math.max(largest, channel.length),
    0,
  );
  const peaks = Array.from({ length: bucketCount }, () => 0);
  if (sampleCount === 0 || channels.length === 0) return peaks;

  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = Math.floor((bucket * sampleCount) / bucketCount);
    const end = Math.min(
      sampleCount,
      Math.max(start + 1, Math.floor(((bucket + 1) * sampleCount) / bucketCount)),
    );
    let peak = 0;

    for (const channel of channels) {
      const channelEnd = Math.min(end, channel.length);
      for (let sample = start; sample < channelEnd; sample += 1) {
        const amplitude = Math.abs(channel[sample]);
        if (Number.isFinite(amplitude)) peak = Math.max(peak, amplitude);
      }
    }
    peaks[bucket] = peak;
  }

  const highestPeak = Math.max(...peaks);
  if (highestPeak === 0) return peaks;
  return peaks.map((peak) => Math.min(1, Math.max(0, peak / highestPeak)));
}

export async function deriveWaveformPeaks(blob: Blob): Promise<number[]> {
  const OfflineContext = offlineAudioContextConstructor();
  if (!OfflineContext) {
    throw new Error("Waveform decoding is not supported in this browser.");
  }

  const context = new OfflineContext(1, 1, 44_100);
  const audioBuffer = await context.decodeAudioData(await blob.arrayBuffer());
  const channels = Array.from(
    { length: audioBuffer.numberOfChannels },
    (_, channel) => audioBuffer.getChannelData(channel),
  );
  return aggregateWaveformPeaks(channels);
}
