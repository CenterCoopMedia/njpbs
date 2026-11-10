// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { REHEARSAL_HOLD_OWNER_BLOBS } from '../../scripts/lib/rehearsal-hold-owner-blobs.mjs';

// Keep the mandatory owner paths independent of the manifest: deleting an owner
// from the accepted list must not silently drop its source check.
const files = ['functions/lib/public-release-rehearsal-hold.js', 'functions/lib/public-release-admission.js',
  'site/scripts/public-release-original-continuation.ts', 'site/scripts/public-release-publication-terminal.ts'];
const root = fileURLToPath(new URL('../../', import.meta.url));

it('seals all four mandatory hold owners with reviewed whole-file Git blobs', () => {
  expect(Object.keys(REHEARSAL_HOLD_OWNER_BLOBS).sort()).toEqual([...files].sort());
  for (const entries of Object.values(REHEARSAL_HOLD_OWNER_BLOBS)) {
    expect(entries.length).toBeGreaterThan(0);
    expect(new Set(entries.map(entry => entry.blob)).size).toBe(entries.length);
    for (const entry of entries) {
      expect(entry.blob).toMatch(/^[a-f0-9]{40}$/);
      expect(entry.reviewedIn).toMatch(/^#[1-9]\d*$/);
    }
  }
});

it.each(files)('requires a reviewed accepted-blob entry when %s changes', file => {
  const source = readFileSync(resolve(root, file));
  const blob = createHash('sha1').update(`blob ${source.length}\0`).update(source).digest('hex');
  expect(REHEARSAL_HOLD_OWNER_BLOBS[file].map(entry => entry.blob),
    `${file} changed: add its exact Git blob and reviewing PR to scripts/lib/rehearsal-hold-owner-blobs.mjs in the same PR`).toContain(blob);
});
