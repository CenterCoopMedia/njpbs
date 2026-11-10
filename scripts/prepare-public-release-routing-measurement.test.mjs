import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { prepareRoutingMeasurementConfig } from './prepare-public-release-routing-measurement.mjs';
import protocol from '../functions/lib/public-release-pair.js';
const require = createRequire(import.meta.url);
const { releasePair, releaseSelector } = require('../tests/helpers/private-public-release-pair.js');
function input() {
  const pairs = [releasePair(), releasePair('b', 'b'.repeat(40))], selector = releaseSelector();
  const measurementId = 'f13d7b1e-9f3a-4e7e-b6b9-c909b7f0d363';
  const receipt = { schemaVersion: 1, kind: 'routing-measurement-source', measurementId,
    sourceDigest: protocol.publicReleaseDigest(selector), selectorDigest: protocol.publicReleaseDigest(selector), selector,
    pairs: pairs.map(pair => ({ pair, control: { schemaVersion: 2, pairId: pair.pairId, status: 'retained' },
      head: { schemaVersion: 2, pairDigest: protocol.publicReleaseDigest(pair), contentHead: { ...selector.contentHead, pairId: pair.pairId } } })) };
  return { source: { dryRun: false, measurementId, receipt }, cases: [{ id: 'home', path: '/', status: 200, bytes: 3, bodyDigest: 'a'.repeat(64) }] };
}
test('default configuration is disabled, has no routes and uses exact retained dev slot entrypoints', () => {
  const { source, cases } = input(), config = prepareRoutingMeasurementConfig(source, cases);
  assert.equal(config.name, 'njpbs-dev-routing-measurement');
  assert.equal(config.workers_dev, false); assert.equal(config.preview_urls, false); assert.deepEqual(config.routes, []);
  assert.equal(config.vars.PUBLIC_RELEASE_ROUTING_EXPERIMENT_ENABLED, 'false');
  assert.equal(config.services[1].service, source.receipt.pairs[0].pair.publicWorker.service);
  assert.equal(config.services[1].entrypoint, 'PublicReleaseSlotEntrypoint');
  assert.equal(JSON.stringify(config).includes('MEASUREMENT_SECRET'), false);
  assert.equal(prepareRoutingMeasurementConfig(source, cases, true).workers_dev, true);
});
test('unapplied, missing, changed, retired or production source receipts refuse', () => {
  for (const kind of ['dryrun', 'missing', 'digest', 'retired', 'production', 'head']) {
    const { source, cases } = input();
    if (kind === 'dryrun') source.dryRun = true;
    if (kind === 'missing') source.receipt.pairs.pop();
    if (kind === 'digest') source.receipt.selectorDigest = 'f'.repeat(64);
    if (kind === 'retired') source.receipt.pairs[0].control.status = 'retired';
    if (kind === 'production') source.receipt.pairs[0].pair.environment = 'production';
    if (kind === 'head') source.receipt.pairs[0].head.contentHead.manifestDigest = 'f'.repeat(64);
    assert.throws(() => prepareRoutingMeasurementConfig(source, cases));
  }
});
test('unpinned bytes, proof paths and unexpected failure statuses refuse', () => {
  for (const kind of ['digest', '404', 'proof', 'duplicate', 'url']) {
    const { source, cases } = input();
    if (kind === 'digest') delete cases[0].bodyDigest;
    if (kind === '404') cases[0].status = 404;
    if (kind === 'proof') cases[0].path = '/_publication-v2.json';
    if (kind === 'duplicate') cases.push({ ...cases[0] });
    if (kind === 'url') cases[0].path = '//njpbs.org/';
    assert.throws(() => prepareRoutingMeasurementConfig(source, cases));
  }
});
