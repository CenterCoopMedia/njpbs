import { createHash } from "node:crypto";
import targets from "../../functions/lib/publication-target.js";

const API = "https://api.cloudflare.com/client/v4";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HEX_ID = /^[a-f0-9]{32}$/;
const NAMESPACE = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
const CLASS = "PairPublicationRuntime";
const SECRET = "FIREBASE_SERVICE_ACCOUNT";
const preparedData = new WeakMap();

/** Errors contain no provider text, request body, credential, URL or cause. */
export class PrivatePairProviderError extends Error {
  constructor(code, uncertain = false) {
    super(`Private pair provider refused: ${code}`);
    this.name = "PrivatePairProviderError";
    this.code = code;
    this.uncertain = uncertain;
  }
}

function requireValue(condition, code = "invalid-input") {
  if (!condition) throw new PrivatePairProviderError(code);
}
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value, keys) {
  requireValue(object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function same(actual, expected, code) {
  requireValue(canonical(actual) === canonical(expected), code);
}
function digest(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}
function freeze(value) {
  if (object(value) || Array.isArray(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function unique(rows, key) {
  requireValue(Array.isArray(rows), "invalid-list");
  const seen = new Set();
  for (const row of rows) {
    requireValue(object(row) && typeof row[key] === "string" && row[key].length > 0 && !seen.has(row[key]), "invalid-list");
    seen.add(row[key]);
  }
  return rows;
}
function sortBindings(bindings) {
  return unique(bindings, "name").slice().sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

function validateConfiguration(config, imageReference) {
  const keys = ["name", "main", "account_id", "compatibility_date", "compatibility_flags", "workers_dev", "preview_urls", "routes", "secrets", "vars", "r2_buckets", "version_metadata", "containers", "durable_objects", "exports", "triggers"];
  const continuationEnabled = Object.hasOwn(config, "services");
  exact(config, [...keys, ...continuationEnabled ? ["services"] : []]);
  requireValue(HEX_ID.test(config.account_id) && /^njpbs-pair-publisher-[a-f0-9-]{36}$/.test(config.name));
  const incarnation = config.name.slice("njpbs-pair-publisher-".length);
  requireValue(UUID.test(incarnation) && typeof config.main === "string" && /\/publisher\/pair-worker\.ts$/.test(config.main));
  requireValue(/^\d{4}-\d{2}-\d{2}$/.test(config.compatibility_date));
  same(config.compatibility_flags, ["nodejs_compat"], "configuration-flags");
  requireValue(config.workers_dev === false && config.preview_urls === false);
  same(config.routes, [], "public-routes");
  same(config.secrets, { required: [SECRET] }, "configuration-secrets");
  const continuationFlags = ["PUBLIC_PAIR_ORIGINAL_RECOVERY_ENABLED", "PUBLIC_PAIR_OWNER_WRITE_ENABLED",
    "PUBLIC_PAIR_TERMINAL_ENABLED", "PUBLIC_PAIR_SWITCH_CODE_ENABLED"];
  exact(config.vars, ["PAIR_ID", "PAIR_COMMIT_SHA", "PAIR_ENVIRONMENT", "PAIR_JOURNAL_NAMESPACE", "PAIR_EXECUTOR_READY",
    ...continuationEnabled ? continuationFlags : []]);
  if (continuationEnabled) {
    requireValue(config.vars.PAIR_EXECUTOR_READY === "true" && continuationFlags.every(key => config.vars[key] === "true"), "configuration-continuation");
    requireValue(Array.isArray(config.services) && config.services.length === 1, "configuration-proof-binding");
    exact(config.services[0], ["binding", "service", "entrypoint"]);
    requireValue(config.services[0].binding === "PUBLIC_RELEASE_INGRESS_PROOF" &&
      typeof config.services[0].service === "string" && /^njpbs-private-ingress-[a-z0-9-]{1,30}$/.test(config.services[0].service) &&
      config.services[0].entrypoint === "PublicReleaseIngressProofEntrypoint", "configuration-proof-binding");
  }
  requireValue(config.vars.PAIR_ID === `njpbs-pair-slot-${incarnation}:${incarnation}` && /^[a-f0-9]{40}$/.test(config.vars.PAIR_COMMIT_SHA));
  requireValue(["production", "development"].includes(config.vars.PAIR_ENVIRONMENT) && /^[A-Za-z0-9._:-]{1,128}$/.test(config.vars.PAIR_JOURNAL_NAMESPACE));
  requireValue(["false", "true"].includes(config.vars.PAIR_EXECUTOR_READY));
  same(config.version_metadata, { binding: "PAIR_WORKER_VERSION" }, "configuration-version-binding");
  same(config.durable_objects, { bindings: [{ name: "PAIR_PUBLISHER", class_name: CLASS }] }, "configuration-namespace");
  same(config.exports, { [CLASS]: { type: "durable-object", storage: "sqlite" } }, "configuration-exports");
  same(config.triggers, { crons: ["* * * * *"] }, "configuration-cron");
  requireValue(typeof imageReference === "string" && new RegExp(`^registry\\.cloudflare\\.com/${config.account_id}/[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[a-f0-9]{64}$`).test(imageReference));
  same(config.containers, [{ name: config.name, class_name: CLASS, image: imageReference, instance_type: "standard-2", max_instances: 1 }], "configuration-container");
  requireValue(Array.isArray(config.r2_buckets) && config.r2_buckets.length === 1);
  exact(config.r2_buckets[0], ["binding", "bucket_name"]);
  requireValue(config.r2_buckets[0].binding === "PAIR_CONTENT" && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.r2_buckets[0].bucket_name));
  requireValue(config.r2_buckets[0].bucket_name === targets.publicationTarget(config.vars.PAIR_ENVIRONMENT).publicationBucket, "configuration-bucket");
}

function expectedBindings(config) {
  return sortBindings([
    ...Object.entries(config.vars).map(([name, text]) => ({ name, type: "plain_text", text })),
    { name: SECRET, type: "inherit" },
    { name: "PAIR_CONTENT", type: "r2_bucket", bucket_name: config.r2_buckets[0].bucket_name },
    { name: "PAIR_WORKER_VERSION", type: "version_metadata" },
    { name: "PAIR_PUBLISHER", type: "durable_object_namespace", class_name: CLASS },
    ...(config.services ?? []).map(({ binding: name, service, entrypoint }) => ({ name, type: "service", service, entrypoint })),
  ]);
}

function validateMetadata(metadata, config) {
  const allowed = ["main_module", "bindings", "containers", "compatibility_date", "compatibility_flags", "exports", "keep_bindings", "annotations", "package_dependencies"];
  requireValue(object(metadata) && Object.keys(metadata).every(key => allowed.includes(key)), "unsupported-metadata");
  requireValue(typeof metadata.main_module === "string" && metadata.main_module.length > 0);
  same(sortBindings(metadata.bindings), expectedBindings(config), "prepared-bindings");
  same(metadata.containers, [{ name: config.name, class_name: CLASS }], "prepared-containers");
  same(metadata.exports, config.exports, "prepared-exports");
  same(metadata.compatibility_flags, config.compatibility_flags, "prepared-flags");
  requireValue(metadata.compatibility_date === config.compatibility_date);
  same(metadata.keep_bindings, ["secret_text", "secret_key"], "prepared-inheritance");
  if (metadata.annotations !== undefined) {
    requireValue(object(metadata.annotations) && Object.entries(metadata.annotations).every(([key, value]) => key.startsWith("workers/") && typeof value === "string" && value.length <= 1000));
  }
  if (metadata.package_dependencies !== undefined) requireValue(Array.isArray(metadata.package_dependencies));
}

/**
 * Parse the secret-free `wrangler versions upload --dry-run --outfile` output.
 * Returns frozen, JSON-safe seals. Original bytes are held privately in memory;
 * only this function can mint a prepared handle. No credentials or I/O.
 * @param {{multipart: Uint8Array, config: object, imageReference: string}} input
 */
export async function preparePrivatePairPublisher({ multipart, config, imageReference }) {
  validateConfiguration(config, imageReference);
  requireValue(multipart instanceof Uint8Array && multipart.byteLength > 0 && multipart.byteLength <= 64 * 1024 * 1024);
  const bytes = Buffer.from(multipart);
  const firstLineEnd = bytes.indexOf(10);
  requireValue(firstLineEnd > 2 && firstLineEnd < 256);
  const firstLine = bytes.subarray(0, firstLineEnd).toString("ascii").replace(/\r$/, "");
  requireValue(/^--[A-Za-z0-9_-]{1,200}$/.test(firstLine), "multipart-boundary");
  let form;
  try {
    form = await new Response(bytes, { headers: { "Content-Type": `multipart/form-data; boundary=${firstLine.slice(2)}` } }).formData();
  } catch { throw new PrivatePairProviderError("multipart-invalid"); }
  const names = [...form.keys()];
  requireValue(new Set(names).size === names.length && names.includes("metadata") && names.length <= 256, "multipart-parts");
  const rawMetadata = form.get("metadata");
  requireValue(typeof rawMetadata === "string" && rawMetadata.length < 1024 * 1024);
  let metadata;
  try { metadata = JSON.parse(rawMetadata); } catch { throw new PrivatePairProviderError("metadata-invalid"); }
  validateMetadata(metadata, config);
  const modules = [];
  for (const [name, part] of form) {
    if (name === "metadata") continue;
    requireValue(part instanceof Blob && /^[A-Za-z0-9_./-]+$/.test(name) && !name.split("/").includes(".."), "module-invalid");
    requireValue(["application/javascript+module", "application/wasm", "text/plain", "application/octet-stream", "application/source-map"].includes(part.type), "module-type");
    modules.push({ name, contentType: part.type, bytes: Buffer.from(await part.arrayBuffer()) });
  }
  modules.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  requireValue(modules.some(module => module.name === metadata.main_module && module.contentType === "application/javascript+module"), "main-module");
  const moduleManifest = modules.map(module => ({ name: module.name, contentType: module.contentType, size: module.bytes.length, sha256: createHash("sha256").update(module.bytes).digest("hex") }));
  const configuration = { accountId: config.account_id, applicationName: config.name, imageReference,
    metadata, workersDev: false, previewUrls: false, routes: [], instanceType: "standard-2", maxInstances: 1,
    ...config.services ? { schedules: config.triggers.crons.map(cron => ({ cron })) } : {} };
  const prepared = freeze({ accountId: config.account_id, applicationName: config.name, imageReference,
    executorReady: config.vars.PAIR_EXECUTOR_READY === "true",
    continuationEnabled: config.vars.PUBLIC_PAIR_ORIGINAL_RECOVERY_ENABLED === "true",
    bundleDigest: digest({ mainModule: metadata.main_module, modules: moduleManifest }), configurationDigest: digest(configuration), moduleManifest,
    pairIdentity: { pairId: config.vars.PAIR_ID, commitSha: config.vars.PAIR_COMMIT_SHA, environment: config.vars.PAIR_ENVIRONMENT, journalNamespace: config.vars.PAIR_JOURNAL_NAMESPACE } });
  preparedData.set(prepared, { config: structuredClone(config), metadata: structuredClone(metadata), modules });
  return prepared;
}

function privateSubdomain(value) {
  requireValue(object(value) && value.enabled === false && value.previews_enabled === false, "public-subdomain");
  return { enabled: false, previews_enabled: false };
}
function checkVersionId(value) { requireValue(typeof value === "string" && UUID.test(value), "version-id"); }
function checkNamespaceId(value) { requireValue(typeof value === "string" && NAMESPACE.test(value), "namespace-id"); }
function writeResult(condition) {
  if (!condition) throw new PrivatePairProviderError("mutation-readback-required", true);
}

function normalizedReadBindings(bindings, applicationName, requireNamespace) {
  let namespaceId = null;
  const normalized = sortBindings(bindings).map(binding => {
    if (binding.name === SECRET) {
      requireValue(binding.type === "secret_text", "version-secret-binding");
      return { name: SECRET, type: "inherit" };
    }
    if (binding.name === "PAIR_PUBLISHER") {
      requireValue(binding.type === "durable_object_namespace" && binding.class_name === CLASS &&
        (binding.script_name === undefined || binding.script_name === applicationName) && binding.environment === undefined, "version-namespace-binding");
      if (binding.namespace_id !== undefined) { checkNamespaceId(binding.namespace_id); namespaceId = binding.namespace_id; }
      requireValue(!requireNamespace || namespaceId !== null, "namespace-not-ready");
      const allowed = ["name", "type", "class_name", "script_name", "namespace_id"];
      requireValue(Object.keys(binding).every(key => allowed.includes(key)), "version-namespace-binding");
      return { name: binding.name, type: binding.type, class_name: binding.class_name };
    }
    if (binding.name === "PUBLIC_RELEASE_INGRESS_PROOF") {
      requireValue(binding.type === "service" && (binding.environment === undefined || binding.environment === "production"), "version-service-binding");
      const { environment: _providerDefault, ...stable } = binding;
      return stable;
    }
    return binding;
  });
  return { bindings: normalized, namespaceId };
}

function normalizedExports(exports, applicationName) {
  requireValue(object(exports) && object(exports[CLASS]), "version-exports");
  for (const [name, value] of Object.entries(exports)) {
    requireValue(object(value) && (value.state === undefined || value.state === "created"), "version-exports");
    if (name === CLASS) {
      requireValue(Object.keys(value).every(key => ["type", "storage", "state", "container"].includes(key)) &&
        value.type === "durable-object" && value.storage === "sqlite" &&
        (value.container === undefined || value.container === applicationName), "version-exports");
      continue;
    }
    requireValue(["default", "PairPublicationWake", "ContainerProxy"].includes(name) && value.type === "worker" &&
      Object.keys(value).every(key => ["type", "state", "cache"].includes(key)), "version-exports");
    if (value.cache !== undefined) same(value.cache, { enabled: false }, "version-cache");
  }
  return { [CLASS]: { type: "durable-object", storage: "sqlite" } };
}
function checkContainers(containers, applicationName) {
  requireValue(Array.isArray(containers) && containers.length === 1 && containers[0].class_name === CLASS &&
    (containers[0].name === undefined || containers[0].name === applicationName) &&
    Object.keys(containers[0]).every(key => ["name", "class_name"].includes(key)), "version-containers");
}

function readModuleManifest(modules) {
  return unique(modules, "name").map(module => {
    requireValue(typeof module.content_base64 === "string" && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(module.content_base64), "module-readback");
    const bytes = Buffer.from(module.content_base64, "base64");
    return { name: module.name, contentType: module.content_type, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/**
 * Controlled Cloudflare transport. All mutations make one fetch, with no retry
 * and redirects rejected. The caller owns durable permission and step receipts.
 * Merely constructing the provider performs no I/O. `readToken` and the optional
 * preflight caller are explicit credential/network boundaries.
 * @param {{prepared: object, fetchImpl: typeof fetch, readToken: () => Promise<string> | string,
 * preflightCaller?: (identity: object) => Promise<object>}} input
 */
export function createPrivatePairPublisherProvider({ prepared, fetchImpl, readToken, preflightCaller }) {
  const state = preparedData.get(prepared);
  requireValue(state && typeof fetchImpl === "function" && typeof readToken === "function", "provider-input");
  const { config, metadata, modules } = state;
  const account = `/accounts/${prepared.accountId}`;
  const worker = `${account}/workers/scripts/${prepared.applicationName}`;
  const resource = `${account}/workers/workers/${prepared.applicationName}`;
  let verifiedNamespace;
  let preparedTriggerVersion;

  async function request(path, method = "GET", body, allowNotFound = false) {
    let dispatched = false;
    try {
      const token = await readToken();
      requireValue(typeof token === "string" && token.length > 0 && !/[\r\n]/.test(token), "credential-unavailable");
      const headers = { Authorization: `Bearer ${token}` };
      if (body !== undefined && !(body instanceof FormData)) headers["Content-Type"] = "application/json";
      dispatched = true;
      const response = await fetchImpl(`${API}${path}`, { method, headers, body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(30_000) });
      if (method === "GET" && allowNotFound && response.status === 404) { await response.body?.cancel(); return null; }
      requireValue(response.ok && !response.redirected, "http-rejected");
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body ?? []) {
        size += chunk.byteLength;
        requireValue(size <= 96 * 1024 * 1024, "response-size");
        chunks.push(chunk);
      }
      const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requireValue(envelope.success === true && Object.hasOwn(envelope, "result") && (!envelope.errors || Array.isArray(envelope.errors) && envelope.errors.length === 0), "provider-envelope");
      return envelope;
    } catch {
      throw new PrivatePairProviderError("request-failed", dispatched && method !== "GET");
    }
  }

  // Zone/namespace counts prove completion. total_pages is optional in the
  // provider schema; when present it must agree with the complete counts.
  async function numberedList(path, resultKey) {
    const rows = [];
    let expectedTotal;
    for (let page = 1; page <= 1000; page++) {
      const separator = path.includes("?") ? "&" : "?";
      const envelope = await request(`${path}${separator}page=${page}&per_page=50`);
      const batch = resultKey ? envelope.result?.[resultKey] : envelope.result;
      const info = envelope.result_info;
      requireValue(Array.isArray(batch) && object(info) && info.page === page && info.count === batch.length &&
        Number.isSafeInteger(info.total_count) && info.total_count >= 0 &&
        (info.total_pages === undefined || info.total_pages === null || Number.isSafeInteger(info.total_pages) && info.total_pages >= 0), "pagination-incomplete");
      expectedTotal ??= info.total_count;
      requireValue(info.total_count === expectedTotal, "pagination-changed");
      rows.push(...batch);
      requireValue(rows.length <= expectedTotal, "pagination-incomplete");
      if (rows.length === expectedTotal) {
        requireValue(info.total_pages === undefined || info.total_pages === null || info.total_pages === page ||
          expectedTotal === 0 && info.total_pages === 0, "pagination-incomplete");
        return unique(rows, "id");
      }
      requireValue(batch.length > 0 && (info.total_pages === undefined || info.total_pages === null || page < info.total_pages), "pagination-incomplete");
    }
    throw new PrivatePairProviderError("pagination-limit");
  }

  async function singleList(path) {
    const envelope = await request(path);
    const rows = unique(envelope.result, "id");
    if (envelope.result_info !== undefined) {
      const info = envelope.result_info;
      requireValue(object(info) && info.total_count === rows.length && info.count === rows.length &&
        (info.total_pages === undefined || info.total_pages === null || info.total_pages === 1 || rows.length === 0 && info.total_pages === 0) &&
        (info.per_page === undefined || info.per_page === null || Number.isSafeInteger(info.per_page) && info.per_page >= rows.length) &&
        info.page === 1, "pagination-incomplete");
    }
    return rows;
  }

  async function applications() {
    const rows = [], seenTokens = new Set();
    let token;
    for (let page = 0; page < 1000; page++) {
      const envelope = await request(`${account}/containers/applications?per_page=100${token ? `&page_token=${encodeURIComponent(token)}` : ""}`);
      requireValue(Array.isArray(envelope.result) && object(envelope.result_info), "pagination-incomplete");
      const info = envelope.result_info;
      requireValue(info.page_token === undefined || info.page_token === token, "pagination-changed");
      rows.push(...envelope.result);
      if (info.next_page_token === undefined || info.next_page_token === null || info.next_page_token === "") return unique(rows, "id");
      requireValue(typeof info.next_page_token === "string" && !seenTokens.has(info.next_page_token), "pagination-incomplete");
      token = info.next_page_token;
      seenTokens.add(token);
    }
    throw new PrivatePairProviderError("pagination-limit");
  }

  async function readRoutingInventory() {
    const zones = await numberedList(`/zones?account.id=${prepared.accountId}`);
    const domains = await singleList(`${account}/workers/domains`);
    for (const domain of domains) requireValue(typeof domain.service === "string" && domain.service !== prepared.applicationName, "public-domain");
    let routeCount = 0;
    for (const zone of zones) {
      requireValue(HEX_ID.test(zone.id) && zone.account?.id === prepared.accountId, "zone-account");
      const routes = await singleList(`/zones/${zone.id}/workers/routes`);
      for (const route of routes) {
        requireValue(Object.hasOwn(route, "script") && (route.script === null || typeof route.script === "string") && route.script !== prepared.applicationName, "public-route");
      }
      routeCount += routes.length;
    }
    return { zoneIds: zones.map(zone => zone.id), domainCount: domains.length, routeCount };
  }

  async function readPrivateInventory() {
    const subdomain = privateSubdomain((await request(`${worker}/subdomain`)).result);
    return { publisherApplication: prepared.applicationName, subdomain, ...await readRoutingInventory(), private: true };
  }

  /** Full read before create; missing Worker is allowed only on HTTP 404. The
   * caller supplies retained resource names/IDs from its sealed ownership data. */
  async function readInitialInventory({ retainedApplications = [], retainedNamespaceIds = [] } = {}) {
    requireValue(Array.isArray(retainedApplications) && Array.isArray(retainedNamespaceIds), "retained-resources");
    requireValue(!retainedApplications.includes(prepared.applicationName), "retained-overlap");
    const identity = await readWorkerIdentity();
    const apps = await applications();
    const namespaceRows = await numberedList(`${account}/workers/durable_objects/namespaces`);
    for (const namespace of namespaceRows) requireValue(typeof namespace.class === "string" && typeof namespace.script === "string" && NAMESPACE.test(namespace.id), "namespace-inventory");
    const intendedApps = apps.filter(app => app.name === prepared.applicationName);
    const intendedNamespaces = namespaceRows.filter(namespace => namespace.script === prepared.applicationName && namespace.class === CLASS);
    requireValue(intendedApps.length <= 1 && intendedNamespaces.length <= 1, "inventory-ambiguous");
    for (const namespace of intendedNamespaces) {
      checkNamespaceId(namespace.id);
      requireValue(!retainedNamespaceIds.includes(namespace.id) && namespace.preview === undefined && namespace.dispatch_namespace === undefined && namespace.use_sqlite === true, "retained-overlap");
    }
    const appNamespace = intendedApps[0]?.durable_objects?.namespace_id;
    if (appNamespace !== undefined) requireValue(!retainedNamespaceIds.includes(appNamespace), "retained-overlap");
    if (intendedApps.length) {
      requireValue(intendedNamespaces.length === 1 && appNamespace === intendedNamespaces[0].id, "application-namespace");
      await readContainerApplication({ applicationId: intendedApps[0].id, namespaceId: appNamespace });
    }
    const routes = await readRoutingInventory();
    return { publisherApplication: prepared.applicationName, intendedWorkerExists: identity !== null,
      workerId: identity?.workerId ?? null, intendedContainerExists: intendedApps.length === 1,
      applicationId: intendedApps[0]?.id ?? null, namespaceId: intendedNamespaces[0]?.id ?? null, ...routes };
  }

  async function readWorkerIdentity({ requireUndeployed = false } = {}) {
    const envelope = await request(resource, "GET", undefined, true);
    if (envelope === null) return null;
    const result = envelope.result;
    requireValue(object(result) && typeof result.id === "string" && NAMESPACE.test(result.id) && result.name === prepared.applicationName, "worker-identity");
    const subdomain = privateSubdomain(result.subdomain);
    if (requireUndeployed) requireValue(result.deployed_on === null, "worker-already-deployed");
    return { workerId: result.id, publisherApplication: result.name, subdomain };
  }

  async function readVersion({ versionId, requireNamespace = false }) {
    checkVersionId(versionId);
    const detail = (await request(`${worker}/versions/${versionId}`)).result;
    const code = (await request(`${resource}/versions/${versionId}?include=modules`)).result;
    requireValue(detail?.id === versionId && code?.id === versionId, "version-identity");
    const runtime = detail.resources?.script_runtime;
    requireValue(object(runtime), "version-runtime");
    same(runtime.compatibility_date, metadata.compatibility_date, "version-date");
    same(runtime.compatibility_flags, metadata.compatibility_flags, "version-flags");
    same(normalizedExports(runtime.exports, prepared.applicationName), metadata.exports, "version-exports");
    // The scripts API reports declarative exports; the modules API reports
    // attached Container classes. It does not promise runtime.containers.
    if (runtime.containers !== undefined) checkContainers(runtime.containers, prepared.applicationName);
    checkContainers(code.containers, prepared.applicationName);
    requireValue(Array.isArray(code.urls) && code.urls.length === 0, "version-public-urls");
    const handlers = unique(detail.resources?.script?.named_handlers, "name");
    same(handlers.map(row => row.name).sort(), [CLASS, "PairPublicationWake", "ContainerProxy"].sort(), "version-handlers");
    const readBindings = normalizedReadBindings(detail.resources?.bindings, prepared.applicationName, requireNamespace);
    same(readBindings.bindings, sortBindings(metadata.bindings), "version-bindings");
    same(code.main_module, metadata.main_module, "version-main-module");
    same(readModuleManifest(code.modules), prepared.moduleManifest, "version-bytes");
    // Check the independent code endpoint's config too, so a wrong name or stale
    // endpoint cannot supply matching bytes while hiding a configuration change.
    same(code.compatibility_date, metadata.compatibility_date, "code-date");
    same(code.compatibility_flags, metadata.compatibility_flags, "code-flags");
    same(normalizedReadBindings(code.bindings, prepared.applicationName, requireNamespace).bindings, sortBindings(metadata.bindings), "code-bindings");
    same(normalizedExports(code.exports, prepared.applicationName), metadata.exports, "code-exports");
    const codeNamespace = normalizedReadBindings(code.bindings, prepared.applicationName, requireNamespace).namespaceId;
    requireValue(codeNamespace === readBindings.namespaceId, "code-namespace");
    if (metadata.package_dependencies !== undefined) same(code.package_dependencies, metadata.package_dependencies, "code-dependencies");
    for (const [key, value] of Object.entries(metadata.annotations ?? {})) requireValue(code.annotations?.[key] === value, "code-annotations");
    // The upload operation receipt stays stable after first deployment later
    // provisions its namespace. Namespace proof has its own explicit read.
    return { publisherApplication: prepared.applicationName, workerVersionId: versionId, namespaceId: requireNamespace ? readBindings.namespaceId : null,
      bundleDigest: prepared.bundleDigest, configurationDigest: prepared.configurationDigest, imageDigest: prepared.imageReference.split("@")[1] };
  }

  async function readNamespace({ versionId }) {
    const version = await readVersion({ versionId, requireNamespace: true });
    const namespaces = await numberedList(`${account}/workers/durable_objects/namespaces`);
    const candidates = namespaces.filter(namespace => namespace.class === CLASS && namespace.script === prepared.applicationName && namespace.preview === undefined && namespace.dispatch_namespace === undefined);
    requireValue(candidates.length === 1 && candidates[0].id === version.namespaceId && candidates[0].use_sqlite === true, "namespace-identity");
    verifiedNamespace = { namespaceId: version.namespaceId, workerVersionId: versionId };
    return { namespaceId: version.namespaceId, publisherApplication: prepared.applicationName, className: CLASS, storage: "sqlite" };
  }

  async function readDeployment({ versionId, deploymentId }) {
    checkVersionId(versionId);
    if (deploymentId !== undefined) checkVersionId(deploymentId);
    const result = (await request(`${worker}/deployments`)).result;
    requireValue(Array.isArray(result?.deployments) && result.deployments.length > 0, "deployment-missing");
    const current = result.deployments[0];
    checkVersionId(current.id);
    requireValue(deploymentId === undefined || current.id === deploymentId, "deployment-identity");
    same(current.versions, [{ version_id: versionId, percentage: 100 }], "deployment-traffic");
    requireValue(current.strategy === "percentage", "deployment-strategy");
    return { publisherApplication: prepared.applicationName, workerVersionId: versionId, deploymentId: current.id, trafficPercent: 100 };
  }

  async function readOriginalTrigger({ versionId }) {
    requireValue(prepared.continuationEnabled === true, "continuation-not-enabled");
    await readDeployment({ versionId });
    const result = (await request(`${worker}/schedules`)).result;
    exact(result, ["schedules"]);
    requireValue(Array.isArray(result.schedules), "trigger-readback");
    if (result.schedules.length === 0) return null;
    requireValue(result.schedules.length === 1, "trigger-readback");
    const row = result.schedules[0];
    requireValue(object(row) && row.cron === config.triggers.crons[0] &&
      Object.keys(row).every(key => ["cron", "created_on", "modified_on"].includes(key)) &&
      ["created_on", "modified_on"].every(key => row[key] === undefined || typeof row[key] === "string"), "trigger-readback");
    return { publisherApplication: prepared.applicationName, workerVersionId: versionId, schedules: [{ cron: row.cron }] };
  }

  async function readContainerApplication({ applicationId, namespaceId }) {
    checkNamespaceId(namespaceId);
    requireValue(typeof applicationId === "string" && NAMESPACE.test(applicationId), "application-id");
    const matches = (await applications()).filter(app => app.name === prepared.applicationName);
    if (matches.length === 0) throw new PrivatePairProviderError("application-readback-pending", true);
    requireValue(matches.length === 1 && matches[0].id === applicationId, "application-inventory");
    const result = (await request(`${account}/containers/applications/${applicationId}`)).result;
    requireValue(result?.id === applicationId && result.account_id === prepared.accountId && result.name === prepared.applicationName && result.scheduling_policy === "default", "application-identity");
    requireValue(result.configuration?.image === prepared.imageReference && result.configuration.instance_type === "standard-2" && result.max_instances === 1 && result.instances === 0 && result.durable_objects?.namespace_id === namespaceId, "application-configuration");
    for (const field of ["command", "entrypoint", "environment_variables", "authorized_keys", "trusted_user_ca_keys"]) {
      requireValue(result.configuration[field] === undefined || Array.isArray(result.configuration[field]) && result.configuration[field].length === 0, "application-overrides");
    }
    requireValue(result.configuration.wrangler_ssh === undefined || result.configuration.wrangler_ssh?.enabled === false, "application-ssh");
    requireValue(result.active_rollout_id === undefined || result.active_rollout_id === null, "application-rollout");
    return { publisherApplication: result.name, applicationId, namespaceId, imageReference: result.configuration.image, imageDigest: prepared.imageReference.split("@")[1], instanceType: "standard-2", maxInstances: 1 };
  }

  async function listVersions() {
    // This documented filter ignores pagination and returns every deployable
    // version. The scripts endpoint does not promise result_info metadata.
    const envelope = await request(`${worker}/versions?deployable=true`);
    const rows = unique(envelope.result?.items, "id");
    requireValue(rows.length <= 10_000, "version-inventory-limit");
    return rows.map(row => { checkVersionId(row.id); return { workerVersionId: row.id }; });
  }

  async function recoverVersion() {
    const versions = await listVersions();
    if (versions.length === 0) return null;
    const matching = [];
    for (const { workerVersionId } of versions) {
      try { matching.push(await readVersion({ versionId: workerVersionId })); }
      catch (error) {
        if (!(error instanceof PrivatePairProviderError) || error.code === "request-failed") throw error;
      }
    }
    requireValue(matching.length === 1, "version-recovery-ambiguous");
    return matching[0];
  }

  async function recoverContainer({ namespaceId, versionId, deploymentId }) {
    checkNamespaceId(namespaceId);
    versionId ??= verifiedNamespace?.workerVersionId;
    const namespace = await readNamespace({ versionId });
    requireValue(namespace.namespaceId === namespaceId, "namespace-identity");
    await readDeployment({ versionId, deploymentId });
    const matches = (await applications()).filter(app => app.name === prepared.applicationName);
    if (matches.length === 0) return null;
    requireValue(matches.length === 1, "application-inventory");
    const container = await readContainerApplication({ applicationId: matches[0].id, namespaceId });
    return container;
  }

  return Object.freeze({
    readInitialInventory, readPrivateInventory, readWorkerIdentity, readVersion, readNamespace, readDeployment, readContainerApplication, listVersions, recoverVersion, recoverContainer,
    readOriginalTrigger,
    async prepareOriginalTrigger({ versionId }) {
      requireValue(prepared.continuationEnabled === true, "continuation-not-enabled");
      await readVersion({ versionId });
      await readPrivateInventory();
      requireValue(await readOriginalTrigger({ versionId }) === null, "trigger-already-installed");
      preparedTriggerVersion = versionId;
    },
    async installOriginalTrigger({ versionId }) {
      checkVersionId(versionId);
      requireValue(prepared.continuationEnabled === true && preparedTriggerVersion === versionId, "trigger-preparation-required");
      // This method is called only after the durable grant. Its first network
      // request is the one allowed PUT; preparation failures cannot burn it.
      preparedTriggerVersion = undefined;
      const result = (await request(`${worker}/schedules`, "PUT", [{ cron: config.triggers.crons[0] }])).result;
      // The independent GET owns the actual trigger proof. A malformed PUT
      // reply is uncertain and cannot authorize another mutation.
      writeResult(Array.isArray(result?.schedules) && result.schedules.length === 1 && result.schedules[0]?.cron === config.triggers.crons[0]);
      return { publisherApplication: prepared.applicationName, workerVersionId: versionId };
    },
    async listContainerApplications() {
      return (await applications()).map(app => {
        requireValue(typeof app.name === "string", "application-name");
        return { applicationId: app.id, publisherApplication: app.name };
      });
    },
    async createWorkerIdentity() {
      const result = (await request(`${account}/workers/workers`, "POST", { name: prepared.applicationName, subdomain: { enabled: false, previews_enabled: false } })).result;
      writeResult(typeof result?.id === "string" && NAMESPACE.test(result.id) && result.name === prepared.applicationName);
      return { workerId: result.id, publisherApplication: result.name };
    },
    async setPrivateSubdomain() {
      const result = (await request(`${worker}/subdomain`, "POST", { enabled: false, previews_enabled: false })).result;
      writeResult(result?.enabled === false && result.previews_enabled === false);
      return { publisherApplication: prepared.applicationName, enabled: false, previews_enabled: false };
    },
    async uploadVersion({ readServiceAccount }) {
      requireValue(typeof readServiceAccount === "function", "secret-reader");
      let secret;
      try { secret = await readServiceAccount(); } catch { throw new PrivatePairProviderError("secret-unavailable"); }
      requireValue(typeof secret === "string" && secret.length > 0, "secret-unavailable");
      const uploadMetadata = structuredClone(metadata);
      uploadMetadata.bindings = uploadMetadata.bindings.map(binding => binding.name === SECRET ? { name: SECRET, type: "secret_text", text: secret } : binding);
      const form = new FormData();
      form.set("metadata", JSON.stringify(uploadMetadata));
      for (const module of modules) form.set(module.name, new Blob([module.bytes], { type: module.contentType }), module.name);
      const result = (await request(`${worker}/versions?bindings_inherit=strict`, "POST", form)).result;
      writeResult(typeof result?.id === "string" && UUID.test(result.id));
      return { workerVersionId: result.id, publisherApplication: prepared.applicationName };
    },
    async deployVersion({ versionId }) {
      checkVersionId(versionId);
      const result = (await request(`${worker}/deployments`, "POST", { strategy: "percentage", versions: [{ version_id: versionId, percentage: 100 }] })).result;
      writeResult(typeof result?.id === "string" && UUID.test(result.id));
      return { deploymentId: result.id, workerVersionId: versionId, publisherApplication: prepared.applicationName };
    },
    async createContainerApplication({ namespaceId }) {
      checkNamespaceId(namespaceId);
      requireValue(verifiedNamespace?.namespaceId === namespaceId, "namespace-readback-required");
      // Standard/default applications store image and size here. The managed
      // durable_object variant has a different API and is deliberately absent.
      // Omit Wrangler's undocumented constraints.tiers; no placement is imposed.
      const result = (await request(`${account}/containers/applications`, "POST", {
        name: prepared.applicationName, scheduling_policy: "default", configuration: { image: prepared.imageReference, instance_type: "standard-2" },
        instances: 0, max_instances: 1, durable_objects: { namespace_id: namespaceId }, rollout_active_grace_period: 0,
      })).result;
      writeResult(typeof result?.id === "string" && NAMESPACE.test(result.id));
      return { applicationId: result.id, publisherApplication: prepared.applicationName, namespaceId };
    },
    async preflight({ identity }) {
      requireValue(typeof preflightCaller === "function", "private-preflight-unbound");
      same(identity, { pairId: config.vars.PAIR_ID, commitSha: config.vars.PAIR_COMMIT_SHA, environment: config.vars.PAIR_ENVIRONMENT, journalNamespace: config.vars.PAIR_JOURNAL_NAMESPACE }, "preflight-identity");
      let result;
      try { result = await preflightCaller(structuredClone(identity)); } catch (error) {
        if (error instanceof PrivatePairProviderError) throw error;
        throw new PrivatePairProviderError("private-preflight-failed", true);
      }
      requireValue(result?.ready === true && result.pairId === identity.pairId && result.commitSha === identity.commitSha && result.journalNamespace === identity.journalNamespace, "private-preflight-not-ready");
      return { ready: true, pairId: result.pairId, commitSha: result.commitSha, journalNamespace: result.journalNamespace };
    },
  });
}
