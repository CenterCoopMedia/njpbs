import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openDemoRehearsalContext } from './development-rehearsal-credentials.mjs';
import { parseRehearsalPacket } from './public-release-rehearsal.mjs';

/** Explicit local setup/execute resources. Every action process opens the
 * same native persisted R2 bucket; this supplies no receipt or authority. */
export async function openRehearsalDemoResources({ packet, directory, authorized = false }) {
  if (authorized !== true) throw new Error('Rehearsal demo resources refused');
  // Existing closed gate refuses ADC, production/development projects and a
  // mismatched emulator before any storage runtime or SDK app can open.
  const bound = parseRehearsalPacket(packet);
  const context = openDemoRehearsalContext(bound);
  let runtime;
  try {
    const path = await realpath(directory);
    const metadata = await stat(path);
    if (path !== resolve(directory) || !metadata.isDirectory() || metadata.mode & 0o077) throw new Error('Rehearsal demo directory refused');
    const { Miniflare } = await import('miniflare');
    const name = `rehearsal-${createHash('sha256').update(JSON.stringify([bound.projectId, bound.runId])).digest('hex').slice(0, 20)}`;
    runtime = new Miniflare({ resourcePersistencePath: path, workers: [{ config: {
      name, type: 'worker', compatibilityDate: '2026-07-09',
      manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm',
        contents: 'export default {fetch(){return new Response(null,{status:404})}}' } } },
      env: { CONTENT: { type: 'r2', name } },
    } }] });
    const store = await runtime.getR2Bucket('CONTENT');
    return { get firestore() { return context.firestore; }, store,
      async close() { try { await runtime.dispose(); } finally { await context.close(); } } };
  } catch (error) {
    try { await runtime?.dispose(); } finally { await context.close(); }
    throw error;
  }
}
