import { describe, expect, it } from 'vitest';
import wave from '../../functions/lib/wave-audio.js';
import media from '../../functions/media.js';
import { pcmWave } from '../helpers/wave-audio.js';

const { inspectWaveAudio } = wave;

describe('uploaded WAV security', () => {
  it.each([
    [1, 48000, 16], [2, 44100, 16], [2, 48000, 24],
  ])('admits PCM %s channels at %s Hz and %s bit', async (channels, sampleRate, bits) => {
    const bytes = pcmWave({ channels, sampleRate, bits });
    expect(inspectWaveAudio(bytes)).toEqual({ channels, sampleRate, bitsPerSample: bits, durationSeconds: 4 / sampleRate });
    await expect(media.inspectUpload(bytes, 'audio/wav')).resolves.toEqual({ width: null, height: null, animated: false });
  });

  it('rejects forged MIME, incomplete chunks, trailing data and compressed audio', async () => {
    const valid = pcmWave();
    const compressed = Buffer.from(valid);
    compressed.writeUInt16LE(6, 20);
    const badAlign = Buffer.from(valid);
    badAlign.writeUInt16LE(3, 32);
    const trailing = Buffer.concat([valid, Buffer.from('x')]);
    trailing.writeUInt32LE(trailing.length - 8, 4);
    for (const bytes of [Buffer.from('not audio'), valid.subarray(0, valid.length - 1), compressed, badAlign, trailing]) {
      await expect(media.inspectUpload(bytes, 'audio/wav')).rejects.toMatchObject({ status: 415 });
    }
  });

  it('rejects the audio size limit independently of the larger image upload limit', async () => {
    await expect(media.inspectUpload(Buffer.alloc(10 * 1024 * 1024 + 1), 'audio/wav'))
      .rejects.toMatchObject({ status: 413 });
  });

  it('rejects formats outside the documented PCM contract', () => {
    for (const options of [{channels: 3}, {sampleRate: 96000}, {bits: 8}]) {
      expect(() => inspectWaveAudio(pcmWave(options))).toThrow('Choose an uncompressed PCM WAV file');
    }
  });
});
