"use strict";

// The media library accepts the same audio container as the voiceover library: an
// uncompressed PCM RIFF/WAVE file. Voiceover takes are mono 48 kHz 16-bit PCM; library
// uploads also allow stereo, 44.1 kHz and 24-bit PCM, which browsers play natively.

const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;
// KSDATAFORMAT_SUBTYPE_PCM, as stored little-endian in the extensible format chunk.
const PCM_SUBFORMAT = Buffer.from("0100000000001000800000aa00389b71", "hex");
const SAMPLE_RATES = new Set([44_100, 48_000]);
const BITS_PER_SAMPLE = new Set([16, 24]);
const MIN_WAVE_BYTES = 44;

class WaveAudioError extends Error {
  constructor(message) {
    super(message);
    this.name = "WaveAudioError";
  }
}

function chunkName(buffer, offset) {
  return buffer.toString("ascii", offset, offset + 4);
}

function pcmCodec(buffer, start, size) {
  const codec = buffer.readUInt16LE(start);
  if (codec === WAVE_FORMAT_PCM) return true;
  // The extensible chunk carries the real codec as a 16-byte subformat GUID at offset 24.
  return codec === WAVE_FORMAT_EXTENSIBLE && size >= 40 && buffer.readUInt16LE(start + 16) >= 22 &&
    buffer.readUInt16LE(start + 18) === buffer.readUInt16LE(start + 14) &&
    buffer.subarray(start + 24, start + 40).equals(PCM_SUBFORMAT);
}

/**
 * Checks that a buffer is a complete PCM WAV file and returns its format.
 * @param {Buffer} buffer
 * @returns {{channels: number, sampleRate: number, bitsPerSample: number, durationSeconds: number}}
 */
function inspectWaveAudio(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < MIN_WAVE_BYTES ||
      chunkName(buffer, 0) !== "RIFF" || chunkName(buffer, 8) !== "WAVE") {
    throw new WaveAudioError("The file is not a WAV file");
  }
  if (buffer.readUInt32LE(4) + 8 !== buffer.length) {
    throw new WaveAudioError("The WAV file is incomplete");
  }

  let format = null;
  let dataBytes = null;
  let offset = 12;
  for (; offset + 8 <= buffer.length;) {
    const name = chunkName(buffer, offset);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.length) throw new WaveAudioError("The WAV file is incomplete");
    if (name === "fmt ") {
      if (format || size < 16) throw new WaveAudioError("The WAV format chunk is invalid");
      format = {
        pcm: pcmCodec(buffer, start, size),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        byteRate: buffer.readUInt32LE(start + 8),
        blockAlign: buffer.readUInt16LE(start + 12),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      };
    } else if (name === "data") {
      if (dataBytes !== null) throw new WaveAudioError("The WAV file has more than one data chunk");
      dataBytes = size;
    }
    if (end + (size % 2) > buffer.length) throw new WaveAudioError("The WAV file is incomplete");
    offset = end + (size % 2);
  }
  if (offset !== buffer.length) throw new WaveAudioError("The WAV file has incomplete trailing data");
  if (!format || dataBytes === null || dataBytes < 1) {
    throw new WaveAudioError("The WAV file needs format and audio data chunks");
  }
  const { channels, sampleRate, bitsPerSample, blockAlign, byteRate } = format;
  if (!format.pcm || (channels !== 1 && channels !== 2) ||
      !SAMPLE_RATES.has(sampleRate) || !BITS_PER_SAMPLE.has(bitsPerSample)) {
    throw new WaveAudioError(
      "Choose an uncompressed PCM WAV file: mono or stereo, 44.1 or 48 kHz, 16 or 24 bit",
    );
  }
  if (blockAlign !== channels * (bitsPerSample / 8) || byteRate !== sampleRate * blockAlign ||
      dataBytes % blockAlign !== 0) {
    throw new WaveAudioError("The WAV format chunk does not match its audio data");
  }
  return { channels, sampleRate, bitsPerSample, durationSeconds: dataBytes / byteRate };
}

module.exports = { WaveAudioError, inspectWaveAudio };
