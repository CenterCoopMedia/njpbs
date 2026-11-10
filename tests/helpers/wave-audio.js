// RIFF/WAVE PCM fixture: Four samples per channel, with fields from the WAV format.
export function pcmWave({ channels = 1, sampleRate = 48000, bits = 16 } = {}) {
  const align = channels * bits / 8;
  const length = 4 * align;
  const wav = Buffer.alloc(44 + length);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * align, 28);
  wav.writeUInt16LE(align, 32);
  wav.writeUInt16LE(bits, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(length, 40);
  return wav;
}
