import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { bridgeFixture, bodyDigest } from './helpers/cms-reader-bridge.js';
import { parseCmsReaderBridgeRequest } from '../scripts/lib/cms-reader-bridge-install.mjs';
import { developmentInstallCredential, developmentInstallAccess, developmentCanonicalRequest } from '../scripts/lib/development-install-credentials.mjs';
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dev-install-commands-')); dirs.push(dir);
  mkdirSync(join(dir, 'bin')); const log = join(dir, 'calls');
  writeFileSync(join(dir, 'bin', 'node'), `#!/bin/bash
if [[ "$1" == --input-type=module ]]; then exec '${process.execPath}' "$@"; fi
if [[ "$1" == scripts/describe-cms-reader-credential-pipes.mjs ]]; then
  if [[ "$DEV_DESCRIPTOR_FAIL" == 1 ]]; then exit 7; fi
  exec '${process.execPath}' "$@"
fi
printf '%s\\n' "$*" >> "$DEV_COMMAND_LOG"
if [[ "$*" == *"$DEV_COMMAND_FAIL"* && -n "$DEV_COMMAND_FAIL" ]]; then exit 7; fi
if [[ "$1" == scripts/check-dev-current-code.mjs || "$1" == scripts/terminalize-dev-publication-history.mjs || "$1" == scripts/initialize-dev-public-predecessor.mjs || "$1" == scripts/install-cms-reader-bridge.mjs || "$1" == scripts/bootstrap-cms-preview-pair.cjs || "$1" == scripts/install-private-public-release.mjs || "$1" == scripts/enroll-public-release-change-log.mjs ]]; then
  '${process.execPath}' "$DEV_READER_CHECK" "$@" || exit $?
fi
if [[ "$1" == scripts/prepare-development-initial-pairs.mjs ]]; then
  '${process.execPath}' "$DEV_PAIR_CHECK" "$@" || exit $?
fi
cat >/dev/null
if [[ "$1" == scripts/prepare-development-initial-pairs.mjs ]]; then
  if [[ "$*" == *pair-staging* ]]; then default=retained; else default=qualified; fi
  printf '{"status":"%s"}\\n' "\${DEV_PAIR_RESULT:-$default}";
elif [[ "$1" == scripts/terminalize-dev-publication-history.mjs ]]; then
  printf '{"kind":"dev-publication-history-result","mode":"plan","requestDigest":"same","plan":{"requestDigest":"same","rows":[{"action":"supersede"},{"action":"retire"},{"action":"retire"},{"action":"retire"},{"action":"retire"},{"action":"retire"},{"action":"retire"},{"action":"retire"},{"action":"retire"},{"action":"retire"}]},"committed":true,"conservationVerified":true}\\n';
elif [[ "$1" == scripts/initialize-dev-public-predecessor.mjs ]]; then printf '{"kind":"dev-public-predecessor-result","step":"%s","mode":"plan","committed":true,"currentReady":true}\\n' "$3";
elif [[ "$1" == scripts/recover-dev-public-release-pause.mjs && "$*" == *--readback* ]]; then printf '{"kind":"dev-public-release-pause-recovery-result","recoveryCommitted":true,"canContinue":true,"originalOutcome":"paused-failed","drainCommitted":false}\\n';
elif [[ "$1" == scripts/pause-dev-public-release.mjs && "$*" == *--readback* ]]; then printf '{"kind":"dev-public-release-pause-result","pauseCommitted":true,"drainCommitted":true,"currentReady":true,"ownsClosedFence":true}\\n'; else printf '{}\\n'; fi
`, { mode: 0o755 });
  writeFileSync(join(dir, 'bin', 'pass'), '#!/bin/bash\nprintf "%s\\n" "$2" >> "$DEV_VAULT_LOG"\nprintf "fixture-%s\\n" "$2"\n', { mode: 0o755 });
  // Credential reads use the configured local entry and inherited pipes.
  // Any attempted remote credential lookup must fail this proof.
  writeFileSync(join(dir, 'bin', 'ssh'), '#!/bin/bash\nexit 9\n', { mode: 0o755 });
  const readerCheck = join(dir, 'reader-check.cjs'), pipeLog = join(dir, 'pipes');
  writeFileSync(readerCheck, `const fs = require('node:fs');
const [command, mode, ...args] = process.argv.slice(2);
if (command.endsWith('check-dev-current-code.mjs')) {
  if (mode !== '--enrollment-request' || !fs.fstatSync(4).isFIFO() || fs.readFileSync(4, 'utf8') !== 'fixture-EDGE_ENTRY' + '\\n') throw new Error('Wrong CODE preflight pipe');
  fs.appendFileSync(process.env.DEV_PIPE_LOG, JSON.stringify({ command, mode: 'preflight', fds: [4] }) + '\\n');
  process.exit(0);
}
if (command.endsWith('terminalize-dev-publication-history.mjs') || command.endsWith('initialize-dev-public-predecessor.mjs')) {
  const fds = command.endsWith('terminalize-dev-publication-history.mjs') || args.includes('--apply') || args.includes('--readback') ? [3] : [];
  for (const fd of fds) {
    if (!fs.fstatSync(fd).isFIFO() || fs.readFileSync(fd, 'utf8') !== 'fixture-SDK_ENTRY' + '\\n') throw new Error('Wrong initializer SDK pipe');
  }
  fs.appendFileSync(process.env.DEV_PIPE_LOG, JSON.stringify({ command, mode: args.includes('--apply') ? 'apply' : args.includes('--readback') ? 'readback' : 'plan', fds }) + '\\n');
  process.exit(0);
}
if (command.endsWith('install-private-public-release.mjs') || command.endsWith('enroll-public-release-change-log.mjs')) {
  const slot = command.endsWith('install-private-public-release.mjs');
  const fds = slot ? args.includes('--apply') ? [3, 4] : [] : ['dry-run', 'apply'].includes(mode) ? [3, 4] : [3];
  if (!args.includes('--development-sdk-packet') || !args.includes('--development-sdk-packet-digest')) throw new Error('Missing SDK metadata');
  for (const fd of fds) {
    if (!fs.fstatSync(fd).isFIFO() || fs.readFileSync(fd, 'utf8') !== 'fixture-' + (slot && fd === 3 ? 'PROVIDER_TOKEN_ENTRY' : !slot && fd === 4 ? 'EDGE_ENTRY' : 'SDK_ENTRY') + '\\n') throw new Error('Wrong inherited SDK/provider pipe');
  }
  fs.appendFileSync(process.env.DEV_PIPE_LOG, JSON.stringify({ command, mode, fds }) + '\\n');
  process.exit(0);
}
const fds = command.endsWith('bridge.mjs')
  ? mode === 'prove' ? [4, 12, 13, 14] : mode === 'install' ? [4, 12] : []
  : ['plan', 'dry-run', 'apply'].includes(mode) ? [4, 12] : [];
const fail = () => { throw new Error('Inherited fixture credential pipe mismatch'); };
const raw = process.env.CMS_READER_CREDENTIAL_PIPES;
if (!fds.length) { if (raw !== undefined) fail(); }
else {
  const manifest = JSON.parse(raw);
  if (Object.keys(manifest).join() !== fds.join()) fail();
  const entries = { 4: 'PROVIDER_TOKEN_ENTRY', 12: 'GOOGLE_READ_ENTRY', 13: 'STAFF_JWT_ENTRY', 14: 'EDGE_ENTRY' };
  for (const fd of fds) {
    const stat = fs.fstatSync(fd, { bigint: true }), identity = manifest[fd];
    if ((!stat.isFIFO() && !stat.isSocket()) || identity.device !== String(stat.dev) || identity.inode !== String(stat.ino)) fail();
    if (fs.readFileSync(fd, 'utf8') !== 'fixture-' + entries[fd] + '\\n') fail();
  }
}
fs.appendFileSync(process.env.DEV_PIPE_LOG, JSON.stringify({ command, mode, fds }) + '\\n');
`);
  const input = (name: string, value: any) => { const path = join(dir, name); writeFileSync(path, JSON.stringify(value)); return path; };
  const pairCheck = join(dir, 'pair-check.cjs');
  writeFileSync(pairCheck, `const fs = require('node:fs');
const args = process.argv.slice(2), apply = args.includes('--apply'), readback = args.includes('--readback');
const packet = JSON.parse(fs.readFileSync(args[args.indexOf('--packet') + 1], 'utf8'));
const entries = apply ? { 3: 'SDK_ENTRY', 4: 'R2_WRITE_ENTRY', ...(packet.step === 'qualify' ? { 6: 'PAIR_READER_ACCESS_ENTRY' } : {}) } : readback ? { 3: 'SDK_ENTRY' } : {};
for (const [fd, entry] of Object.entries(entries)) {
  const stat = fs.fstatSync(Number(fd));
  if (!stat.isFIFO() && !stat.isSocket()) throw new Error('Expected inherited pipe');
  if (fs.readFileSync(Number(fd), 'utf8') !== 'fixture-' + entry + '\\n') throw new Error('Wrong credential channel');
}
`);
  const stageB = bridgeFixture().request;
  const stageA = { ...stageB, stage: 'legacy-first-install', legacyPublicSelectorDigest: 'c'.repeat(64),
    cases: stageB.cases.filter(row => row.scope !== 'publicNew').map(row => ({ ...row, sourcePairDigest: 'a'.repeat(64),
      expected: { ...row.expected, bodyDigest: bodyDigest(JSON.stringify({ fixtureCase: row.body.fixtureCase, immutableSource: 'a'.repeat(64) })) } })),
    refusals: stageB.cases.filter(row => row.scope === 'publicNew' && row.feature === 'publicCode').map(row => ({ ...row, sourcePairDigest: 'b'.repeat(64),
      expected: { ...row.expected, status: 503, bodyDigest: bodyDigest(JSON.stringify({ error: 'Private pair CODE unavailable' })) } })) };
  // Use the actual owner grammar, including its full 28/36 rosters. The inline
  // validators in the Bash files also run through real Node before the mock.
  parseCmsReaderBridgeRequest(stageA); parseCmsReaderBridgeRequest(stageB);
  expect(Object.hasOwn(stageB, 'stage')).toBe(false);
  const env: any = { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, DEV_INSTALL_EVIDENCE: join(dir, 'evidence'),
    DEV_COMMAND_LOG: log, DEV_VAULT_LOG: join(dir, 'vault'), DEV_COMMAND_FAIL: '', DEV_DESCRIPTOR_FAIL: '', DEV_SDK_PACKET: 'sdk-packet', DEV_SDK_PACKET_SHA256: 'a'.repeat(64),
    DEV_READER_CHECK: readerCheck, DEV_PAIR_CHECK: pairCheck, DEV_PIPE_LOG: pipeLog, CMS_READER_CREDENTIAL_PIPES: 'stale-parent-manifest',
    DEV_SLOT_PLAN: input('slots', { developmentIngress: true, oldPair: { environment: 'development' }, newPair: { environment: 'development' } }),
    DEV_RUNTIME_INIT_PACKET: 'runtime', DEV_MEDIA_INIT_PACKET: 'media-lifecycle', DEV_HISTORY_PACKET: 'history', DEV_HISTORY_PACKET_SHA256: 'a'.repeat(64),
    DEV_CLOSE_PACKET: input('close', { attempt: { environment: 'development' } }),
    DEV_OLD_CODE_PACKET: input('old-code', { step: 'old-code', credentialIdentity: { projectId: 'njpbs-site-dev' } }),
    DEV_INITIAL_PAIRS_PACKET: input('initial-pairs', { step: 'qualify', credentialIdentity: { projectId: 'njpbs-site-dev' } }),
    DEV_PAIR_STAGING_PACKET: input('pair-staging', { step: 'stage', credentialIdentity: { projectId: 'njpbs-site-dev' } }),
    DEV_BRIDGE_REQUEST_A: input('stage-a', stageA), DEV_BRIDGE_REQUEST_B: input('stage-b', stageB) };
  for (const key of ['PROVIDER_TOKEN_ENTRY', 'SDK_ENTRY', 'GOOGLE_READ_ENTRY', 'R2_READ_ENTRY', 'R2_WRITE_ENTRY', 'PAIR_READER_ACCESS_ENTRY', 'OLD_CODE_PACKET_SHA256', 'PAIR_STAGING_PACKET_SHA256', 'INITIAL_PAIRS_PACKET_SHA256', 'VIEWER_ACCESS_ENTRY', 'STAFF_JWT_ENTRY', 'EDGE_ENTRY',
    'RUNTIME_INIT_PACKET_SHA256', 'MEDIA_INIT_PACKET_SHA256', 'PUBLIC_PAUSE_RECOVERY_PACKET', 'PUBLIC_PAUSE_RECOVERY_PACKET_SHA256', 'CLOSE_PACKET_SHA256', 'PUBLIC_PAUSE_PACKET', 'PUBLIC_PAUSE_PACKET_SHA256', 'PREVIEW_PAUSE_PACKET', 'PREVIEW_PAUSE_PACKET_SHA256', 'ENROLLMENT_REQUEST', 'READER_ADAPTER', 'READER_ADAPTER_SHA256', 'PREVIEW_IDENTITY', 'CONSUMER_ADAPTER_A',
    'CONSUMER_ADAPTER_A_SHA256', 'PREVIEW_REQUEST', 'CONTROLS_PACKET', 'CONTROLS_PACKET_SHA256', 'INITIAL_PACKET', 'INITIAL_PACKET_SHA256',
    'GATEWAY_PACKET', 'GATEWAY_PACKET_SHA256', 'RESUME_PACKET', 'RESUME_PACKET_SHA256', 'SCHEDULE_PACKET', 'SCHEDULE_PACKET_SHA256']) env[`DEV_${key}`] = key;
  return { dir, env, log, pipeLog, run: (file: string, ...args: string[]) => spawnSync('bash', [resolve('scripts/development-install', file), ...args], { env, encoding: 'utf8', timeout: 10_000 }) };
}
it('runs every numbered Bash command file as written, with A/preview/OLD/B/resume/native-save order', () => {
  const f = fixture(), files = readdirSync('scripts/development-install').filter(name => name.endsWith('.sh') && name !== 'common.sh' && name !== '09a-public-pause-recovery.sh').sort();
  for (const file of files) { const result = f.run(file); expect(result.status, `${file}: ${result.stderr}`).toBe(0); }
  const calls = readFileSync(f.log, 'utf8').split('\n').filter(Boolean);
  const milestones = calls.filter(row => row.includes('--apply') || /(?:bridge\.mjs install|preview-pair\.cjs apply|change-log\.mjs apply)/.test(row));
  expect(milestones.map(row => row.split(' ')[0])).toEqual([
    'scripts/install-private-public-release.mjs', 'scripts/initialize-dev-public-predecessor.mjs', 'scripts/initialize-dev-public-predecessor.mjs', 'scripts/terminalize-dev-publication-history.mjs', 'scripts/pause-dev-public-release.mjs', 'scripts/close-public-release-bootstrap-admission.mjs', 'scripts/development-public-release-adoption.mjs', 'scripts/enroll-public-release-change-log.mjs',
    'scripts/prepare-development-initial-pairs.mjs', 'scripts/install-cms-reader-bridge.mjs', 'scripts/bootstrap-cms-preview-pair.cjs',
    'scripts/prepare-development-initial-pairs.mjs', 'scripts/development-public-release-adoption.mjs', 'scripts/prepare-development-initial-pairs.mjs', 'scripts/development-public-release-adoption.mjs',
    'scripts/bind-development-public-release-gateway.mjs', 'scripts/install-cms-reader-bridge.mjs',
    'scripts/development-public-release-adoption.mjs', 'scripts/save-development-rehearsal-schedule.mjs']);
  expect(calls.some(row => /enable-old-public-release-ingress|deploy-dev-staff-gateway|wrangler/.test(row))).toBe(false);
});
it('stops a failed A install before readback and refuses B/A or production inputs before vault dispatch', () => {
  const f = fixture(); f.env.DEV_COMMAND_FAIL = 'install-cms-reader-bridge.mjs install';
  expect(f.run('20-stage-a.sh').status).toBe(7);
  expect(readFileSync(f.log, 'utf8')).not.toContain('readback');
  rmSync(f.env.DEV_VAULT_LOG); f.env.DEV_BRIDGE_REQUEST_B = f.env.DEV_BRIDGE_REQUEST_A;
  expect(f.run('40-stage-b.sh').status).toBe(1);
  const explicitB = join(f.dir, 'explicit-b');
  writeFileSync(explicitB, JSON.stringify({ ...bridgeFixture().request, stage: 'public-converted' }));
  f.env.DEV_BRIDGE_REQUEST_B = explicitB; expect(f.run('40-stage-b.sh').status).toBe(1);
  writeFileSync(explicitB, JSON.stringify({ ...bridgeFixture().request, cases: [] }));
  expect(f.run('40-stage-b.sh').status).toBe(1);
  f.env.DEV_SLOT_PLAN = f.env.DEV_BRIDGE_REQUEST_A;
  expect(f.run('00-private-slots.sh').status).toBe(1);
  expect(readdirSync(f.dir)).not.toContain('vault');
});
it('passes the real parent pipe manifest and only each reader/bootstrap mode\'s credential channels', () => {
  for (const file of ['20-stage-a.sh', '40-stage-b.sh', '21-preview-plan.sh', '22-preview-convert.sh']) {
    const f = fixture(), result = f.run(file);
    expect(result.status, `${file}: ${result.stderr}`).toBe(0);
    const rows = readFileSync(f.pipeLog, 'utf8').trim().split('\n').map(row => JSON.parse(row));
    const bridge = file === '20-stage-a.sh' || file === '40-stage-b.sh';
    expect(rows.map(row => [row.mode, row.fds])).toEqual(bridge
      ? [['dry-run', []], ['prove', [4, 12, 13, 14]], ['install', [4, 12]], ['readback', []]]
      : file === '21-preview-plan.sh' ? [['plan', [4, 12]]] : [['dry-run', [4, 12]], ['apply', [4, 12]], ['receipt', []]]);
    const entries = readFileSync(f.env.DEV_VAULT_LOG, 'utf8').trim().split('\n').sort();
    const providerModes = bridge || file === '22-preview-convert.sh' ? 2 : 1;
    expect(entries).toEqual([
      ...Array(rows.length).fill('SDK_ENTRY'), ...Array(providerModes).fill('PROVIDER_TOKEN_ENTRY'),
      ...Array(providerModes).fill('GOOGLE_READ_ENTRY'), ...(bridge ? ['STAFF_JWT_ENTRY', 'EDGE_ENTRY'] : []),
    ].sort());
  }
});
it('stops before reader prove dispatch when parent metadata fails or a replay entry is absent', () => {
  for (const mode of ['metadata-failure', 'missing-replay-entry']) {
    const f = fixture();
    if (mode === 'metadata-failure') f.env.DEV_DESCRIPTOR_FAIL = '1'; else delete f.env.DEV_STAFF_JWT_ENTRY;
    const result = f.run('20-stage-a.sh');
    expect(result.status).toBe(mode === 'metadata-failure' ? 7 : 1);
    expect(readFileSync(f.log, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(readFileSync(f.pipeLog, 'utf8')).toContain('"mode":"dry-run"');
    const entries = readFileSync(f.env.DEV_VAULT_LOG, 'utf8').trim().split('\n');
    expect(entries.filter(entry => entry === 'SDK_ENTRY')).toHaveLength(1);
    if (mode === 'missing-replay-entry') expect(entries).toEqual(['SDK_ENTRY']);
  }
});
it('reserves credential streams without consuming and bounds input; canonical fetch adds Access only for dev GETs', async () => {
  let consumed = 0;
  const input = Readable.from((async function* () { consumed++; yield 'opaque'; })());
  const credential = developmentInstallCredential(9, (value: string) => value, input);
  expect(consumed).toBe(0); expect(await credential.read()).toBe('opaque'); expect(await credential.read()).toBe('opaque'); expect(consumed).toBe(1);
  await expect(developmentInstallCredential(9, (value: string) => value, Readable.from(['x'.repeat(32769)])).read()).rejects.toThrow();
  const access = developmentInstallAccess(JSON.stringify({ 'CF-Access-Client-Id': 'fixture.access', 'CF-Access-Client-Secret': 'synthetic' }));
  let calls = 0;
  const request = developmentCanonicalRequest(async () => access, async (url: URL, init: RequestInit) => {
    calls++; expect(url.origin).toBe('https://dev-public.example.org'); expect(new Headers(init.headers).get('CF-Access-Client-Id')).toBe('fixture.access');
    expect(['error', 'manual']).toContain(init.redirect); return new Response(null, { status: init.redirect === 'manual' ? 308 : 200,
      ...(init.redirect === 'manual' ? { headers: { location: 'https://dev-public.example.org/canonical/' } } : {}) });
  });
  await request('https://dev-public.example.org/'); expect(calls).toBe(1);
  const alias = await request('https://dev-public.example.org/alias/', { redirect: 'manual' });
  expect(alias.status).toBe(308); expect(alias.headers.get('location')).toBe('https://dev-public.example.org/canonical/');
  await expect(request('https://dev-public.example.org/', { redirect: 'follow' })).rejects.toThrow();
  for (const url of ['https://njpbs.org/', 'https://dev-public.example.org/?token=bad', 'https://foreign.example/']) await expect(request(url)).rejects.toThrow();
  expect(calls).toBe(2);
});
it('stops 30a on native wait, validates the step/target before vault access, and reads outcomes with SDK only', () => {
  const f = fixture(); f.env.DEV_PAIR_RESULT = 'waiting';
  expect(f.run('30a-initial-pairs.sh').status).toBe(1);
  expect(readFileSync(join(f.env.DEV_INSTALL_EVIDENCE, 'initial-pairs.json'), 'utf8')).toContain('waiting');
  const g = fixture(); g.env.DEV_INITIAL_PAIRS_PACKET = g.env.DEV_OLD_CODE_PACKET;
  expect(g.run('30a-initial-pairs.sh').status).toBe(1); expect(readdirSync(g.dir)).not.toContain('vault');
  for (const file of ['19-old-code.sh', '29-initial-pair-staging.sh', '30a-initial-pairs.sh']) {
    const h = fixture(); delete h.env.DEV_R2_WRITE_ENTRY; delete h.env.DEV_PAIR_READER_ACCESS_ENTRY;
    expect(h.run(file, 'readback').status).toBe(0);
    expect(readFileSync(h.env.DEV_VAULT_LOG, 'utf8').trim()).toBe('SDK_ENTRY');
  }
});
it('rejects changed tracked source before repository modules or credential bytes are evaluated', async () => {
  const { refusedOperatorPrelaunch } = await import('./helpers/operator-prelaunch.mjs');
  for (const filename of ['development-public-release-adoption.mjs', 'bind-development-public-release-gateway.mjs', 'save-development-rehearsal-schedule.mjs', 'recover-dev-public-release-pause.mjs', 'prepare-development-initial-pairs.mjs', 'prepare-production-initial-pairs.mjs']) {
    for (const mode of ['dirty-tree', 'wrong-commit']) {
      const initial = filename === 'prepare-development-initial-pairs.mjs' || filename === 'prepare-production-initial-pairs.mjs';
      const businessPath = initial ? 'scripts/lib/initial-pairs-packet.mjs'
        : filename === 'recover-dev-public-release-pause.mjs' ? 'scripts/lib/dev-public-release-pause-recovery-operator.mjs' : 'scripts/lib/public-release-operator-io.mjs';
      const result = await refusedOperatorPrelaunch({ filename, businessPath, mode,
        supportingFiles: initial ? ['prepare-initial-pairs.mjs'] : [],
        packetFields: filename === 'recover-dev-public-release-pause.mjs' ? { attempt: { pauseAttempt: { environment: 'development', projectId: 'njpbs-site-dev' } },
          credentialIdentity: { projectId: 'njpbs-site-dev' } } : {} });
      expect(result.status).toBe(1); expect(result.evaluated).toBe(false);
      if (initial) expect(result.stderr).toBe(`${filename.includes('production') ? 'Production' : 'Development'} initial pairs refused; preserve the packet and use --readback\n`);
    }
  }
});

it('runs optional failed-pause recovery as its own held command and stops a failed apply before readback', () => {
  const f = fixture(), result = f.run('09a-public-pause-recovery.sh');
  expect(result.status, result.stderr).toBe(0);
  const calls = readFileSync(f.log, 'utf8').trim().split('\n');
  expect(calls).toHaveLength(3);
  expect(calls.every(row => row.startsWith('scripts/recover-dev-public-release-pause.mjs '))).toBe(true);
  expect(calls[0]).not.toContain('--apply'); expect(calls[1]).toContain('--apply'); expect(calls[2]).toContain('--readback');
  expect(readFileSync(f.env.DEV_VAULT_LOG, 'utf8').trim().split('\n')).toEqual(['SDK_ENTRY', 'SDK_ENTRY']);
  const failed = fixture(); failed.env.DEV_COMMAND_FAIL = '--apply';
  expect(failed.run('09a-public-pause-recovery.sh').status).toBe(7);
  expect(readFileSync(failed.log, 'utf8')).not.toContain('--readback');
});

it('runs 00, 10b and 11 as written with distinct provider/SDK pipes and fresh SDK reads per mode', () => {
  for (const file of ['00-private-slots.sh', '10b-enrollment-inspect.sh', '11-enroll.sh']) {
    const f = fixture(), result = f.run(file);
    expect(result.status, result.stderr).toBe(0);
    const rows = readFileSync(f.pipeLog, 'utf8').trim().split('\n').map(row => JSON.parse(row));
    expect(rows.map(row => row.fds)).toEqual(file.startsWith('00') ? [[], [3, 4]] : file.startsWith('10b') ? [[3]] : [[4], [3, 4], [3, 4], [3]]);
    expect(readFileSync(f.env.DEV_VAULT_LOG, 'utf8').trim().split('\n').sort()).toEqual(
      (file.startsWith('00') ? ['PROVIDER_TOKEN_ENTRY', 'SDK_ENTRY'] : [...Array(file.startsWith('11') ? 3 : rows.length).fill('SDK_ENTRY'), ...(file.startsWith('11') ? ['EDGE_ENTRY', 'EDGE_ENTRY', 'EDGE_ENTRY'] : [])]).sort());
  }
});
it('refuses missing SDK entry/packet metadata before any numbered credential dispatch', () => {
  for (const file of ['00-private-slots.sh', '10b-enrollment-inspect.sh', '11-enroll.sh']) {
    for (const key of ['DEV_SDK_ENTRY', 'DEV_SDK_PACKET', 'DEV_SDK_PACKET_SHA256']) {
      const f = fixture(); delete f.env[key];
      expect(f.run(file).status).toBe(1);
      expect(readdirSync(f.dir)).not.toContain('vault');
    }
  }
});

it('keeps 10b SDK-only and requires the configured local edge entry for row 11', () => {
  const f = fixture();
  expect(f.run('10b-enrollment-inspect.sh').status).toBe(0);
  expect(f.run('11-enroll.sh').status).toBe(0);
  const entries = readFileSync(f.env.DEV_VAULT_LOG, 'utf8').trim().split('\n');
  expect(entries.filter(entry => entry === 'SDK_ENTRY')).toHaveLength(4);
  expect(entries.filter(entry => entry === 'EDGE_ENTRY')).toHaveLength(3);
  const missing = fixture(); delete missing.env.DEV_EDGE_ENTRY;
  expect(missing.run('11-enroll.sh').status).not.toBe(0);
  expect(readdirSync(missing.dir)).not.toContain('vault');
});

it.each(['08a-runtime-initialize.sh', '08b-media-lifecycle-initialize.sh'])('runs %s with SDK only on fd3 after the credential-free plan', file => {
  const f = fixture(), result = f.run(file);
  expect(result.status, result.stderr).toBe(0);
  const rows = readFileSync(f.pipeLog, 'utf8').trim().split('\n').map(row => JSON.parse(row));
  expect(rows.map(row => [row.mode, row.fds])).toEqual([['plan', []], ['apply', [3]], ['readback', [3]]]);
  expect(readFileSync(f.env.DEV_VAULT_LOG, 'utf8').trim().split('\n')).toEqual(['SDK_ENTRY', 'SDK_ENTRY']);
});
it.each(['08a-runtime-initialize.sh', '08b-media-lifecycle-initialize.sh'])('stops %s after a refused plan before opening SDK credentials', file => {
  const f = fixture(); f.env.DEV_COMMAND_FAIL = 'initialize-dev-public-predecessor.mjs';
  expect(f.run(file).status).toBe(7);
  expect(readdirSync(f.dir)).not.toContain('vault');
});

it('runs08c with plan before SDK pipes and stops on an owner failure', () => {
  const f = fixture(), result = f.run('08c-historical-batches.sh');
  expect(result.status, result.stderr).toBe(0);
  const pipes = readFileSync(f.pipeLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(pipes.map(row => [row.mode, row.fds])).toEqual([['plan', [3]], ['apply', [3]], ['readback', [3]]]);
  expect(readFileSync(f.env.DEV_VAULT_LOG, 'utf8').trim().split('\n')).toEqual(['SDK_ENTRY', 'SDK_ENTRY', 'SDK_ENTRY']);
  const failed = fixture(); failed.env.DEV_COMMAND_FAIL = 'terminalize-dev-publication-history.mjs';
  expect(failed.run('08c-historical-batches.sh').status).toBe(7);
  expect(readFileSync(failed.log, 'utf8').trim().split('\n')).toHaveLength(1);
});

it('refuses changed history source before importing owner code or reading SDK credentials', async () => {
  const { refusedOperatorPrelaunch } = await import('./helpers/operator-prelaunch.mjs');
  for (const mode of ['dirty-tree', 'wrong-commit']) {
    const result = await refusedOperatorPrelaunch({ filename: 'terminalize-dev-publication-history.mjs', businessPath: 'scripts/lib/dev-publication-history-operator.mjs', mode,
      packetFields: { request: { environment: 'development', projectId: 'njpbs-site-dev' }, credentialIdentity: { projectId: 'njpbs-site-dev' } } });
    expect(result.status).toBe(1); expect(result.evaluated).toBe(false);
  }
});

it('stops row 11 before any SDK or enrollment call when CODE preflight fails', () => {
  const f = fixture(); f.env.DEV_COMMAND_FAIL = 'scripts/check-dev-current-code.mjs';
  expect(f.run('11-enroll.sh').status).toBe(7);
  expect(readFileSync(f.log, 'utf8').trim().split('\n')).toHaveLength(1);
  expect(readFileSync(f.env.DEV_VAULT_LOG, 'utf8').trim()).toBe('EDGE_ENTRY');
});

it.each(['registered-esm', 'startup-loader', 'native', 'typed-require'])(
  'loads the public reader contract and operator graphs through %s without credentials', route => {
    // A Vitest import transforms away the ESM/CommonJS boundary that refused
    // the actual plain-Node first-install command. Exercise a fresh process.
    const script = `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      const route = process.argv[1];
      const parent = new URL('./operator-import-probe.mjs', import.meta.url);
      const require = createRequire(new URL('./site/package.json', import.meta.url));
      let load = filename => import(filename);
      if (route === 'registered-esm') {
        require('tsx/cjs/api').register();
        require('tsx/esm/api').register();
      } else if (route === 'native') {
        const { initialPairNative } = await import('./scripts/lib/initial-pair-native.mjs');
        load = filename => initialPairNative(filename, parent);
      } else if (route === 'typed-require') {
        const { require: typedRequire } = require('tsx/cjs/api');
        load = filename => typedRequire(filename, parent.href);
      }
      globalThis.fetch = () => { throw new Error('Unexpected network request'); };
      const contract = await load('./site/scripts/public-release-pair-reader-contract.ts');
      assert.equal(contract.PAIR_READER_BYTES_LIMIT, 16 * 1024 * 1024);
      assert.equal(contract.PAIR_READER_PATHS_LIMIT, 32);
      assert.equal(contract.PAIR_READER_PATH, '/private-pair-reader/v2/read');
      const owners = [
        ['./site/scripts/public-release-bootstrap-s3-read.ts', 'createBootstrapS3Reads'],
      ];
      // First-install and Container entrypoints use ESM; the switch/storage
      // owners below use their native CJS/typedRequire loaders.
      if (route === 'registered-esm' || route === 'startup-loader') owners.push(
        ['./site/scripts/public-release-first-install-freeze.ts', 'freezeFirstInstallPublicReleasePair'],
        ['./site/scripts/public-release-first-install-image.ts', 'prepareFirstInstallPairImage'],
        ['./site/scripts/public-release-first-install-build.ts', 'buildFirstInstallPublicReleasePair'],
        ['./site/scripts/public-release-pair-server.ts', 'startPublicReleasePairServer'],
        ['./site/scripts/run-cms-publication-pair-cloud.ts', 'runCmsPublicationPairCloud'],
      );
      for (const [filename, exported] of owners) assert.equal(typeof (await load(filename))[exported], 'function');
      for (const [filename, exported] of [
        ['./scripts/lib/production-public-release-switch.mjs', 'parseProductionSwitchPacket'],
        ['./scripts/lib/production-public-release-switch-store.mjs', 'createProductionSwitchStore'],
        ['./scripts/lib/initial-pair-store.mjs', 'createInitialPairStore'],
        ['./scripts/lib/pair-qualification-store.mjs', 'createPairQualificationStore'],
      ]) assert.equal(typeof (await import(filename))[exported], 'function');
      console.log('Operator imports passed');
    `;
    const args = route === 'startup-loader' ? ['--import', './site/node_modules/tsx/dist/loader.mjs'] : [];
    const child = spawnSync(process.execPath, [...args, '--input-type=module', '-e', script, route], {
      cwd: resolve('.'), env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 7000,
    });
    expect(child.error).toBeUndefined();
    expect(child.stderr).toBe('');
    expect(child.status).toBe(0);
    expect(child.stdout).toBe('Operator imports passed\n');
  },
);
