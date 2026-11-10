import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { checkDevAnonymousRefusal, DEV_HOSTS } from './check-dev-anonymous-refusal.mjs';
import { checkDevMachineReceipt } from './check-dev-machine-receipt.mjs';
import { verifyGuardedRouteTarget } from './deploy-dev-staff-gateway.mjs';

const ACCOUNT = (process.env.CLOUDFLARE_ACCOUNT_ID ?? "");
const ID = /^[a-f0-9]{32}$/;
const DNS_FIELDS = ['name', 'type', 'content', 'ttl', 'proxied', 'comment', 'tags', 'settings', 'private_routing'];

// Only these fixed operator messages may leave the CLI error boundary.
class GuardError extends Error {}

function requireState(condition, message) {
  if (!condition) throw new GuardError(message);
}

function writable(record, kind) {
  const fields = kind === 'dns' ? DNS_FIELDS : ['pattern', 'script'];
  return Object.fromEntries(fields.filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]]));
}

function replacement(previous, plan) {
  const desired = { ...previous, ...plan.change };
  if (plan.kind === 'dns' && previous.type !== desired.type) {
    // DNS settings have different schemas by record type. Keep the saved
    // original intact for restoration, and use explicit provider defaults.
    desired.settings = { ipv4_only: previous.settings?.ipv4_only ?? false,
      ipv6_only: previous.settings?.ipv6_only ?? false,
      ...(desired.type === 'CNAME' ? { flatten_cname: false } : {}) };
    if (desired.type === 'CNAME') delete desired.private_routing;
  }
  return desired;
}

function sameWritable(record, expected, kind) {
  function comparable(value) {
    const result = writable(value, kind);
    if (kind === 'dns') {
      // The API may omit false defaults after a type change. These fields
      // disable optional behavior when absent; retain every non-default value.
      result.settings = Object.fromEntries(Object.entries(result.settings ?? {})
        .filter(([key, value]) => !(value === false && ['flatten_cname', 'ipv4_only', 'ipv6_only'].includes(key))));
      if (result.private_routing === false) delete result.private_routing;
    }
    return result;
  }
  return isDeepStrictEqual(comparable(record), comparable(expected));
}

function validatePlan(plan) {
  requireState(plan && DEV_HOSTS.includes(plan.host) && ['dns', 'route'].includes(plan.kind) &&
    ID.test(plan.recordId ?? '') && plan.change && typeof plan.change === 'object', 'Invalid dev change plan');
  const keys = Object.keys(plan.change);
  if (plan.kind === 'dns') {
    requireState(keys.length === 2 && keys.includes('type') && keys.includes('content') &&
      ['A', 'AAAA', 'CNAME'].includes(plan.change.type) &&
      typeof plan.change.content === 'string' && plan.change.content.length > 0,
    'DNS plans may change only type and content');
  } else {
    requireState(plan.host === 'dev-public.example.org' && keys.length === 1 && keys[0] === 'script' &&
      plan.change.script === 'njpbs-dev-staff-sites',
    'Route plans may target only the reviewed dev staff gateway');
  }
}

// This operator updates one existing record, never creates/deletes routes or DNS.
// The coordinator must hold other writers for the whole transaction.
export async function guardDevRoutingChange({ plan, receiptPath, apply = false, env = process.env,
  fetchImpl = fetch, log = console.log, now = Date.now, wait = sleep, signal,
  windowMs = 120_000, intervalMs = 5_000,
  readMainSha = () => execFileSync('git', ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } = {}) {
  validatePlan(plan);
  requireState(apply && env.DEV_ROUTING_CHANGE_APPROVED === 'true', 'Explicit approved apply is required');
  requireState(Number.isInteger(windowMs) && windowMs >= 60_000 && windowMs <= 600_000 &&
    Number.isInteger(intervalMs) && intervalMs >= 1_000 && intervalMs <= 10_000, 'Invalid observation window');
  requireState(env.CLOUDFLARE_API_TOKEN && receiptPath, 'Missing credential or private receipt path');
  if (plan.kind === 'route') requireState(plan.sourceSha === readMainSha(),
    'Staged source must match the freshly fetched and reviewed origin/main commit');
  const machine = plan.host === 'dev-public.example.org' && Boolean(env.CMS_DEV_ACCESS_CLIENT_ID && env.CMS_DEV_ACCESS_CLIENT_SECRET);
  requireState(Boolean(env.CMS_DEV_ACCESS_CLIENT_ID) === Boolean(env.CMS_DEV_ACCESS_CLIENT_SECRET),
    'Incomplete machine credentials');
  requireState(machine || (typeof plan.machineSkipReason === 'string' && plan.machineSkipReason.trim().length >= 12),
    'Record why the dev machine contract cannot run');

  async function api(path, method = 'GET', body, operationSignal = signal) {
    try {
      const response = await fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
        method, redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(operationSignal ? [operationSignal] : [])]),
        headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await response.json();
      requireState(response.ok && data.success === true, 'Cloudflare request refused');
      return data.result;
    } catch { throw new GuardError('Cloudflare request failed; inspect the private receipt'); }
  }
  const zones = await api(`/zones?name=njpbs.org&account.id=${ACCOUNT}`);
  requireState(Array.isArray(zones) && zones.length === 1 && ID.test(zones[0].id) &&
    zones[0].name === 'njpbs.org' && zones[0].account?.id === ACCOUNT, 'Wrong Cloudflare zone or account');
  const path = `/zones/${zones[0].id}/${plan.kind === 'dns' ? 'dns_records' : 'workers/routes'}/${plan.recordId}`;
  const before = await api(path);
  requireState(before?.id === plan.recordId, 'Record identity mismatch');
  if (plan.kind === 'dns') {
    requireState(before.name === plan.host && before.proxied === true &&
      ['A', 'AAAA', 'CNAME'].includes(before.type), 'Expected a proxied dev DNS record');
  } else {
    requireState(before.pattern === `${plan.host}/*` && before.script === 'njpbs-staff-sites' &&
      before.request_limit_fail_open !== true, 'Expected the exact dev route owned by njpbs-staff-sites');
  }
  let initialRoutes;
  async function verifyTarget(owner) {
    if (plan.kind !== 'route') return;
    try {
      const expectedRoutes = initialRoutes?.map(route => route.id === plan.recordId ? { ...route, script: owner } : route);
      const routes = await verifyGuardedRouteTarget({ api, routePath: path.slice(0, path.lastIndexOf('/')),
        routeId: plan.recordId, owner, versionId: plan.versionId, sourceSha: plan.sourceSha,
        audience: env.DEV_ACCESS_AUDIENCE, expectedRoutes });
      initialRoutes ??= routes;
    } catch { throw new GuardError('Staged gateway or zone route verification failed; no transfer may be accepted'); }
  }
  await verifyTarget(before.script);
  const previous = writable(before, plan.kind);
  const desired = replacement(previous, plan);
  requireState(!isDeepStrictEqual(previous, desired), 'Plan makes no change');
  // Exclusive creation prevents an accidental retry from replacing the recovery record.
  writeFileSync(receiptPath, `${JSON.stringify({ event: 'saved', at: new Date(now()).toISOString(),
    host: plan.host, kind: plan.kind, path, before, desired,
    machine: machine ? 'enabled' : plan.machineSkipReason })}\n`, { flag: 'wx', mode: 0o600 });
  const record = event => appendFileSync(receiptPath, `${JSON.stringify({ event, at: new Date(now()).toISOString() })}\n`);
  async function prove(probeSignal = signal) {
    await checkDevAnonymousRefusal({ hosts: [plan.host], fetchImpl, log, signal: probeSignal });
    if (machine) await checkDevMachineReceipt({ env, fetchImpl, log, signal: probeSignal, requestTimeoutMs: 10_000 });
  }
  await prove();
  requireState(isDeepStrictEqual(await api(path), before), 'Record changed during preflight; no mutation attempted');
  await verifyTarget(before.script);
  signal?.throwIfAborted();
  async function restoreReadback(force) {
    if (force) await api(path, 'PUT', previous, null);
    let restored = await api(path, 'GET', undefined, null);
    if (!sameWritable(restored, previous, plan.kind)) {
      await api(path, 'PUT', previous, null);
      restored = await api(path, 'GET', undefined, null);
    }
    requireState(sameWritable(restored, previous, plan.kind) &&
      restored.request_limit_fail_open === before.request_limit_fail_open, 'Restore readback mismatch');
  }
  // A lost PUT reply can still mean the write happened: every failure restores.
  try {
    await api(path, 'PUT', desired);
    const deadline = now() + windowMs;
    do {
      await prove();
      const current = await api(path);
      requireState(sameWritable(current, desired, plan.kind) &&
        current.request_limit_fail_open === before.request_limit_fail_open, 'Change readback mismatch');
      await verifyTarget(desired.script);
      record('probe passed');
      if (now() >= deadline) break;
      await wait(Math.min(intervalMs, deadline - now()), undefined, { signal });
    } while (true);
    record('accepted');
    log('Dev change passed the observation window');
  } catch {
    // Ignore cancellation during recovery. A timed-out PUT can still commit
    // after the first restore, so watch and repair drift through a full window.
    const recoveryDeadline = now() + windowMs;
    let firstRestore = true;
    do {
      try {
        await restoreReadback(firstRestore);
        firstRestore = false;
      } catch {
        if (now() >= recoveryDeadline) {
          log('RESTORE FAILED: Keep writers held; restore from the private receipt now');
          throw new GuardError('Dev change failed and restoration is unverified');
        }
        log('Restore request failed; retrying within the recovery window');
        await wait(Math.min(intervalMs, recoveryDeadline - now()));
        continue;
      }
      try {
        await prove(null);
      } catch {
        record('restored proof failed');
        // The original PUT may have committed between readback and HTTP.
        // Reapply the saved value before the next proof, including at the bound.
        firstRestore = true;
        if (now() >= recoveryDeadline) {
          try {
            await restoreReadback(true);
          } catch {
            log('RESTORE FAILED: Keep writers held; restore from the private receipt now');
            throw new GuardError('Dev change failed and restoration is unverified');
          }
          log('RESTORED BUT PROOF FAILED: Keep writers held; escalate the dev access failure');
          throw new GuardError('Dev record restored but HTTP verification failed');
        }
        log('Restored record proof failed; recovery remains active');
        await wait(Math.min(intervalMs, recoveryDeadline - now()));
        continue;
      }
      record('restored proof passed');
      if (now() >= recoveryDeadline) break;
      await wait(Math.min(intervalMs, recoveryDeadline - now()));
    } while (true);
    log('Previous dev record restored');
    record('restored');
    throw new GuardError('Dev change failed; previous record restored');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    const [planPath, receiptPath, apply] = process.argv.slice(2);
    await guardDevRoutingChange({ plan: JSON.parse(readFileSync(planPath, 'utf8')), receiptPath,
      apply: apply === '--apply', signal: controller.signal });
  } catch (error) {
    // Parser, transport and filesystem errors may quote input or credentials.
    console.error(error instanceof GuardError ? error.message :
      'Dev routing guard failed; check the safe status lines and private receipt');
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
