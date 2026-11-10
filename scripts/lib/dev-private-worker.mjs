const ACCOUNT = (process.env.CMS_DEV_CLOUDFLARE_ACCOUNT_ID ?? "");
const WORKER = 'template-dev-public';

// Both the gateway operator and each publication enforce the private origin.
export async function verifyDevPublicWorkerPrivate(api, routes) {
  if (!/^[a-f0-9]{32}$/.test(ACCOUNT)) throw new Error("Configure the expected development account");
  if (routes === undefined) {
    const zones = await api(`/zones?name=njpbs.org&account.id=${ACCOUNT}`);
    if (!Array.isArray(zones) || zones.length !== 1 ||
        !/^[a-f0-9]{32}$/.test(zones[0]?.id ?? '') ||
        zones[0].name !== 'njpbs.org' || zones[0].account?.id !== ACCOUNT) {
      throw new Error('Expected the configured account and zone');
    }
    routes = await api(`/zones/${zones[0].id}/workers/routes`);
  }
  const subdomain = await api(`/accounts/${ACCOUNT}/workers/scripts/${WORKER}/subdomain`);
  // Filtering by service makes any result a refusal, even on a paged response.
  const domains = await api(`/accounts/${ACCOUNT}/workers/domains?service=${WORKER}`);
  if (subdomain?.enabled !== false || subdomain?.previews_enabled !== false ||
      !Array.isArray(routes) || routes.some(route => !route || route.script === WORKER) ||
      !Array.isArray(domains) || domains.length !== 0) {
    throw new Error('Dev public Worker must have no public route, custom domain, workers.dev or preview URL');
  }
}
