import { fstatSync } from 'node:fs';
import { Socket } from 'node:net';
const refuse = () => { throw new Error('Development install credential refused'); };
/** Reserve a paused inherited pipe before SDK initialization. Read only at use. */
export function developmentInstallCredential(fd, parse, supplied) {
  if (!supplied) {
    const stat = fstatSync(fd); if (!stat.isFIFO() && !stat.isSocket()) refuse();
  }
  const stream = supplied ?? new Socket({ fd, readable: true, writable: false, pauseOnCreate: true });
  stream.pause?.(); let pending;
  const read = () => pending ??= (async () => {
    const chunks = []; let size = 0, joined;
    const timer = setTimeout(() => stream.destroy(new Error('Development install credential expired')), 10_000);
    try {
      for await (const chunk of stream) { const bytes = Buffer.from(chunk); size += bytes.length; chunks.push(bytes); if (size > 32768) refuse(); }
      joined = Buffer.concat(chunks); return parse(joined.toString('utf8'));
    } catch { return refuse(); }
    finally { clearTimeout(timer); joined?.fill(0); chunks.forEach(value => value.fill(0)); stream.destroy(); }
  })();
  return { read, close: () => stream.destroy() };
}
export const developmentInstallToken = value => {
  const token = value.trim(); if (!/^[\x21-\x7e]{1,32768}$/.test(token)) refuse(); return token;
};
export function developmentInstallAccess(value) {
  const result = JSON.parse(value);
  if (Object.keys(result ?? {}).sort().join() !== 'CF-Access-Client-Id,CF-Access-Client-Secret' ||
      !/^[A-Za-z0-9]+\.access$/.test(result['CF-Access-Client-Id'] ?? '') ||
      !/^[\x21-\x7e]{1,4096}$/.test(result['CF-Access-Client-Secret'] ?? '')) refuse();
  return result;
}
/** Credentials never reach a caller-selected host, redirect or query. */
export function developmentCanonicalRequest(readAccess, request = fetch) {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://dev-public.example.org' || url.username || url.password || url.search || url.hash ||
        !['GET', 'HEAD'].includes(init.method ?? 'GET') || init.body ||
        init.redirect !== undefined && !['manual', 'error'].includes(init.redirect)) refuse();
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(await readAccess())) headers.set(name, value);
    return request(url, { ...init, headers, redirect: init.redirect ?? 'error', cache: 'no-store' });
  };
}
