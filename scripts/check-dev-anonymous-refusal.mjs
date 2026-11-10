import { devAccessOrigin } from "./lib/deployment-settings.mjs";
import { pathToFileURL } from 'node:url';

export const DEV_HOSTS = ['dev-public.example.org', 'dev-admin.example.org'];
// Keep ordinary URLs: a cache-busting query could hide an exposed cached page.
export const DEV_PATHS = ['/', '/posts/access-probe/',
  '/_publication.json', '/brand/njpbs-horizontal-white-navy.png'];

async function refusalBody(response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks).toString('utf8');
      size += value.length;
      if (size > 256) return null;
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

async function refuses(response, host, method) {
  const cache = response.headers.get('cache-control');
  if (cache) {
    const directives = cache.toLowerCase().split(',').map(value => value.trim());
    if (!directives.includes('no-store') || directives.includes('public') ||
        directives.some(value => /^(?:s-maxage|max-age)\s*=/.test(value) &&
          !/^(?:s-maxage|max-age)\s*=\s*"?0"?$/.test(value))) return false;
  }
  if ([...response.headers.keys()].some(name => name.startsWith('x-njpbs-'))) return false;
  if ([401, 403].includes(response.status)) {
    // A generic WAF/bot 403 is not evidence that a browser is refused.
    if (cache !== 'private, no-store' ||
        response.headers.get('x-robots-tag') !== 'noindex, nofollow, noarchive' ||
        response.headers.get('referrer-policy') !== 'no-referrer' ||
        response.headers.get('x-content-type-options') !== 'nosniff') return false;
    return method === 'HEAD' ||
      await refusalBody(response) === (response.status === 401 ? 'Unauthorized' : 'Site access unavailable');
  }
  if (response.status !== 302) return false;
  try {
    const location = new URL(response.headers.get('location'));
    return location.origin === devAccessOrigin() &&
      !location.username && !location.password &&
      location.pathname === `/cdn-cgi/access/login/${host}`;
  } catch { return false; }
}

export async function checkDevAnonymousRefusal({ hosts = DEV_HOSTS, fetchImpl = fetch,
  log = console.log, signal } = {}) {
  devAccessOrigin();
  if (!hosts.length || hosts.some(host => !DEV_HOSTS.includes(host))) {
    throw new Error('Select an exact dev staff hostname');
  }
  // Concurrent requests make the first failed response fail the round immediately.
  await Promise.all(hosts.flatMap(host => DEV_PATHS.flatMap(path => ['GET', 'HEAD'].map(async method => {
    let status = 'transport failure';
    let passed = false;
    try {
      const response = await fetchImpl(`https://${host}${path}`, {
        method, credentials: 'omit', redirect: 'manual',
        signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]),
      });
      status = response.status;
      passed = await refuses(response, host, method);
      // Only bounded denial bodies are checked in memory. Never print content,
      // cookies, login URLs or raw transport errors.
      void response.body?.cancel().catch(() => {});
    } catch { /* A transport error is a failed proof, never a refusal. */ }
    log(`${host} ${method} ${path}: ${status} ${passed ? 'pass' : 'FAIL'}`);
    if (!passed) throw new Error('Dev anonymous refusal failed');
  }))));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const hosts = process.argv.slice(2);
  checkDevAnonymousRefusal({ ...(hosts.length ? { hosts } : {}) }).catch(() => {
    console.error('Dev anonymous refusal failed');
    process.exitCode = 1;
  });
}
