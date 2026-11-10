import { readFileSync } from 'node:fs';
import ts from 'typescript';
const mode = process.argv[2];
if (!['check', 'remove'].includes(mode)) throw new Error('Select check or remove');
if (mode === 'check' && !['', 'false'].includes(process.env.CMS_DEV_PUBLISH_ENABLED ?? '')) {
  throw new Error('Keep dev publication disabled before deploying the production-bound shadow');
}
function readConfig(path) {
  const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, 'utf8'));
  if (parsed.error || !parsed.config) throw new Error('Invalid Worker config');
  return parsed.config;
}
const config = readConfig('workers/wrangler.shadow-posts.jsonc');
const parentOwners = [
  readConfig('workers/wrangler.staff-sites.jsonc').name,
  readConfig('workers/wrangler.staff-sites.dev.jsonc').name,
];
if (parentOwners.some(name => typeof name !== 'string' || !/^[a-z0-9-]+$/.test(name)) ||
    new Set(parentOwners).size !== 2) throw new Error('Expected two configured staff gateway owners');
const route = config.routes?.[0];
if (config.name !== 'njpbs-shadow-posts' || config.routes?.length !== 1 ||
    route.zone_name !== 'njpbs.org' || route.pattern !== 'https://dev-public.example.org/posts/*') {
  throw new Error('Must target only the configured dev shadow route');
}
const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !/^[a-f0-9]{32}$/.test(account || '')) throw new Error('Missing Cloudflare credentials');
async function api(path, method = 'GET') {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method, headers: { Authorization: `Bearer ${token}` },
    redirect: 'error', signal: AbortSignal.timeout(30000),
  });
  let body;
  try { body = await response.json(); }
  catch { throw new Error('Invalid Cloudflare route response'); }
  if (!response.ok || body.success !== true) {
    throw new Error(`Cloudflare route request failed (${response.status})`);
  }
  return body.result;
}
const query = new URLSearchParams({ name: route.zone_name, 'account.id': account });
const zones = await api(`/zones?${query}`);
if (!Array.isArray(zones) || zones.length !== 1 || zones[0].name !== route.zone_name ||
    zones[0].account?.id !== account || !/^[a-f0-9]{32}$/.test(zones[0].id)) {
  throw new Error('Expected one matching zone in the configured account');
}
const path = `/zones/${zones[0].id}/workers/routes`;
const routes = await api(path);
function parentRoute(routes) {
  const parents = Array.isArray(routes) ? routes.filter(r => r.pattern === 'dev-public.example.org/*') : [];
  if (parents.length !== 1 || !parentOwners.includes(parents[0].script) ||
      !/^[a-f0-9]{32}$/.test(parents[0].id)) {
    throw new Error('Expected one dev staff gateway route with a configured owner');
  }
  return parents[0];
}
const parent = parentRoute(routes);
const matches = routes.filter((r) => r.pattern === route.pattern);
if (matches.length > 1 || matches.some((r) =>
    (r.script && r.script !== config.name) || !/^[a-f0-9]{32}$/.test(r.id))) {
  throw new Error('Unexpected shadow route ownership or identity');
}
if (mode === 'check') {
  console.log('Dev shadow route admission verified');
} else {
  for (const match of matches) await api(`${path}/${match.id}`, 'DELETE');
  const remaining = await api(path);
  if (!Array.isArray(remaining) || remaining.some((r) => r.pattern === route.pattern)) {
    throw new Error('The shadow route remains; Workers will not be deleted');
  }
  const remainingParent = parentRoute(remaining);
  if (remainingParent.id !== parent.id || remainingParent.script !== parent.script) {
    throw new Error('Dev staff gateway changed during removal; Workers will not be deleted');
  }
  console.log('Dev shadow route absent; the staff gateway owns Post paths');
}
