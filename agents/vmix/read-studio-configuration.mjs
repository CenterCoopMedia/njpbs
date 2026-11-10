import { readFileSync, statSync } from 'node:fs';
import { pairingApiOrigin, parseStudioConfiguration } from './configuration.mjs';

function readJson(path) {
  if (!path || statSync(path).size > 16000) throw new Error('Invalid configuration size');
  const text = readFileSync(path, 'utf8');
  if (Buffer.byteLength(text) > 16000) throw new Error('Invalid configuration size');
  return JSON.parse(text);
}

try {
  if (process.argv.length !== 4) throw new Error('Configuration paths required');
  const preset = parseStudioConfiguration(readJson(process.argv[2]));
  const apiOrigin = pairingApiOrigin(readJson(process.argv[3]).pairingEndpoint);
  // Setup captures this output in memory. Never print credentials or raw package metadata.
  process.stdout.write(JSON.stringify({ ...preset, apiOrigin }));
} catch {
  process.stderr.write('Private studio configuration is missing or invalid. Check studio-config.json and the package with support.\n');
  process.exitCode = 1;
}
