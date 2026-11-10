import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTarget, quantiles, parseSample, summarize, readResponseText } from './measure-public-release-routing.mjs';

const expected = { measurementId: 'f13d7b1e-9f3a-4e7e-b6b9-c909b7f0d363', versionId: '563ced1e-78dd-4717-b9f9-d8fc3e290489', caseId: 'home' };
function sample({ requests = 100, sequence = 5, afterSequence = sequence, age = 1000, newInstance = false } = {}) {
  const counts = (request, seq) => ({ 'isolate-start': 1, request, refresh: seq, 'refresh-complete': seq, 'cache-hit': Math.max(0, request - seq) });
  const row = (lane, request, seq, ageMs) => ({ schemaVersion: 2, environment: 'development', publicationAuthority: false, sampleRate: 1,
    ...expected, isolateId: '16b11b83-8b72-49ef-8bfd-59695c4aa1d9', colo: 'EWR', lane, ageMs,
    headersMs: 1, bodyMs: 2, controlSelectorReadMs: lane === 'slot-direct' ? 4 : 0,
    status: 200, bytes: 3, bodyDigest: 'a'.repeat(64), refreshSequence: seq, counts: counts(request, seq),
    source: { project: 'njpbs-site-dev', reader: 'CMS_API.getRoutingMeasurementSelector', document: `system/publicReleaseRoutingMeasurements/selectors/${expected.measurementId}` },
    refreshes: Array.from({ length: Math.min(seq, 256) }, (_, index) => ({ sequence: Math.max(0, seq - 256) + index + 1, durationMs: 10, ok: true })) });
  const before = { ageMs: age, counts: counts(requests, sequence), refreshSequence: sequence };
  return { schemaVersion: 2, newInstance, cold: newInstance, before, observations: newInstance
    ? [row('router', requests + 1, afterSequence, age + 1), row('slot-direct', requests + 1, afterSequence, age + 2)]
    : [row('slot-direct', requests, sequence, age + 1), row('router', requests + 1, afterSequence, age + 2)] };
}

test('production, alternate hosts, credentials and querystrings refuse', () => {
  for (const url of ['https://njpbs.org/', 'https://dev-public.example.org/', 'https://example.workers.dev/',
    'http://njpbs-dev-routing-measurement.x.workers.dev/', 'https://u:p@njpbs-dev-routing-measurement.x.workers.dev/',
    'https://njpbs-dev-routing-measurement.x.workers.dev/?token=secret']) assert.throws(() => validateTarget(url));
  assert.equal(validateTarget('https://njpbs-dev-routing-measurement.x.workers.dev/').protocol, 'https:');
});
test('nearest-rank tails retain negative paired differences and missing distributions', () => {
  assert.deepEqual(quantiles([-1, 2, 3, 4]), { n: 4, p50: 2, p95: 4, p99: 4, max: 4 });
  assert.equal(quantiles([]), null);
});
test('incomplete or synthesized observations cannot create an isolate or latency result', () => {
  assert.throws(() => parseSample({ schemaVersion: 1, cold: true, observations: [] }, {}));
  assert.throws(() => summarize([]));
});
test('warm collection excludes previous lifetime counters and old refresh history', () => {
  const result = summarize([parseSample(sample(), expected), parseSample(sample({ requests: 101, age: 1003 }), expected)]);
  assert.equal(result.totals.request, 2);
  assert.equal(result.totals.refresh, 0);
  assert.equal(result.cacheHitRate, 1);
  assert.equal(result.newInstancesObserved, 0);
  assert.equal(result.observedIsolates, 1);
  assert.equal(result.selectorRefreshMs, null);
  assert.equal(result.controlReaderCalls, 2); assert.equal(result.controlSelectorReadMs.p50, 4);
});
test('new module counters and repeated refresh observations count once', () => {
  const first = parseSample(sample({ requests: 0, sequence: 0, afterSequence: 1, newInstance: true }), expected);
  const second = parseSample(sample({ requests: 1, sequence: 1, age: 1003 }), expected);
  const result = summarize([first, second]);
  assert.equal(result.totals.request, 2); assert.equal(result.totals.refresh, 1);
  assert.equal(result.newInstancesObserved, 1); assert.equal(result.selectorRefreshMs.n, 1);
  assert.equal(result.cacheHitRate, .5);
});
test('counter reset, duplicate instance starts and missing refresh windows refuse', () => {
  assert.throws(() => summarize([parseSample(sample(), expected), parseSample(sample({ requests: 20, age: 1003 }), expected)]));
  const first = parseSample(sample({ requests: 0, sequence: 0, afterSequence: 1, newInstance: true }), expected);
  assert.throws(() => summarize([first, first]));
  assert.throws(() => summarize([parseSample(sample({ requests: 0, sequence: 0, afterSequence: 257, newInstance: true }), expected)]));
});
test('conflicting retained refresh timings refuse', () => {
  const first = parseSample(sample(), expected), raw = sample({ requests: 101, age: 1003 });
  raw.observations[0].refreshes[0].durationMs++;
  assert.throws(() => summarize([first, parseSample(raw, expected)]));
});
test('persisted samples drop unknown bodies, headers and credential fields', () => {
  const raw = sample();
  raw.authorization = 'never-retain-this-field';
  raw.before.secret = 'never-retain-this-field';
  raw.observations[0].body = 'never-retain-this-field';
  assert.ok(!JSON.stringify(parseSample(raw, expected)).includes('never-retain-this-field'));
  raw.observations[0].bodyDigest = 'b'.repeat(64);
  assert.throws(() => parseSample(raw, expected));
});
test('response size is bounded while streaming and abort cancels a pending body', async () => {
  let cancelled = false;
  const large = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(128 * 1024 + 1)); }, cancel() { cancelled = true; } }));
  await assert.rejects(readResponseText(large, AbortSignal.timeout(1000)));
  assert.equal(cancelled, true);
  const controller = new AbortController();
  const pending = readResponseText(new Response(new ReadableStream()), controller.signal);
  controller.abort();
  await assert.rejects(pending);
});
