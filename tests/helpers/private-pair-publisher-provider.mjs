import assert from "node:assert/strict";
import { preparePrivatePairPublisher, createPrivatePairPublisherProvider } from "../../scripts/lib/private-pair-publisher-provider.mjs";

// HTTP fixtures follow the Cloudflare API response contracts cited in the task's
// provider protocol report. Module source is a fixed input, never golden output
// copied from the adapter. Only the network and credential boundaries are faked.
const accountId = "a".repeat(32);
const incarnation = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const otherVersion = "33333333-3333-4333-8333-333333333333";
const deploymentId = "44444444-4444-4444-8444-444444444444";
const namespaceId = "b".repeat(32);
const applicationId = "55555555-5555-4555-8555-555555555555";
// Worker.create documents a hex Worker ID; version/deployment IDs are UUIDs.
const workerId = "6".repeat(32);
const applicationName = `njpbs-pair-publisher-${incarnation}`;
const imageReference = `registry.cloudflare.com/${accountId}/pair@sha256:${"d".repeat(64)}`;
const identity = { pairId: `njpbs-pair-slot-${incarnation}:${incarnation}`, commitSha: "e".repeat(40), environment: "development", journalNamespace: "pair-journal" };
const source = "export default { fetch() { return new Response(null, {status:404}); } };\n";
const moduleName = "pair-worker.js";

function configuration() {
  return { name: applicationName, main: "/source/publisher/pair-worker.ts", account_id: accountId, compatibility_date: "2026-10-28", compatibility_flags: ["nodejs_compat"],
    workers_dev: false, preview_urls: false, routes: [], secrets: { required: ["FIREBASE_SERVICE_ACCOUNT"] },
    vars: { PAIR_ID: identity.pairId, PAIR_COMMIT_SHA: identity.commitSha, PAIR_ENVIRONMENT: identity.environment, PAIR_JOURNAL_NAMESPACE: identity.journalNamespace, PAIR_EXECUTOR_READY: "false" },
    r2_buckets: [{ binding: "PAIR_CONTENT", bucket_name: "njpbs-dev-cms-publication" }], version_metadata: { binding: "PAIR_WORKER_VERSION" },
    containers: [{ name: applicationName, class_name: "PairPublicationRuntime", image: imageReference, instance_type: "standard-2", max_instances: 1 }],
    durable_objects: { bindings: [{ name: "PAIR_PUBLISHER", class_name: "PairPublicationRuntime" }] },
    exports: { PairPublicationRuntime: { type: "durable-object", storage: "sqlite" } }, triggers: { crons: ["* * * * *"] } };
}

function metadata(config = configuration()) {
  return { main_module: moduleName, bindings: [
    ...Object.entries(config.vars).map(([name, text]) => ({ name, type: "plain_text", text })),
    { name: "FIREBASE_SERVICE_ACCOUNT", type: "inherit" },
    { name: "PAIR_CONTENT", type: "r2_bucket", bucket_name: "njpbs-dev-cms-publication" },
    { name: "PAIR_WORKER_VERSION", type: "version_metadata" },
    { name: "PAIR_PUBLISHER", type: "durable_object_namespace", class_name: "PairPublicationRuntime" },
    ...(config.services ?? []).map(({ binding: name, service, entrypoint }) => ({ name, type: "service", service, entrypoint })),
  ], containers: [{ name: applicationName, class_name: "PairPublicationRuntime" }], exports: structuredClone(config.exports),
  compatibility_date: config.compatibility_date, compatibility_flags: config.compatibility_flags, keep_bindings: ["secret_text", "secret_key"] };
}

async function multipart(meta = metadata(), text = source, reverse = false) {
  const form = new FormData();
  if (!reverse) form.set("metadata", JSON.stringify(meta));
  form.set(moduleName, new Blob([text], { type: "application/javascript+module" }), moduleName);
  if (reverse) form.set("metadata", JSON.stringify(meta));
  return new Uint8Array(await new Response(form).arrayBuffer());
}
async function prepare(meta = metadata(), config = configuration()) {
  return preparePrivatePairPublisher({ multipart: await multipart(meta), config, imageReference });
}
function envelope(result, result_info) {
  return Response.json({ success: true, errors: [], result, ...result_info === undefined ? {} : { result_info } });
}
function page(rows, number = 1, total = rows.length, totalPages = 1) {
  return envelope(rows, { page: number, count: rows.length, total_count: total, total_pages: totalPages, per_page: 50 });
}
function bindings() {
  return metadata().bindings.map(binding => {
    if (binding.type === "inherit") return { name: binding.name, type: "secret_text" };
    if (binding.type === "durable_object_namespace") return { ...binding, namespace_id: namespaceId };
    return binding;
  });
}
function version(id = versionId) {
  const meta = metadata();
  return { id, resources: { script: { named_handlers: [{ name: "PairPublicationRuntime" }, { name: "PairPublicationWake" }, { name: "ContainerProxy" }] }, bindings: bindings(), script_runtime: { compatibility_date: meta.compatibility_date,
    compatibility_flags: meta.compatibility_flags, exports: { ...meta.exports, PairPublicationWake: { type: "worker", state: "created" }, ContainerProxy: { type: "worker", state: "created" }, default: { type: "worker", state: "created" } } } } };
}
function versionCode(id = versionId) {
  const meta = metadata();
  return { id, urls: [], containers: [{ class_name: "PairPublicationRuntime" }], main_module: moduleName, compatibility_date: meta.compatibility_date, compatibility_flags: meta.compatibility_flags, exports: meta.exports,
    bindings: bindings(), modules: [{ name: moduleName, content_type: "application/javascript+module", content_base64: Buffer.from(source).toString("base64") }] };
}
function container() {
  return { id: applicationId, account_id: accountId, name: applicationName, scheduling_policy: "default",
    configuration: { image: imageReference, instance_type: "standard-2" }, instances: 0, max_instances: 1, durable_objects: { namespace_id: namespaceId } };
}
function deployment() {
  return { id: deploymentId, strategy: "percentage", versions: [{ version_id: versionId, percentage: 100 }] };
}

function network(overrides = {}, { accountId: targetAccount = accountId } = {}) {
  const requests = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://api.cloudflare.com");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    requests.push({ url, method: init.method, body: init.body });
    const suffix = url.pathname.replace(`/client/v4/accounts/${targetAccount}`, "").replace("/client/v4", "");
    const override = overrides[`${init.method} ${suffix}`];
    if (override) return override(url, init);
    if (suffix === `/workers/workers/${applicationName}`) return envelope({ id: workerId, name: applicationName, subdomain: { enabled: false, previews_enabled: false }, deployed_on: null });
    if (suffix.endsWith("/subdomain")) return envelope({ enabled: false, previews_enabled: false });
    if (suffix === `/workers/scripts/${applicationName}/versions`) {
      assert.equal(url.searchParams.get("deployable"), "true");
      return envelope({ items: [] });
    }
    if (suffix.startsWith(`/workers/scripts/${applicationName}/versions/`)) return envelope(version(suffix.split("/").at(-1)));
    if (suffix.startsWith(`/workers/workers/${applicationName}/versions/`)) return envelope(versionCode(suffix.split("/").at(-1)));
    if (suffix.endsWith("/deployments")) return envelope({ deployments: [deployment()] });
    if (suffix === "/workers/durable_objects/namespaces") return page([{ id: namespaceId, class: "PairPublicationRuntime", script: applicationName, use_sqlite: true }]);
    if (suffix === "/containers/applications") return envelope([container()], {});
    if (suffix === `/containers/applications/${applicationId}`) return envelope(container());
    if (suffix === "/workers/domains") return envelope([{ id: "domain-old", service: "old-private-worker", hostname: "example.test" }], { count: 1, page: 1, total_count: 1 });
    if (suffix === "/zones") {
      assert.equal(url.searchParams.get("account.id"), targetAccount);
      return page([{ id: "1".repeat(32), account: { id: targetAccount } }, { id: "2".repeat(32), account: { id: targetAccount } }]);
    }
    if (/^\/zones\/[12]{32}\/workers\/routes$/.test(suffix)) return envelope([{ id: `route-${suffix[7]}`, script: "old-worker", pattern: "example.test/*" }]);
    throw new Error("Unexpected fixture network request");
  };
  return { fetchImpl, requests };
}
async function provider(overrides = {}, options = {}) {
  const net = network(overrides);
  const prepared = await prepare();
  return { ...net, prepared, api: createPrivatePairPublisherProvider({ prepared, fetchImpl: net.fetchImpl, readToken: () => "synthetic-token", ...options }) };
}

export { accountId, incarnation, versionId, otherVersion, deploymentId, namespaceId, applicationId, workerId, applicationName, imageReference, identity, source, moduleName, configuration, metadata, multipart, prepare, envelope, page, bindings, version, versionCode, container, deployment, network, provider };
