import { pathToFileURL } from 'node:url';
import { parseRehearsalPacket } from './public-release-rehearsal.mjs';
import { openDevelopmentRehearsalContext } from './development-rehearsal-credentials.mjs';

// One process per adapter command makes an actual qualifier exit observable.
// Demo children receive emulator identity only. Explicit development children
// receive one bounded credential through fd3, never argv or environment.
let input = '';
let context;
try {
  for await (const bytes of process.stdin) {
    input += bytes;
    if (Buffer.byteLength(input) > 64 * 1024) throw new Error('Request too large');
  }
  const request = JSON.parse(input);
  request.packet = parseRehearsalPacket(request.packet);
  if (request.packet.adapter !== process.argv[2]) throw new Error('Adapter identity differs');
  if (request.packet.schemaVersion === 2) context = await openDevelopmentRehearsalContext();
  const adapter = await import(pathToFileURL(process.argv[2]).href);
  const reply = await adapter.execute(request, context);
  process.stdout.write(JSON.stringify(reply));
} catch {
  process.stderr.write('Rehearsal adapter refused\n');
  process.exitCode = 1;
} finally {
  try { await context?.close(); }
  catch { process.stderr.write('Rehearsal adapter cleanup refused\n'); process.exitCode = 1; }
}
