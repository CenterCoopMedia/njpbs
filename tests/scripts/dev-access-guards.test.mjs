import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.CLOUDFLARE_ACCOUNT_ID ??= 'a'.repeat(32);
process.env.CMS_DEV_CLOUDFLARE_ACCOUNT_ID ??= 'a'.repeat(32);
process.env.CMS_DEV_ACCESS_ORIGIN ??= 'https://access.example.org';
const { checkDevAnonymousRefusal } = await import('../../scripts/check-dev-anonymous-refusal.mjs');
const { guardDevRoutingChange } = await import('../../scripts/guard-dev-routing-change.mjs');

const responses = JSON.parse(readFileSync(new URL('./fixtures/access-responses.json', import.meta.url)));
const zone = 'a'.repeat(32);
const recordId = 'b'.repeat(32);
const quiet = () => {};

function response(fixture) { return new Response(null, fixture); }

test('restored Access redirects pass GET and HEAD on all four URLs and both hosts, without identity', async () => {
  const requests = [];
  await checkDevAnonymousRefusal({ log: quiet, fetchImpl: async (url, init) => {
    requests.push(`${init.method} ${url}`);
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.headers, undefined);
    return response({ ...responses.restored, headers: {
      location: `https://access.example.org/cdn-cgi/access/login/${new URL(url).host}`,
    } });
  } });
  assert.equal(requests.length, 16);
  for (const host of ['dev-public.example.org', 'dev-admin.example.org']) {
    for (const path of ['/', '/posts/access-probe/', '/_publication.json', '/brand/njpbs-horizontal-white-navy.png']) {
      for (const method of ['GET', 'HEAD']) assert.ok(requests.includes(`${method} https://${host}${path}`));
    }
  }
});

for (const [name, fixture] of Object.entries({
  'exposed Home and receipt': responses.exposed,
  'exposed removed Post': responses.removedPost,
  '2xx with private headers': { status: 204, headers: { 'cache-control': 'private, no-store' } },
  'cacheable refusal': { status: 403, headers: { 'cache-control': 'max-age=60' } },
  'public refusal even with no-store': { status: 401, headers: { 'cache-control': 'public, no-store' } },
  'cacheable Access redirect': { status: 302, headers: { ...responses.restored.headers, 'cache-control': 'max-age=0, must-revalidate' } },
  'wrong Access team': { status: 302, headers: { location: 'https://other.cloudflareaccess.com/cdn-cgi/access/login/dev-public.example.org' } },
  'wrong login hostname': { status: 302, headers: { location: 'https://access.example.org/cdn-cgi/access/login/njpbs.org' } },
  'generic edge 403': { status: 403, headers: { 'cache-control': 'no-store' } },
  'bare 401': { status: 401 },
  'ordinary redirect': { status: 301, headers: responses.restored.headers },
})) {
  test(`anonymous proof rejects ${name} without leaking response data`, async () => {
    const lines = [];
    await assert.rejects(checkDevAnonymousRefusal({ hosts: ['dev-public.example.org'], log: line => lines.push(line),
      fetchImpl: async () => response(fixture) }), /refusal failed/);
    assert.ok(!lines.join().includes('cloudflareaccess.com'));
    assert.ok(!lines.join().includes('cache-control'));
  });
}

const refusalHeaders = {
  'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow, noarchive',
  'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
};
// Body and headers are the existing staff-site-worker.ts response() contract.
for (const status of [401, 403]) test(`known gateway ${status} is a refusal`, async () => {
  await checkDevAnonymousRefusal({ log: quiet, fetchImpl: async (_url, init) => new Response(
    init.method === 'HEAD' ? null : status === 401 ? 'Unauthorized' : 'Site access unavailable',
    { status, headers: refusalHeaders },
  ) });
});

for (const body of ['WAF blocked', 'x'.repeat(257)]) test(`unknown denial body fails (${body.length} bytes)`, async () => {
  await assert.rejects(checkDevAnonymousRefusal({ log: quiet, fetchImpl: async (_url, init) => new Response(
    init.method === 'HEAD' ? null : body, { status: 403, headers: refusalHeaders },
  ) }), /refusal failed/);
});

test('a failed HEAD on one asset fails the whole otherwise-safe round', async () => {
  await assert.rejects(checkDevAnonymousRefusal({ hosts: ['dev-public.example.org'], log: quiet,
    fetchImpl: async (url, init) => response(init.method === 'HEAD' && url.endsWith('.png') ? responses.exposed : responses.restored),
  }), /refusal failed/);
});

test('transport errors are failures and raw errors stay private', async () => {
  const lines = [];
  await assert.rejects(checkDevAnonymousRefusal({ log: line => lines.push(line), fetchImpl: async () => {
    throw new Error('private transport detail');
  } }), /refusal failed/);
  assert.ok(!lines.join().includes('private transport detail'));
});

// Cloudflare JSON envelopes/PUT fields follow the provider API. Only HTTP and
// time are faked; snapshots use a real private file and the real probe functions.
function harness(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'devguard-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const receiptPath = join(directory, 'receipt.jsonl');
  const route = options.route;
  const initial = route ? { id: recordId, pattern: 'dev-public.example.org/*', script: 'njpbs-staff-sites', request_limit_fail_open: false } :
    { id: recordId, ...responses.beforeDns, comment: 'Staff only', tags: ['owner:station'], settings: { flatten_cname: false } };
  if (options.wrongOwner) initial.script = 'unexpected-owner';
  let current = structuredClone(initial);
  const mutations = [];
  let time = 0;
  let changedAt;
  let recordReads = 0;
  let lateApplied = false;
  let delayedWrite;
  const env = { CLOUDFLARE_API_TOKEN: 'fixture-only', DEV_ROUTING_CHANGE_APPROVED: 'true',
    DEV_ACCESS_AUDIENCE: 'c'.repeat(64), CMS_DEV_ACCESS_CLIENT_ID: 'fixture-id', CMS_DEV_ACCESS_CLIENT_SECRET: 'fixture-secret', ...options.env };
  const plan = { kind: route ? 'route' : 'dns', host: 'dev-public.example.org', recordId,
    versionId: '11111111-1111-1111-1111-111111111111', sourceSha: 'd'.repeat(40),
    change: route ? { script: 'njpbs-dev-staff-sites' } : { type: 'A', content: '192.0.2.1' }, ...options.plan };
  const fetchImpl = async (url, init) => {
    if (url.startsWith('https://api.cloudflare.com/')) {
      assert.equal(init.headers.Authorization, 'Bearer fixture-only');
      if (url.includes('/zones?')) return Response.json({ success: true, result: [
        { id: zone, name: 'njpbs.org', account: { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } },
      ] });
      if (route && !url.endsWith(`/${recordId}`)) {
        const bindings = [
          { type: 'plain_text', name: 'DEV_ACCESS_AUDIENCE', text: 'c'.repeat(64) },
          { type: 'plain_text', name: 'CMS_DEV_ACCESS_ORIGIN', text: 'https://access.example.org' },
          { type: 'service', name: 'DEV_STAFF_ACCESS', service: 'template-dev-cms-api', entrypoint: 'StaffSiteEntrypoint' },
          { type: 'service', name: 'DEV_PUBLIC', service: options.wrongBinding ? 'njpbs-production' : 'template-dev-public' },
        ];
        let result;
        if (url.endsWith('/workers/routes')) result = [current, ...(options.extraRoute || (options.routeDrift && mutations.length) ?
          [{ id: 'e'.repeat(32), pattern: '*.example.org/*', script: 'unexpected' }] : [])];
        else if (url.endsWith('/deployments')) result = { deployments: [{ versions: [
          { version_id: plan.versionId, percentage: options.splitVersion ? 50 : 100 },
        ] }] };
        else if (url.includes('/versions/')) result = { id: plan.versionId,
          annotations: { 'workers/message': `dev-staff-gateway:${options.wrongSource ? 'e'.repeat(40) : plan.sourceSha}` },
          resources: { bindings } };
        else if (url.includes('/template-dev-cms-api/settings')) result = { bindings: Object.entries({
          CMS_DEPLOYMENT_ENVIRONMENT: options.productionApi ? 'production' : 'development',
          FIREBASE_PROJECT_ID: 'njpbs-site-dev',
          FUNCTIONS_ORIGIN: 'https://us-central1-njpbs-site-dev.cloudfunctions.net', ADMIN_ORIGIN: 'https://dev-admin.example.org',
        }).map(([name, text]) => ({ name, text, type: 'plain_text' })) };
        else if (url.endsWith('/settings')) result = { bindings: url.includes('/template-dev-public/') ?
          [{ name: 'ASSETS', type: 'assets' },
            { name: 'CMS_API', type: 'service', service: 'template-dev-cms-api', entrypoint: 'PublicContentEntrypoint' },
            { name: 'NO_BUILD_POST_RENDERER_SHA', type: 'plain_text', text: plan.sourceSha }] : bindings };
        else if (url.endsWith('/subdomain')) result = { enabled: Boolean(options.publicOrigin), previews_enabled: false };
        else if (url.includes('/workers/domains?')) result = [];
        else assert.fail('Unexpected route verification URL');
        return Response.json({ success: true, result });
      }
      assert.equal(url, `https://api.cloudflare.com/client/v4/zones/${zone}/${route ? 'workers/routes' : 'dns_records'}/${recordId}`);
      if (init.method === 'PUT') {
        mutations.push(JSON.parse(init.body));
        if (options.restoreFails && mutations.length >= 2) return Response.json({ success: false }, { status: 403 });
        if (options.transientRestoreFailure && mutations.length === 2) return Response.json({ success: false }, { status: 503 });
        const payload = JSON.parse(init.body);
        if (!route) {
          // Provider schema: flatten_cname belongs only to CNAME settings.
          const allowed = payload.type === 'CNAME' ? ['flatten_cname', 'ipv4_only', 'ipv6_only'] : ['ipv4_only', 'ipv6_only'];
          assert.ok(Object.keys(payload.settings ?? {}).every(key => allowed.includes(key)));
        }
        if (options.lateWrite && mutations.length === 1) {
          delayedWrite = payload;
          changedAt = time;
          throw new Error('lost response before commit');
        }
        current = { ...current, ...payload };
        if (options.omitFalseDefaults && !route) current.settings = Object.fromEntries(
          Object.entries(current.settings ?? {}).filter(([, value]) => value !== false),
        );
        changedAt ??= time;
        if (options.lostReply && mutations.length === 1) throw new Error('private error after committed write');
      }
      if (init.method === 'GET') recordReads++;
      if (options.lateWrite && mutations.length >= 2 && !lateApplied && time >= 30_000) {
        current = { ...current, ...delayedWrite };
        lateApplied = true;
      }
      if (options.race && recordReads === 2 && mutations.length === 0) current.content = 'other.pages.dev';
      return Response.json({ success: true, result: current });
    }
    if (options.lateDuringProof && mutations.length === 2 && time >= 30_000) {
      current = { ...current, ...mutations[0] };
    }
    const changed = mutations.length === 1 || (options.lateDuringProof && current.type === 'A');
    if (init.headers?.['CF-Access-Client-Id']) {
      assert.equal(url, 'https://dev-public.example.org/_publication.json');
      assert.equal(init.headers['CF-Access-Client-Secret'], 'fixture-secret');
      if (options.machineFails && changed) return response(responses.exposed);
      return new Response(init.method === 'HEAD' ? null : '{}', {
        status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
      });
    }
    assert.equal(init.headers, undefined);
    if ((options.restoreProofFails && mutations.length >= 2) || options.preflightFails || (changed && !options.safe && time - changedAt >= (options.failureAfter ?? 0))) {
      return response(responses.exposed);
    }
    return response(responses.restored);
  };
  const lines = [];
  return { initial, mutations, current: () => current, receiptPath, lines,
    run: (overrides = {}) => guardDevRoutingChange({ plan, env, receiptPath, apply: true, fetchImpl,
      readMainSha: () => options.wrongMain ? 'e'.repeat(40) : 'd'.repeat(40),
      now: () => time, wait: async ms => { time += ms; }, log: line => lines.push(line), ...overrides }) };
}

test('the access recovery sequence restores the exact previous DNS record on the first failed round', async t => {
  const h = harness(t, { failureAfter: 30_000 });
  await assert.rejects(h.run(), /previous record restored/);
  assert.deepEqual(h.current(), h.initial);
  assert.equal(h.mutations.length, 2);
  const { id, ...previous } = h.initial;
  assert.deepEqual(h.mutations[1], previous);
  assert.equal(statSync(h.receiptPath).mode & 0o777, 0o600);
  const receipt = readFileSync(h.receiptPath, 'utf8');
  assert.ok(receipt.includes('restored proof passed'));
  assert.ok(!receipt.includes('fixture-secret'));
});

for (const [name, options] of Object.entries({ 'route bypass': { route: true }, 'lost write reply': { lostReply: true },
  'machine contract failure': { safe: true, machineFails: true } })) {
  test(`${name} restores prior state`, async t => {
    const h = harness(t, options);
    await assert.rejects(h.run(), /previous record restored/);
    assert.deepEqual(h.current(), h.initial);
    assert.equal(h.mutations.length, 2);
  });
}

test('safe responses throughout the full window retain the desired change', async t => {
  const h = harness(t, { safe: true });
  await h.run();
  assert.equal(h.mutations.length, 1);
  assert.equal(h.current().type, 'A');
  const events = readFileSync(h.receiptPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).event, 'accepted');
  assert.equal(Date.parse(events.at(-1).at) - Date.parse(events[0].at), 120_000);
});

test('failed preflight cannot change DNS', async t => {
  const h = harness(t, { preflightFails: true });
  await assert.rejects(h.run());
  assert.equal(h.mutations.length, 0);
});

test('restoration failure is explicit and cannot report success', async t => {
  const h = harness(t, { restoreFails: true });
  await assert.rejects(h.run(), /restoration is unverified/);
  assert.ok(h.lines.some(line => line.startsWith('RESTORE FAILED')));
});

test('abort during the observation window restores despite the cancelled signal', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const h = harness(t, { safe: true });
  const controller = new AbortController();
  await assert.rejects(h.run({ signal: controller.signal, wait: async (ms, _value, options) => {
    if (options?.signal) {
      controller.abort();
      controller.signal.throwIfAborted();
    }
    // Recovery ignores the caller's abort and uses its own bounded clock.
    t.mock.timers.tick(ms);
  }, now: Date.now }), /previous record restored/);
  assert.deepEqual(h.current(), h.initial);
});

for (const plan of [{ host: 'njpbs.org' }, { change: { type: 'A', content: '192.0.2.1', proxied: false } },
  { kind: 'route', change: { script: 'njpbs-production' } },
  { kind: 'route', change: { script: 'template-dev-public' } },
  { kind: 'route', change: { script: 'template-dev-cms-api' } },
  { kind: 'route', host: 'dev-admin.example.org', change: { script: 'njpbs-dev-staff-sites' } }]) {
  test(`unsafe plan rejected: ${JSON.stringify(plan)}`, async t => {
    const h = harness(t, { plan });
    await assert.rejects(h.run());
    assert.equal(h.mutations.length, 0);
  });
}

test('missing machine credentials need an explicit recorded reason', async t => {
  const h = harness(t, { env: { CMS_DEV_ACCESS_CLIENT_ID: '', CMS_DEV_ACCESS_CLIENT_SECRET: '' } });
  await assert.rejects(h.run(), /Record why/);
  assert.equal(h.mutations.length, 0);
});


test('a concurrent preflight record edit is preserved without a write', async t => {
  const h = harness(t, { race: true });
  await assert.rejects(h.run(), /Record changed during preflight/);
  assert.equal(h.mutations.length, 0);
  assert.equal(h.current().content, 'other.pages.dev');
});


test('restored DNS with continued exposure is an explicit escalation', async t => {
  const h = harness(t, { restoreProofFails: true });
  await assert.rejects(h.run(), /restored but HTTP verification failed/);
  assert.deepEqual(h.current(), h.initial);
  assert.ok(h.lines.some(line => line.startsWith('RESTORED BUT PROOF FAILED')));
  assert.ok(readFileSync(h.receiptPath, 'utf8').includes('restored proof failed'));
});


test('a timed-out PUT that commits after initial restore is restored again during recovery', async t => {
  const h = harness(t, { lateWrite: true });
  await assert.rejects(h.run(), /previous record restored/);
  assert.equal(h.mutations.length, 3);
  assert.deepEqual(h.current(), h.initial);
  const events = readFileSync(h.receiptPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(Date.parse(events.at(-1).at), 120_000);
});

test('CNAME-to-A payload uses address settings and recovery retains CNAME settings', async t => {
  const h = harness(t);
  await assert.rejects(h.run(), /previous record restored/);
  assert.deepEqual(h.mutations[0].settings, { ipv4_only: false, ipv6_only: false });
  assert.deepEqual(h.mutations[1].settings, { flatten_cname: false });
});


test('provider omission of false DNS defaults still accepts a safe type change', async t => {
  const h = harness(t, { safe: true, omitFalseDefaults: true });
  await h.run();
  assert.equal(h.mutations.length, 1);
  assert.equal(h.current().type, 'A');
  assert.deepEqual(h.current().settings, {});
});


test('a transient restore API failure is repaired within the recovery window', async t => {
  const h = harness(t, { transientRestoreFailure: true });
  await assert.rejects(h.run(), /previous record restored/);
  assert.equal(h.mutations.length, 3);
  assert.deepEqual(h.current(), h.initial);
  assert.ok(h.lines.some(line => line.includes('retrying within the recovery window')));
  assert.ok(!h.lines.some(line => line.startsWith('RESTORE FAILED')));
});


test('CLI prints safe preflight errors but never parser input', t => {
  const directory = mkdtempSync(join(tmpdir(), 'devguard-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const plan = join(directory, 'plan.json');
  const run = () => spawnSync(process.execPath, ['scripts/guard-dev-routing-change.mjs', plan,
    join(directory, 'receipt.jsonl')], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  writeFileSync(plan, JSON.stringify({ host: 'dev-public.example.org', kind: 'dns', recordId,
    change: { type: 'A', content: '192.0.2.1' } }));
  const safe = run();
  assert.equal(safe.status, 1);
  assert.match(safe.stderr, /Explicit approved apply is required/);
  writeFileSync(plan, '{"private":"fixture-private-parser-input",broken}');
  const malformed = run();
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /Dev routing guard failed/);
  assert.ok(!malformed.stderr.includes('fixture-private-parser-input'));
});


test('a late write between restored readback and HTTP proof is restored again', async t => {
  const h = harness(t, { lateDuringProof: true });
  await assert.rejects(h.run(), /previous record restored/);
  assert.equal(h.mutations.length, 3);
  assert.deepEqual(h.current(), h.initial);
});

for (const option of ['wrongOwner', 'wrongBinding', 'splitVersion', 'wrongSource', 'publicOrigin', 'extraRoute', 'productionApi', 'wrongMain']) {
  test(`route transfer refuses ${option} before any write`, async t => {
    const h = harness(t, { route: true, safe: true, [option]: true });
    await assert.rejects(h.run());
    assert.equal(h.mutations.length, 0);
  });
}

test('verified staged route completes the observation window', async t => {
  const h = harness(t, { route: true, safe: true });
  await h.run();
  assert.equal(h.current().script, 'njpbs-dev-staff-sites');
  assert.equal(h.mutations.length, 1);
});

test('route drift after transfer restores the old route owner', async t => {
  const h = harness(t, { route: true, safe: true, routeDrift: true });
  await assert.rejects(h.run(), /previous record restored/);
  assert.deepEqual(h.current(), h.initial);
});
