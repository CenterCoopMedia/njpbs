#!/usr/bin/env node
/** Prepare an inert, dev-only config from the source owner's actual receipt.
 * No credentials, provider calls, selector writes or resource installation. */
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import protocol from '../functions/lib/public-release-pair.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const refuse = () => { throw new Error('Development measurement config refused'); };

export function prepareRoutingMeasurementConfig(source, cases, enabled = false) {
  const receipt = source?.receipt;
  if (source?.dryRun !== false || !receipt || receipt.schemaVersion !== 1 || receipt.kind !== 'routing-measurement-source' ||
      !uuid.test(receipt.measurementId) || source.measurementId !== receipt.measurementId ||
      !digest.test(receipt.sourceDigest) || !Array.isArray(receipt.pairs) || receipt.pairs.length !== 2 || typeof enabled !== 'boolean') refuse();
  // The owner receipt already contains the normalized wire selector, rather
  // than the stored root with its operational timestamp.
  const selector = protocol.parsePublicReleaseSelector(receipt.selector);
  if (selector.state !== 'idle' || receipt.selectorDigest !== protocol.publicReleaseDigest(selector)) refuse();
  const refs = [selector.selectedPair, selector.recoveryPair];
  const pairs = receipt.pairs.map((entry, index) => {
    const pair = protocol.parsePublicReleasePair(entry.pair);
    if (pair.environment !== 'development' ||
        pair.publicWorker.service !== `njpbs-pair-slot-${pair.publicWorker.incarnation}` ||
        protocol.publicReleaseDigest(protocol.publicReleasePairReference(pair)) !== protocol.publicReleaseDigest(refs[index]) ||
        entry.control?.schemaVersion !== 2 || entry.control.pairId !== pair.pairId || entry.control.status !== 'retained' ||
        entry.head?.schemaVersion !== 2 || entry.head.pairDigest !== protocol.publicReleaseDigest(pair) ||
        entry.head.contentHead?.pairId !== pair.pairId ||
        index === 0 && protocol.publicReleaseDigest(entry.head.contentHead) !== protocol.publicReleaseDigest(selector.contentHead)) refuse();
    return pair;
  });
  if (!Array.isArray(cases) || !cases.length || cases.length > 20) refuse();
  const ids = new Set();
  for (const item of cases) {
    if (!item || Object.keys(item).sort().join(',') !== 'bodyDigest,bytes,id,path,status' ||
        !/^[a-z][a-z0-9-]{0,39}$/.test(item.id) || ids.has(item.id) || typeof item.path !== 'string' || item.path.length > 1024 ||
        !/^\/[a-zA-Z0-9/_\-.]*$/.test(item.path) || item.path.includes('..') || item.path.startsWith('//') || item.path === '/_publication-v2.json' ||
        ![200, 308, 410].includes(item.status) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > 4 * 1024 * 1024 ||
        item.status !== 200 && item.bytes !== 0 || !digest.test(item.bodyDigest)) refuse();
    ids.add(item.id);
  }
  return {
    $schema: resolve(root, 'node_modules/wrangler/config-schema.json'),
    name: 'njpbs-dev-routing-measurement', account_id: (process.env.CLOUDFLARE_ACCOUNT_ID ?? ""), main: resolve(root, 'workers/src/public-release-routing-measurement-worker.ts'),
    compatibility_date: '2026-07-09', compatibility_flags: ['nodejs_compat'],
    workers_dev: enabled, preview_urls: false, routes: [],
    vars: { PUBLIC_RELEASE_ROUTING_EXPERIMENT_ENABLED: enabled ? 'true' : 'false', FBASE_PROJECT: 'njpbs-site-dev',
      MEASUREMENT_ID: receipt.measurementId, MEASUREMENT_CASES_JSON: JSON.stringify(cases), PUBLIC_PAIR_IDENTITIES_JSON: JSON.stringify(pairs) },
    version_metadata: { binding: 'CF_VERSION_METADATA' },
    services: [{ binding: 'CMS_API', service: 'template-dev-cms-api', entrypoint: 'PublicContentEntrypoint' },
      ...pairs.map((pair, index) => ({ binding: index ? 'PAIR_SLOT_NEW' : 'PAIR_SLOT_OLD', service: pair.publicWorker.service, entrypoint: 'PublicReleaseSlotEntrypoint' }))],
    observability: { enabled: false },
  };
}
async function json(path, bound) {
  const file = await stat(path);
  if (!file.isFile() || file.size > bound) refuse();
  return JSON.parse(await readFile(path, 'utf8'));
}
async function main() {
  const args = process.argv.slice(2), enabled = args[6] === '--enable-development';
  if (!(args.length === 6 || args.length === 7 && enabled) || args[0] !== '--source' || args[2] !== '--cases' || args[4] !== '--out') refuse();
  const source = await json(args[1], 256 * 1024), cases = await json(args[3], 32 * 1024);
  const config = prepareRoutingMeasurementConfig(source, cases, enabled), output = resolve(args[5]);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify({ output, enabled, sourceReceiptDigest: protocol.publicReleaseDigest(source.receipt), casesDigest: protocol.publicReleaseDigest(cases) }) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write('Development measurement config refused\n'); process.exitCode = 1; });
}
