import { previewRendererBindings } from "./deployment-settings.mjs";
import { createHash } from "node:crypto";
import path from "node:path";
import { PrivateProviderNotSent } from "./public-release-private-provider.mjs";

const ACCOUNT = (process.env.CLOUDFLARE_ACCOUNT_ID ?? "");
const API = "https://api.cloudflare.com/client/v4";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const RESOURCE = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
const SECRETS = ["FIREBASE_SERVICE_ACCOUNT", "R2_PREVIEW_CREDENTIAL", "CMS_EDGE_ORIGIN_SECRET"];
const DEV_SECRETS = ["CMS_DEV_ACCESS_CLIENT_ID", "CMS_DEV_ACCESS_CLIENT_SECRET"];
const CONTRACTS = ["previewRequest", "postChrome", "settings", "capabilities", "adminSession"];
const privateBytes = new WeakMap();
export class PreviewProviderError extends Error {
  constructor(code, uncertain = false) { super("Private preview provider refused"); this.code = code; this.uncertain = uncertain; }
}
const reject = (code = "invalid-input", uncertain = false) => { throw new PreviewProviderError(code, uncertain); };
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
function exact(v, keys) { if (!object(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) reject(); }
const canonical = v => Array.isArray(v) ? v.map(canonical) : object(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
export const previewProviderDigest = v => createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");
const hash = v => createHash("sha256").update(v).digest("hex");
const same = (a, b) => { if (previewProviderDigest(a) !== previewProviderDigest(b)) reject("readback-differs"); };
function freeze(v) { if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
function sort(rows) {
  if (!Array.isArray(rows) || rows.some(r => !object(r) || typeof r.name !== "string") || new Set(rows.map(r => r.name)).size !== rows.length) reject();
  return rows.slice().sort((a, b) => a.name.localeCompare(b.name, "en"));
}
function descriptor(raw) {
  exact(raw, ["schemaVersion", "pairId", "rendererSha", "serializerId", "workerName", "applicationName", "imageDigest", "requirements", "capabilities"]);
  if (raw.schemaVersion !== 2 || typeof raw.pairId !== "string" || !/^preview-[a-z0-9][a-z0-9-]{0,31}$/.test(raw.pairId) ||
      raw.serializerId !== raw.pairId || raw.workerName !== `njpbs-${raw.pairId}` || raw.applicationName !== raw.workerName ||
      !/^[a-f0-9]{40}$/.test(raw.rendererSha) || !/^sha256:[a-f0-9]{64}$/.test(raw.imageDigest)) reject();
  exact(raw.requirements, CONTRACTS);
  if (Object.values(raw.requirements).some(v => !Number.isSafeInteger(v) || v < 1 || v > 100)) reject();
  exact(raw.capabilities, ["dataHubCompositionVersion", "liveBlogVersion", "electionResultsVersion"]);
  if (Object.entries(raw.capabilities).some(([key, value]) => key === "electionResultsVersion" ? ![1, 2].includes(value) : value !== 1)) reject();
  return freeze(structuredClone(raw));
}
/** A versionless seal: never invent an assigned Worker UUID to plan its upload. */
export function privatePreviewPairConfiguration(raw, { main, image, environment = "production", rendererReady = false }) {
  const pair = descriptor(raw);
  if (!/^[a-f0-9]{32}$/.test(ACCOUNT) || typeof rendererReady !== "boolean" || !path.isAbsolute(main) || !main.endsWith("/preview-renderer/worker.ts") ||
      !["production", "development"].includes(environment) ||
      !new RegExp(`^registry\\.cloudflare\\.com/${ACCOUNT}/[a-z0-9][a-z0-9_./-]*@${pair.imageDigest}$`).test(image)) reject();
  return freeze({ name: pair.workerName, main, account_id: ACCOUNT, compatibility_date: "2026-09-09",
    compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"], workers_dev: false, preview_urls: false, routes: [],
    secrets: { required: environment === "development" ? [...SECRETS, ...DEV_SECRETS] : SECRETS }, vars: { ...previewRendererBindings(environment, ACCOUNT), PREVIEW_PAIR_MODE: "true", PREVIEW_RENDERER_ENABLED: String(rendererReady),
      PREVIEW_RENDERER_SHA: pair.rendererSha, PREVIEW_SERIALIZER_ID: pair.pairId, CMS_DEPLOYMENT_ENVIRONMENT: environment,
      FIREBASE_PROJECT_ID: environment === "production" ? "njpbs-site" : "njpbs-site-dev" },
    version_metadata: { binding: "PREVIEW_WORKER_VERSION" },
    durable_objects: { bindings: [{ name: "RENDERER", class_name: "PreviewRenderer" }] },
    exports: { PreviewRenderer: { type: "durable-object", storage: "sqlite" } },
    containers: [{ name: pair.applicationName, class_name: "PreviewRenderer", image, instance_type: "standard-2", max_instances: 1 }],
    triggers: { crons: ["* * * * *"] } });
}
function bindings(config) {
  return sort([...Object.entries(config.vars).map(([name, text]) => ({ name, type: "plain_text", text })),
    ...config.secrets.required.map(name => ({ name, type: "inherit" })), { name: "PREVIEW_WORKER_VERSION", type: "version_metadata" },
    { name: "RENDERER", type: "durable_object_namespace", class_name: "PreviewRenderer" }]);
}
/** Consume actual secret-free Wrangler dry-run multipart; only this function
 * mints the opaque handle whose copied source bytes can be uploaded. */
export async function preparePrivatePreviewPair({ pair: raw, config, multipart, image }) {
  const pair = descriptor(raw);
  same(config, privatePreviewPairConfiguration(pair, { main: config.main, image,
    environment: config.vars?.CMS_DEPLOYMENT_ENVIRONMENT, rendererReady: config.vars?.PREVIEW_RENDERER_ENABLED === "true" }));
  if (!(multipart instanceof Uint8Array) || multipart.byteLength < 1 || multipart.byteLength > 32 * 1024 * 1024) reject();
  const bytes = Buffer.from(multipart), boundary = bytes.subarray(0, bytes.indexOf(10)).toString("ascii").replace(/\r$/, "");
  if (!/^--[a-zA-Z0-9_-]{1,200}$/.test(boundary)) reject();
  let form;
  try { form = await new Response(bytes, { headers: { "content-type": `multipart/form-data; boundary=${boundary.slice(2)}` } }).formData(); } catch { reject(); }
  const keys = [...form.keys()]; if (new Set(keys).size !== keys.length || keys.length > 128) reject();
  let metadata;
  try { metadata = JSON.parse(form.get("metadata")); } catch { reject(); }
  const required = ["main_module", "compatibility_date", "compatibility_flags", "bindings", "exports", "containers", "keep_bindings"];
  if (!object(metadata) || required.some(k => !Object.hasOwn(metadata, k)) || Object.keys(metadata).some(k => !required.includes(k) && !["annotations", "package_dependencies"].includes(k))) reject();
  same(sort(metadata.bindings), bindings(config)); same(metadata.exports, config.exports);
  same(metadata.containers, [{ name: pair.applicationName, class_name: "PreviewRenderer" }]);
  same(metadata.compatibility_date, config.compatibility_date); same(metadata.compatibility_flags, config.compatibility_flags);
  same(metadata.keep_bindings, ["secret_text", "secret_key"]);
  if (metadata.annotations !== undefined && (!object(metadata.annotations) || Object.entries(metadata.annotations).some(([k, v]) => !k.startsWith("workers/") || typeof v !== "string" || v.length > 1000))) reject();
  if (metadata.package_dependencies !== undefined && !Array.isArray(metadata.package_dependencies)) reject();
  const modules = [];
  for (const [name, part] of form) {
    if (name === "metadata") continue;
    if (!(part instanceof Blob) || !/^[a-zA-Z0-9_./-]+$/.test(name) || name.split("/").includes("..") ||
        !["application/javascript+module", "application/wasm", "text/plain", "application/octet-stream", "application/source-map"].includes(part.type)) reject();
    modules.push({ name, type: part.type, bytes: Buffer.from(await part.arrayBuffer()) });
  }
  modules.sort((a, b) => a.name.localeCompare(b.name, "en"));
  if (!modules.some(m => m.name === metadata.main_module && m.type === "application/javascript+module")) reject();
  const moduleManifest = modules.map(m => ({ name: m.name, contentType: m.type, byteLength: m.bytes.length, sha256: hash(m.bytes) }));
  const handle = freeze({ pair, applicationName: pair.applicationName, accountId: ACCOUNT, image,
    rendererReady: config.vars.PREVIEW_RENDERER_ENABLED === "true", environment: config.vars.CMS_DEPLOYMENT_ENVIRONMENT,
    moduleManifest, bundleDigest: previewProviderDigest({ mainModule: metadata.main_module, moduleManifest }),
    // The local entry path is checked by the CLI, while exact deployed module
    // bytes are sealed separately. A checkout relocation is not provider drift.
    configurationDigest: previewProviderDigest({ config: Object.fromEntries(Object.entries(config).filter(([key]) => key !== "main")), metadata }) });
  privateBytes.set(handle, { config: structuredClone(config), metadata: structuredClone(metadata), modules });
  return handle;
}

/** Strict preview-specific transport; methods never grant their own write
 * permission. The installer must reserve each mutation before calling it.
 * @param {{prepared: object, operationDigest: string, readToken: () => string | Promise<string>,
 * readSecret: (name: string) => string | Promise<string>, fetchImpl?: typeof fetch, signal?: AbortSignal}} options
 */
export function createPrivatePreviewPairProvider({ prepared, operationDigest, readToken, readSecret, fetchImpl = fetch, signal }) {
  const state = privateBytes.get(prepared);
  if (!state || typeof operationDigest !== "string" || !/^[a-f0-9]{64}$/.test(operationDigest) || typeof readToken !== "function" || typeof readSecret !== "function" || typeof fetchImpl !== "function") reject();
  const { config, metadata, modules } = state, prefix = `/accounts/${ACCOUNT}`, script = `${prefix}/workers/scripts/${prepared.applicationName}`,
    resource = `${prefix}/workers/workers/${prepared.applicationName}`;
  async function http(endpoint, { method = "GET", body, missing = false } = {}) {
    let sent = false;
    try {
      if (fetchImpl === fetch && (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST)) reject("emulator-provider-refused");
      signal?.throwIfAborted(); const token = await readToken(); signal?.throwIfAborted();
      if (typeof token !== "string" || !token || /[\r\n]/.test(token)) reject();
      const headers = { authorization: `Bearer ${token}`, ...(body && !(body instanceof FormData) ? { "content-type": "application/json" } : {}) };
      sent = true;
      const response = await fetchImpl(API + endpoint, { method, headers, body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
        redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
      if (missing && method === "GET" && response.status === 404) { await response.body?.cancel(); return null; }
      if (!response.ok || response.redirected || !response.body) { await response.body?.cancel(); reject(); }
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.byteLength; if (size > 48 * 1024 * 1024) reject(); chunks.push(chunk); }
      const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (result.success !== true || !Object.hasOwn(result, "result") || result.errors?.length) reject();
      return result;
    } catch {
      if (!sent && method !== "GET") throw new PrivateProviderNotSent();
      reject("provider-request-failed", sent && method !== "GET");
    }
  }
  async function list(endpoint, mode = "single") {
    const rows = []; let cursor, total;
    const seen = new Set();
    for (let page = 1; page <= 1000; page++) {
      const suffix = mode === "single" ? "" : mode === "cursor" ? `?per_page=100${cursor ? `&page_token=${encodeURIComponent(cursor)}` : ""}`
        : `${endpoint.includes("?") ? "&" : "?"}page=${page}&per_page=50`;
      const envelope = await http(endpoint + suffix), batch = envelope.result, info = envelope.result_info;
      if (!Array.isArray(batch)) reject("incomplete-inventory");
      rows.push(...batch);
      if (mode === "cursor") {
        if (!object(info) || info.page_token !== undefined && info.page_token !== cursor) reject("incomplete-inventory");
        const next = info.next_page_token;
        if (next === null || next === undefined || next === "") break;
        if (typeof next !== "string" || seen.has(next)) reject("incomplete-inventory"); seen.add(next); cursor = next;
      } else if (mode === "numbered") {
        if (!object(info) || info.page !== page || info.count !== batch.length || !Number.isSafeInteger(info.total_count) || info.total_count < 0) reject("incomplete-inventory");
        total ??= info.total_count;
        if (total !== info.total_count || rows.length > total) reject("incomplete-inventory");
        if (rows.length === total) break;
        if (!batch.length) reject("incomplete-inventory");
      } else {
        if (info !== undefined && (!object(info) || info.total_count !== rows.length || info.count !== rows.length || info.page !== 1)) reject("incomplete-inventory");
        break;
      }
      if (page === 1000) reject("incomplete-inventory");
    }
    if (rows.some(v => typeof v?.id !== "string") || new Set(rows.map(v => v.id)).size !== rows.length) reject("incomplete-inventory");
    return rows;
  }
  async function privacy() {
    const domains = await list(`${prefix}/workers/domains`), zones = await list(`/zones?account.id=${ACCOUNT}`, "numbered");
    if (domains.some(d => typeof d.service !== "string" || d.service === prepared.applicationName)) reject("public-ingress");
    let routeCount = 0;
    for (const zone of zones) {
      if (!/^[a-f0-9]{32}$/.test(zone.id) || zone.account?.id !== ACCOUNT) reject("inventory-account");
      const routes = await list(`/zones/${zone.id}/workers/routes`);
      if (routes.some(r => !Object.hasOwn(r, "script") || r.script !== null && typeof r.script !== "string" || r.script === prepared.applicationName)) reject("public-ingress");
      routeCount += routes.length;
    }
    return { private: true, zoneIds: zones.map(z => z.id), domainCount: domains.length, routeCount };
  }
  async function worker() {
    const envelope = await http(resource, { missing: true }); if (envelope === null) return null;
    const value = envelope.result;
    if (!RESOURCE.test(value?.id) || value.name !== prepared.applicationName || value.subdomain?.enabled !== false || value.subdomain.previews_enabled !== false) reject("worker-identity");
    same(value.tags, [`private-preview:${operationDigest}`]);
    return { workerId: value.id, name: value.name, private: true, operationDigest };
  }
  async function applications() { return list(`${prefix}/containers/applications`, "cursor"); }
  async function namespaces() { return list(`${prefix}/workers/durable_objects/namespaces`, "numbered"); }
  function normalizeBindings(raw, requireNamespace) {
    let namespaceId = null;
    const result = sort(raw).map(binding => {
      if (config.secrets.required.includes(binding.name)) {
        exact(binding, ["name", "type"]); if (binding.type !== "secret_text") reject("secret-binding");
        return { name: binding.name, type: "inherit" };
      }
      if (binding.name === "RENDERER") {
        if (Object.keys(binding).some(k => !["name", "type", "class_name", "script_name", "namespace_id"].includes(k)) ||
            binding.type !== "durable_object_namespace" || binding.class_name !== "PreviewRenderer" ||
            binding.script_name !== undefined && binding.script_name !== prepared.applicationName) reject("namespace-binding");
        if (binding.namespace_id !== undefined) { if (!RESOURCE.test(binding.namespace_id)) reject(); namespaceId = binding.namespace_id; }
        if (requireNamespace && !namespaceId) reject("namespace-not-ready");
        return { name: "RENDERER", type: "durable_object_namespace", class_name: "PreviewRenderer" };
      }
      return binding;
    });
    same(result, bindings(config)); return namespaceId;
  }
  function exports(value) {
    if (!object(value) || !object(value.PreviewRenderer) || Object.keys(value).some(k => !["PreviewRenderer", "default"].includes(k))) reject("exports");
    const renderer = value.PreviewRenderer;
    if (renderer.type !== "durable-object" || renderer.storage !== "sqlite" ||
        Object.keys(renderer).some(k => !["type", "storage", "state", "container"].includes(k)) ||
        renderer.state !== undefined && renderer.state !== "created" || renderer.container !== undefined && renderer.container !== prepared.applicationName) reject("exports");
    if (value.default !== undefined && (value.default.type !== "worker" || value.default.state !== undefined && value.default.state !== "created")) reject("exports");
  }
  async function version(versionId, requireNamespace = false) {
    if (!UUID.test(versionId)) reject();
    const detail = (await http(`${script}/versions/${versionId}`)).result;
    const code = (await http(`${resource}/versions/${versionId}?include=modules`)).result;
    if (detail?.id !== versionId || code?.id !== versionId || code.main_module !== metadata.main_module || !Array.isArray(code.urls) || code.urls.length) reject("version-identity");
    for (const runtime of [detail.resources?.script_runtime, code]) {
      same(runtime?.compatibility_date, metadata.compatibility_date); same(runtime?.compatibility_flags, metadata.compatibility_flags); exports(runtime?.exports);
    }
    const namespaceId = normalizeBindings(detail.resources?.bindings, requireNamespace);
    if (normalizeBindings(code.bindings, requireNamespace) !== namespaceId) reject("namespace-differs");
    const attached = code.containers;
    if (!Array.isArray(attached) || attached.length !== 1 || attached[0].class_name !== "PreviewRenderer" ||
        attached[0].name !== undefined && attached[0].name !== prepared.applicationName ||
        Object.keys(attached[0]).some(k => !["class_name", "name"].includes(k))) reject("container-class");
    const handlers = detail.resources?.script?.named_handlers;
    if (!Array.isArray(handlers) || handlers.length !== 1 || handlers[0].name !== "PreviewRenderer") reject("handlers");
    if (!Array.isArray(code.modules)) reject("module-readback");
    const manifest = code.modules.map(m => {
      if (typeof m.content_base64 !== "string") reject("module-readback");
      const bytes = Buffer.from(m.content_base64, "base64"); if (bytes.toString("base64") !== m.content_base64) reject("module-readback");
      return { name: m.name, contentType: m.content_type, byteLength: bytes.length, sha256: hash(bytes) };
    }).sort((a, b) => a.name.localeCompare(b.name, "en"));
    same(manifest, prepared.moduleManifest);
    if (metadata.package_dependencies !== undefined) same(code.package_dependencies, metadata.package_dependencies);
    for (const [k, v] of Object.entries(metadata.annotations ?? {})) if (code.annotations?.[k] !== v) reject("annotations");
    return { versionId, namespaceId: requireNamespace ? namespaceId : null, bundleDigest: prepared.bundleDigest, configurationDigest: prepared.configurationDigest };
  }
  async function namespace(versionId) {
    const observed = await version(versionId, true);
    const matching = (await namespaces()).filter(n => n.script === prepared.applicationName && n.class === "PreviewRenderer");
    if (matching.length !== 1 || matching[0].id !== observed.namespaceId || matching[0].use_sqlite !== true || matching[0].preview !== undefined || matching[0].dispatch_namespace !== undefined) reject("namespace-identity");
    return { namespaceId: observed.namespaceId, versionId };
  }
  async function deployment(versionId) {
    const rows = (await http(`${script}/deployments`)).result?.deployments, current = rows?.[0];
    if (!Array.isArray(rows) || !UUID.test(current?.id) || current.strategy !== "percentage") reject("deployment");
    same(current.versions, [{ version_id: versionId, percentage: 100 }]); return { deploymentId: current.id, versionId };
  }
  async function container(namespaceId) {
    const matching = (await applications()).filter(a => a.name === prepared.applicationName);
    if (matching.length !== 1 || !RESOURCE.test(matching[0].id)) reject("container-identity");
    const value = (await http(`${prefix}/containers/applications/${matching[0].id}`)).result;
    if (value?.id !== matching[0].id || value.account_id !== ACCOUNT || value.name !== prepared.applicationName ||
        value.scheduling_policy !== "default" || value.instances !== 0 || value.max_instances !== 1 || value.durable_objects?.namespace_id !== namespaceId ||
        value.configuration?.image !== prepared.image || value.configuration.instance_type !== "standard-2" ||
        value.active_rollout_id !== undefined && value.active_rollout_id !== null) reject("container-configuration");
    for (const key of ["command", "entrypoint", "environment_variables", "authorized_keys", "trusted_user_ca_keys"]) {
      if (value.configuration[key] !== undefined && (!Array.isArray(value.configuration[key]) || value.configuration[key].length)) reject("container-overrides");
    }
    if (value.configuration.wrangler_ssh !== undefined && value.configuration.wrangler_ssh?.enabled !== false) reject("container-ssh");
    return { applicationId: value.id, namespaceId, imageDigest: prepared.pair.imageDigest, configurationDigest: prepared.configurationDigest };
  }
  async function schedules() {
    const value = (await http(`${script}/schedules`)).result?.schedules;
    if (!Array.isArray(value) || value.length !== 1 || value[0].cron !== "* * * * *") reject("schedules");
    return { crons: ["* * * * *"] };
  }
  return Object.freeze({ worker, privacy, version, namespace, deployment, container, schedules,
    async inventory() { return { worker: await worker(), applications: (await applications()).filter(a => a.name === prepared.applicationName).map(a => ({ id: a.id, name: a.name })),
      namespaces: (await namespaces()).filter(n => n.script === prepared.applicationName).map(n => ({ id: n.id, className: n.class })) , privacy: await privacy() }; },
    async privateInventory() { const value = (await http(`${script}/subdomain`)).result;
      if (value?.enabled !== false || value.previews_enabled !== false) reject("public-subdomain"); return { ...await privacy(), subdomain: { enabled: false, previews_enabled: false } }; },
    async createIdentity() { await http(`${prefix}/workers/workers`, { method: "POST", body: { name: prepared.applicationName,
      tags: [`private-preview:${operationDigest}`], subdomain: { enabled: false, previews_enabled: false } } }); },
    async upload() {
      const upload = structuredClone(metadata);
      try {
        const values = new Map();
        for (const name of config.secrets.required) { signal?.throwIfAborted(); const value = await readSecret(name);
          if (typeof value !== "string" || !value || value.length > 64 * 1024) reject(); values.set(name, value); }
        upload.bindings = upload.bindings.map(b => values.has(b.name) ? { name: b.name, type: "secret_text", text: values.get(b.name) } : b);
      } catch { throw new PrivateProviderNotSent(); }
      const form = new FormData(); form.set("metadata", JSON.stringify(upload));
      for (const m of modules) form.set(m.name, new Blob([m.bytes], { type: m.type }), m.name);
      const result = (await http(`${script}/versions?bindings_inherit=strict`, { method: "POST", body: form })).result;
      if (!UUID.test(result?.id)) reject("upload-result", true); return { versionId: result.id };
    },
    async recoverVersion() {
      const rows = (await http(`${script}/versions?deployable=true`)).result?.items;
      if (!Array.isArray(rows) || rows.length > 1000 || new Set(rows.map(r => r.id)).size !== rows.length) reject("version-inventory");
      const matching = [];
      for (const row of rows) { if (!UUID.test(row.id)) reject(); matching.push(await version(row.id)); }
      if (matching.length !== 1) reject("version-reconciliation-required"); return matching[0];
    },
    async deploy(versionId) { if (!UUID.test(versionId)) reject(); await http(`${script}/deployments`, { method: "POST", body: { strategy: "percentage", versions: [{ version_id: versionId, percentage: 100 }] } }); },
    async createContainer(namespaceId) { if (!RESOURCE.test(namespaceId)) reject(); await http(`${prefix}/containers/applications`, { method: "POST", body: {
      name: prepared.applicationName, scheduling_policy: "default", configuration: { image: prepared.image, instance_type: "standard-2" },
      instances: 0, max_instances: 1, durable_objects: { namespace_id: namespaceId }, rollout_active_grace_period: 0,
    } }); },
    async createSchedules() { await http(`${script}/schedules`, { method: "PUT", body: [{ cron: "* * * * *" }] }); },
  });
}
