import { createHash } from "node:crypto";
import protocol from "../../functions/lib/public-release-pair.js";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const refuse = () => { throw new Error("Private pair provider operation was refused"); };
export class PrivateProviderNotSent extends Error {
  constructor() { super("Private provider effect was not sent"); this.name = "PrivateProviderNotSent"; }
}
const uuid = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value ?? "");
export function privateWorkerMetadata(config, attemptTag) {
  if (!config || config.workers_dev !== false || config.preview_urls !== false || config.routes?.length !== 0 ||
      !/^njpbs-(?:pair-slot-[a-f0-9-]{36}|private-ingress-[a-z0-9-]{1,30}|private-(?:reader|operator)-[a-z0-9-]{1,40})$/.test(config.name) ||
      !/^[a-f0-9]{32}$/.test(config.account_id) || !/^[a-f0-9]{64}$/.test(attemptTag)) refuse();
  const bindings = Object.entries(config.vars).map(([name, text]) => ({ name, type: "plain_text", text }));
  for (const bucket of config.r2_buckets) bindings.push({ name: bucket.binding, type: "r2_bucket", bucket_name: bucket.bucket_name });
  for (const service of config.services) bindings.push({ name: service.binding, type: "service", service: service.service, entrypoint: service.entrypoint });
  if (config.version_metadata) bindings.push({ name: config.version_metadata.binding, type: "version_metadata" });
  bindings.sort((a, b) => a.name.localeCompare(b.name, "en"));
  return { main_module: "index.mjs", compatibility_date: config.compatibility_date, compatibility_flags: config.compatibility_flags,
    bindings, annotations: { "workers/message": `private-pair:${attemptTag}`, "workers/triggered_by": "version_upload" } };
}
/** REST transport only. Credential callback executes separately for each use.
 * Provider error bodies, tokens and multipart content never enter error output.
 * API contracts: developers.cloudflare.com/api/resources/workers/subresources/scripts/ */
export function cloudflarePrivatePairProvider({ accountId, credential, fetcher = fetch }) {
  if (!/^[a-f0-9]{32}$/.test(accountId ?? "") || typeof credential !== "function") refuse();
  const request = async (path, { method = "GET", body, signal, raw = false, missing = false } = {}) => {
    let token;
    try {
      if (method !== "GET" && (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST)) throw new PrivateProviderNotSent();
      signal?.throwIfAborted(); token = await credential(); signal?.throwIfAborted();
    }
    catch { throw new PrivateProviderNotSent(); }
    let response;
    try { response = await fetcher(`https://api.cloudflare.com/client/v4${path}`, { method, body,
      headers: { authorization: `Bearer ${token}`, ...(body && !(body instanceof FormData) ? { "content-type": "application/json" } : {}) },
      redirect: "error", signal }); } catch { refuse(); }
    if (missing && response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); refuse(); }
    if (raw) return response;
    const envelope = await response.json().catch(refuse);
    if (envelope?.success !== true || !Object.hasOwn(envelope, "result")) refuse();
    return envelope.result;
  };
  const script = name => {
    if (!/^njpbs-(?:pair-slot-[a-f0-9-]{36}|private-ingress-[a-z0-9-]{1,30}|private-(?:reader|operator)-[a-z0-9-]{1,40})$/.test(name)) refuse();
    return `/accounts/${accountId}/workers/scripts/${name}`;
  };
  return {
    worker: (name, signal) => { script(name); return request(`/accounts/${accountId}/workers/workers/${name}`, { signal, missing: true }); },
    create: (name, tag, signal) => { script(name); if (!/^[a-f0-9]{64}$/.test(tag)) refuse();
      // A fresh Worker cannot use versions upload yet. Create its EMPTY
      // parent atomically private, before uploading any executable code.
      return request(`/accounts/${accountId}/workers/workers`, { method: "POST", signal,
        body: JSON.stringify({ name, subdomain: { enabled: false, previews_enabled: false }, tags: [`private-pair:${tag}`] }) });
    },
    async versions(name, signal) {
      const value = await request(`${script(name)}/versions?page=1&per_page=100`, { signal, missing: true });
      if (value === null) return [];
      const items = value.items ?? value;
      // These are fresh private names, not an unbounded shared version history.
      if (!Array.isArray(items) || items.length >= 100) refuse();
      return items;
    },
    async upload(name, metadata, source, signal) {
      const form = new FormData();
      form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
      form.set("index.mjs", new Blob([source], { type: "application/javascript+module" }), "index.mjs");
      const value = await request(`${script(name)}/versions`, { method: "POST", body: form, signal });
      if (!uuid(value?.id)) refuse(); return value.id;
    },
    version: (name, id, signal) => { if (!uuid(id)) refuse(); return request(`${script(name)}/versions/${id}`, { signal }); },
    async deployment(name, signal) {
      const value = await request(`${script(name)}/deployments`, { signal, missing: true });
      if (value === null) return null;
      const rows = value.deployments ?? value;
      if (!Array.isArray(rows)) refuse(); return rows[0] ?? null;
    },
    deploy: (name, version, tag, signal) => request(`${script(name)}/deployments`, { method: "POST", signal,
      body: JSON.stringify({ strategy: "percentage", versions: [{ version_id: version, percentage: 100 }], annotations: { "workers/message": `private-pair:${tag}` } }) }),
    subdomain: (name, signal) => request(`${script(name)}/subdomain`, { signal }),
    disableSubdomain: (name, signal) => request(`${script(name)}/subdomain`, { method: "POST", signal, body: JSON.stringify({ enabled: false, previews_enabled: false }) }),
    async sourceDigest(name, signal) {
      const response = await request(`${script(name)}/content/v2`, { raw: true, signal });
      const contentType = response.headers.get("content-type") ?? "";
      const reader = response.body?.getReader(); if (!reader) refuse();
      const chunks = []; let size = 0;
      try { while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.length; if (size > 1024 * 1024 + 64 * 1024) refuse(); chunks.push(chunk.value);
      } } finally { await reader.cancel().catch(() => {}); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      if (contentType.startsWith("multipart/form-data")) {
        const form = await new Response(bytes, { headers: { "content-type": contentType } }).formData().catch(refuse), main = form.get("index.mjs");
        if (!(main instanceof Blob) || main.size > 1024 * 1024 || [...form.keys()].filter(key => key !== "metadata").join() !== "index.mjs") refuse();
        return hash(new Uint8Array(await main.arrayBuffer()));
      }
      if (!/^(?:application\/(?:javascript|octet-stream)|text\/javascript)(?:;|$)/.test(contentType) || bytes.length > 1024 * 1024) refuse();
      return hash(bytes);
    },
    async assertNoPublicRoutes(name, signal) {
      const domains = await request(`/accounts/${accountId}/workers/domains`, { signal });
      if (!Array.isArray(domains) || domains.some(row => row.service === name)) refuse();
      const zones = await request(`/zones?account.id=${accountId}&page=1&per_page=50`, { signal });
      if (!Array.isArray(zones) || zones.length >= 50) refuse();
      for (const zone of zones) {
        if (!/^[a-f0-9]{32}$/.test(zone.id)) refuse();
        const routes = await request(`/zones/${zone.id}/workers/routes`, { signal });
        if (!Array.isArray(routes) || routes.some(row => row.script === name)) refuse();
      }
    },
  };
}
/** One durable claim precedes each non-idempotent effect. A later caller may
 * only reconcile the original claim; it never retries an ambiguous POST. */
export async function installPrivateWorker({ ledger, provider, attemptId, config, source, dryRun = true, signal }) {
  signal?.throwIfAborted();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(attemptId ?? "") || !(source instanceof Uint8Array) || source.length < 1 || source.length > 1024 * 1024) refuse();
  const sourceDigest = hash(source), { main, ...portableConfig } = config;
  if (typeof main !== "string") refuse();
  const planDigest = protocol.publicReleaseDigest({ config: portableConfig, sourceDigest });
  const tag = protocol.publicReleaseDigest({ attemptId, planDigest }), metadata = privateWorkerMetadata(config, tag);
  if (dryRun) return { dryRun, attemptId, worker: config.name, planDigest, sourceDigest, metadata };
  const step = (action, effect, observe) => {
    signal?.throwIfAborted(); // Known pre-cancellation must not reserve a send.
    return ledger.once({ attemptId, worker: config.name, planDigest, action, effect, observe });
  };
  const checkWorker = async () => {
    const row = await provider.worker(config.name, signal);
    if (!row || row.name !== config.name || !/^[a-f0-9]{32}$/.test(row.id ?? "") ||
        row.tags?.length !== 1 || row.tags[0] !== `private-pair:${tag}` ||
        row.subdomain?.enabled !== false || row.subdomain.previews_enabled !== false) refuse();
    return { workerId: row.id, name: row.name, tag };
  };
  if (await provider.worker(config.name, signal)) await checkWorker();
  await step("create", () => provider.create(config.name, tag, signal), checkWorker);
  const versions = await provider.versions(config.name, signal);
  if (versions.some(row => row.annotations?.["workers/message"] !== `private-pair:${tag}`)) refuse();
  let versionId;
  await step("upload", () => provider.upload(config.name, metadata, source, signal), async () => {
    const matches = (await provider.versions(config.name, signal)).filter(row => row.annotations?.["workers/message"] === `private-pair:${tag}`);
    if (matches.length !== 1 || !uuid(matches[0].id)) refuse(); versionId = matches[0].id;
    const version = await provider.version(config.name, versionId, signal);
    const bindings = version.resources?.bindings;
    if (!Array.isArray(bindings)) refuse();
    const normalized = bindings.map(binding => {
      const value = { ...binding };
      if (value.type === "service" && value.environment === "production") delete value.environment;
      return value;
    }).sort((a, b) => a.name.localeCompare(b.name, "en"));
    if (version.resources?.script_runtime?.compatibility_date !== metadata.compatibility_date ||
        protocol.publicReleaseDigest(version.resources?.script_runtime?.compatibility_flags) !== protocol.publicReleaseDigest(metadata.compatibility_flags)) refuse();
    if (version.id !== versionId || version.annotations?.["workers/message"] !== `private-pair:${tag}` ||
        protocol.publicReleaseDigest(normalized) !== protocol.publicReleaseDigest(metadata.bindings)) refuse();
    return { versionId };
  });
  await provider.assertNoPublicRoutes(config.name, signal);
  await step("private-subdomain", () => provider.disableSubdomain(config.name, signal), async () => {
    const observed = await provider.subdomain(config.name, signal);
    if (observed.enabled !== false || observed.previews_enabled !== false) refuse(); return { private: true };
  });
  const checkDeployment = async () => {
    const observed = await provider.deployment(config.name, signal);
    if (observed?.annotations?.["workers/message"] !== `private-pair:${tag}` || observed.versions?.length !== 1 ||
        observed.versions[0].version_id !== versionId || observed.versions[0].percentage !== 100 || !uuid(observed.id)) refuse();
    return { deploymentId: observed.id, versionId };
  };
  await step("deploy", () => provider.deploy(config.name, versionId, tag, signal), checkDeployment);
  await checkDeployment();
  if (await provider.sourceDigest(config.name, signal) !== sourceDigest) refuse();
  await checkDeployment();
  await provider.assertNoPublicRoutes(config.name, signal);
  const exposure = await provider.subdomain(config.name, signal);
  if (exposure.enabled !== false || exposure.previews_enabled !== false) refuse();
  return { dryRun: false, attemptId, worker: config.name, planDigest, sourceDigest, versionId };
}
