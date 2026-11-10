#!/usr/bin/env node
/** Read-only caller of the isolated development experiment. Token: stdin only. */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const events = ['isolate-start', 'request', 'cache-hit', 'refresh', 'refresh-complete', 'refresh-join', 'refresh-failed', 'invalidation', 'reselection', 'proof'];
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const refuse = () => { throw new Error('Invalid or incomplete development measurement'); };
function snapshot(value) {
  if (!value || !finite(value.ageMs) || !integer(value.refreshSequence) || !value.counts ||
      Object.keys(value.counts).some(key => !events.includes(key) || !integer(value.counts[key])) ||
      value.counts['isolate-start'] !== 1 || (value.counts['refresh-complete'] ?? 0) + (value.counts['refresh-failed'] ?? 0) !== value.refreshSequence) refuse();
  return { ageMs: value.ageMs, counts: { ...value.counts }, refreshSequence: value.refreshSequence };
}

export function validateTarget(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !/^njpbs-dev-routing-measurement\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname) ||
      url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') refuse();
  return url;
}

export function quantiles(values) {
  if (!values.length || values.some(value => !Number.isFinite(value))) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const at = percentile => ordered[Math.max(0, Math.ceil(percentile * ordered.length) - 1)];
  return { n: ordered.length, p50: at(.5), p95: at(.95), p99: at(.99), max: ordered.at(-1) };
}

export function parseSample(value, expected) {
  if (!uuid.test(expected?.measurementId) || !uuid.test(expected?.versionId) || !/^[a-z][a-z0-9-]{0,39}$/.test(expected?.caseId ?? '')) refuse();
  if (!value || value.schemaVersion !== 2 || typeof value.cold !== 'boolean' || typeof value.newInstance !== 'boolean' ||
      !Array.isArray(value.observations) || value.observations.length !== 2) refuse();
  const before = snapshot(value.before);
  if (value.newInstance && ((before.counts.request ?? 0) !== 0 || before.refreshSequence !== 0)) refuse();
  const observations = value.observations.map(item => {
    if (!item || item.schemaVersion !== 2 || item.environment !== 'development' || item.publicationAuthority !== false || item.sampleRate !== 1 ||
        item.measurementId !== expected.measurementId || item.versionId !== expected.versionId || !uuid.test(item.isolateId) ||
        !/^[A-Z]{3}$/.test(item.colo) || item.caseId !== expected.caseId || !['router', 'slot-direct'].includes(item.lane) ||
        !finite(item.ageMs) || !finite(item.headersMs) || !finite(item.bodyMs) || item.bodyMs < item.headersMs ||
        !finite(item.controlSelectorReadMs) || item.lane === 'router' && item.controlSelectorReadMs !== 0 ||
        !integer(item.bytes) || item.bytes > 4 * 1024 * 1024 || !digest.test(item.bodyDigest) ||
        ![200, 308, 410].includes(item.status) || !integer(item.refreshSequence) ||
        item.source?.project !== 'njpbs-site-dev' || item.source?.reader !== 'CMS_API.getRoutingMeasurementSelector' ||
        item.source?.document !== `system/publicReleaseRoutingMeasurements/selectors/${expected.measurementId}` ||
        !item.counts || Object.keys(item.counts).some(key => !events.includes(key) || !integer(item.counts[key])) ||
        item.counts['isolate-start'] !== 1 || !Array.isArray(item.refreshes) || item.refreshes.length > 256) refuse();
    const after = snapshot(item);
    if (after.ageMs < before.ageMs || after.refreshSequence < before.refreshSequence ||
        events.some(event => (after.counts[event] ?? 0) < (before.counts[event] ?? 0))) refuse();
    let last = Math.max(0, item.refreshSequence - 256);
    const refreshes = item.refreshes.map(row => {
      if (!row || row.sequence !== ++last || !finite(row.durationMs) || typeof row.ok !== 'boolean') refuse();
      return { sequence: row.sequence, durationMs: row.durationMs, ok: row.ok };
    });
    if (last !== item.refreshSequence) refuse();
    // Construct the persisted form. Ignore all unexpected fields, never retain
    // response bodies, headers, cookies, authorization or request URLs.
    return { schemaVersion: 2, environment: 'development', publicationAuthority: false, sampleRate: 1,
      measurementId: item.measurementId, versionId: item.versionId, isolateId: item.isolateId, colo: item.colo,
      caseId: item.caseId, lane: item.lane, ageMs: item.ageMs, headersMs: item.headersMs, bodyMs: item.bodyMs,
      controlSelectorReadMs: item.controlSelectorReadMs,
      status: item.status, bytes: item.bytes, bodyDigest: item.bodyDigest,
      source: { project: item.source.project, reader: item.source.reader, document: item.source.document },
      counts: Object.fromEntries(Object.entries(item.counts)), refreshSequence: item.refreshSequence, refreshes };
  });
  const [a, b] = observations;
  if (a.isolateId !== b.isolateId || a.colo !== b.colo || a.lane === b.lane || a.status !== b.status ||
      a.bytes !== b.bytes || a.bodyDigest !== b.bodyDigest || (value.cold && a.lane !== 'router')) refuse();
  return { cold: value.cold, newInstance: value.newInstance, before, observations };
}

export function summarize(samples) {
  if (!samples.length) refuse();
  const isolates = new Map(), refreshes = new Map();
  for (const sample of samples) {
    const first = sample.observations[0];
    let observed = isolates.get(first.isolateId);
    if (!observed) { observed = { versionId: first.versionId, colo: first.colo, starts: 0, snapshots: [], refreshes: new Map(), pairs: 0 }; isolates.set(first.isolateId, observed); }
    observed.pairs++;
    observed.starts += Number(sample.newInstance);
    if (observed.starts > 1) refuse();
    observed.snapshots.push(sample.before);
    for (const item of sample.observations) {
    if (observed.versionId !== item.versionId || observed.colo !== item.colo || item.isolateId !== first.isolateId) refuse();
    observed.snapshots.push(snapshot(item));
    for (const row of item.refreshes) {
      const key = `${item.isolateId}:${row.sequence}`, prior = refreshes.get(key);
      if (prior && (prior.durationMs !== row.durationMs || prior.ok !== row.ok)) refuse();
      refreshes.set(key, row);
      observed.refreshes.set(row.sequence, row);
    }
    }
  }
  let missingRefreshSamples = 0, starts = 0;
  const totals = Object.fromEntries(events.map(event => [event, 0])), windowRefreshes = [];
  for (const observed of isolates.values()) {
    observed.snapshots.sort((a, b) => a.ageMs - b.ageMs || events.reduce((order, event) => order || (a.counts[event] ?? 0) - (b.counts[event] ?? 0), 0) || a.refreshSequence - b.refreshSequence);
    for (let i = 1; i < observed.snapshots.length; i++) {
      const a = observed.snapshots[i - 1], b = observed.snapshots[i];
      if (a.refreshSequence > b.refreshSequence || events.some(event => (a.counts[event] ?? 0) > (b.counts[event] ?? 0))) refuse();
    }
    const first = observed.snapshots[0], last = observed.snapshots.at(-1);
    for (const event of events) totals[event] += (last.counts[event] ?? 0) - (first.counts[event] ?? 0);
    starts += observed.starts;
    const rows = [...observed.refreshes.values()].filter(row => row.sequence > first.refreshSequence && row.sequence <= last.refreshSequence);
    missingRefreshSamples += last.refreshSequence - first.refreshSequence - rows.length;
    windowRefreshes.push(...rows);
    if ((last.counts.request ?? 0) - (first.counts.request ?? 0) !== observed.pairs) refuse();
  }
  if (missingRefreshSamples !== 0) refuse();
  totals['isolate-start'] = starts;
  const rows = samples.flatMap(value => value.observations), router = rows.filter(value => value.lane === 'router'), direct = rows.filter(value => value.lane === 'slot-direct');
  const perCase = Object.fromEntries([...new Set(router.map(row => row.caseId))].map(id => [id, {
    routerHeadersMs: quantiles(router.filter(row => row.caseId === id).map(row => row.headersMs)),
    slotDirectHeadersMs: quantiles(direct.filter(row => row.caseId === id).map(row => row.headersMs)),
  }]));
  return { pairedSamples: samples.length, observedIsolates: isolates.size, observedColos: [...new Set(rows.map(row => row.colo))].sort(),
    newInstancesObserved: starts, unprimedPairs: samples.filter(value => value.cold).length, totals, missingRefreshSamples,
    cacheHitRate: totals.request ? totals['cache-hit'] / totals.request : null,
    readerCallsPerRouterRequest: totals.request ? totals.refresh / totals.request : null,
    controlReaderCalls: direct.length, controlSelectorReadMs: quantiles(direct.map(row => row.controlSelectorReadMs)),
    routerHeadersMs: quantiles(router.map(row => row.headersMs)), slotDirectHeadersMs: quantiles(direct.map(row => row.headersMs)),
    pairedAddedHeadersMs: quantiles(samples.map(value => value.observations.find(row => row.lane === 'router').headersMs - value.observations.find(row => row.lane === 'slot-direct').headersMs)),
    selectorRefreshMs: quantiles(windowRefreshes.filter(row => row.ok).map(row => row.durationMs)),
    failedSelectorRefreshMs: quantiles(windowRefreshes.filter(row => !row.ok).map(row => row.durationMs)), perCase,
    limits: ['Development sample only; no production authority or publication proof.',
      'Observed module instances and first instrumented requests are lower bounds, not physical process births or global churn.',
      'Window counters subtract the first before-snapshot; previous runs and old refresh history are excluded.',
      'Control is the same real private slot without selector routing, not current production HTTP.',
      'Each successful control obtains one separate actual selector receipt; its read latency is excluded from slot timing and reported separately.',
      'Quantiles are empirical nearest ranks; small samples do not establish tail confidence.',
      'Reader RPC attempts are not reconciled billed Firestore retries, Cloud Run compute or egress.'] };
}

async function main() {
  const argv = process.argv.slice(2), args = {};
  if (argv.length % 2) refuse();
  for (let index = 0; index < argv.length; index += 2) {
    if (Object.hasOwn(args, argv[index])) refuse();
    args[argv[index]] = argv[index + 1];
  }
  const allowed = ['--url', '--measurement-id', '--version', '--mix', '--seconds', '--rate', '--out'];
  if (Object.keys(args).some(key => !allowed.includes(key))) refuse();
  const target = validateTarget(args['--url']), measurementId = args['--measurement-id'], versionId = args['--version'];
  const seconds = Number(args['--seconds'] ?? 600), rate = Number(args['--rate'] ?? 1.25);
  if (!uuid.test(measurementId) || !uuid.test(versionId) || !Number.isFinite(seconds) || seconds < 10 || seconds > 3600 ||
      !Number.isFinite(rate) || rate <= 0 || rate > 2 || !args['--out']) refuse();
  const mix = (args['--mix'] ?? '').split(',').map(value => {
    const [id, weight] = value.split('=');
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(id) || !Number.isSafeInteger(Number(weight)) || Number(weight) < 1 || Number(weight) > 100) refuse();
    return { id, weight: Number(weight) };
  });
  if (mix.reduce((n, item) => n + item.weight, 0) !== 100 || new Set(mix.map(item => item.id)).size !== mix.length) refuse();
  let input = '';
  for await (const chunk of process.stdin) { input += chunk.toString(); if (input.length > 1024) refuse(); }
  const token = input.trim();
  if (token.length < 32 || token.length > 512 || /\s/.test(token)) refuse();
  const samples = [], failures = [], tasks = new Set();
  let droppedPacingSlots = 0;
  const started = Date.now(), clock = performance.now();
  const count = Math.floor(seconds * rate);
  if (count < 1) refuse();
  for (let index = 0; index < count; index++) {
    const wait = clock + index * 1000 / rate - performance.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    if (tasks.size >= 4) { droppedPacingSlots++; continue; }
    // Deterministic, evenly spread weighted schedule. No URL/path data in logs.
    let bucket = index * 37 % 100, caseId;
    for (const item of mix) { bucket -= item.weight; if (bucket < 0) { caseId = item.id; break; } }
    const task = (async () => {
      const start = performance.now();
      try {
        const signal = AbortSignal.timeout(20000);
        const response = await fetch(new URL('/sample', target), { method: 'POST', redirect: 'error', signal,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ caseId, routerFirst: index % 2 === 0 }) });
        if (response.status !== 200) throw new Error('refused');
        const text = await readResponseText(response, signal);
        samples.push({ ordinal: index, collectedAt: new Date().toISOString(), clientMs: performance.now() - start,
          ...parseSample(JSON.parse(text), { measurementId, versionId, caseId }) });
      } catch { failures.push({ ordinal: index, caseId, kind: 'refused-or-incomplete' }); }
    })();
    tasks.add(task); void task.finally(() => tasks.delete(task));
  }
  await Promise.all(tasks);
  let summary = null, summaryError = null;
  try { summary = samples.length ? summarize(samples) : null; } catch { summaryError = 'incomplete-or-conflicting-window'; }
  const result = { schemaVersion: 2, environment: 'development', publicationAuthority: false, measurementId, versionId,
    startedAt: new Date(started).toISOString(), endedAt: new Date().toISOString(), requestedRate: rate, mix,
    elapsedSeconds: (Date.now() - started) / 1000, droppedPacingSlots, failures, samples: samples.sort((a, b) => a.ordinal - b.ordinal),
    summary, summaryError, complete: Boolean(summary) && failures.length === 0 && droppedPacingSlots === 0 && samples.length === count,
    costAssessment: { status: 'unmeasured', monthlyCeilingUsd: 50,
      requires: ['Actual billed Firestore reads/retries', 'Cloud Run allocated CPU/memory and billable instance time', 'Worker CPU and egress', 'Account allowances and current regional/contract rates'] } };
  const output = resolve(args['--out']);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify({ output, complete: result.complete, pairedSamples: samples.length, failures: failures.length }) + '\n');
  if (!result.complete) process.exitCode = 1;
}

export async function readResponseText(response, signal) {
  const reader = response.body?.getReader(), parts = [];
  if (!reader) refuse();
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 128 * 1024) refuse();
      parts.push(next.value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts, size));
  } finally { signal.removeEventListener('abort', cancel); cancel(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write('Development measurement refused; no credential or response body logged.\n'); process.exitCode = 1; });
}
