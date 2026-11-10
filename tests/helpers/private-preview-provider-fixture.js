import { preparePrivatePreviewPair, privatePreviewPairConfiguration } from "../../scripts/lib/private-preview-pair-provider.mjs";
import { pair } from "./cms-preview-pairs.js";
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
export const versionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", deploymentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const namespaceId = "d".repeat(32), applicationId = "e".repeat(32), workerId = "f".repeat(32);
export async function previewProviderFixture(overrides = {}) {
  const { pair: suppliedPair = pair("new", "b"), ...configuration } = overrides;
  const { workerVersion, ...descriptor } = suppliedPair; void workerVersion;
  const image = `registry.cloudflare.com/${account}/preview@${descriptor.imageDigest}`;
  const config = privatePreviewPairConfiguration(descriptor, { main: "/checkout/preview-renderer/worker.ts", image, rendererReady: true, ...configuration });
  const source = "export class PreviewRenderer{}; export default class {preflight(){return {ready:false}}}";
  const metadata = { main_module: "index.mjs", compatibility_date: config.compatibility_date, compatibility_flags: config.compatibility_flags,
    bindings: [...Object.entries(config.vars).map(([name, text]) => ({ name, type: "plain_text", text })),
      ...config.secrets.required.map(name => ({ name, type: "inherit" })), { name: "PREVIEW_WORKER_VERSION", type: "version_metadata" },
      { name: "RENDERER", type: "durable_object_namespace", class_name: "PreviewRenderer" }],
    exports: config.exports, containers: [{ name: config.name, class_name: "PreviewRenderer" }], keep_bindings: ["secret_text", "secret_key"] };
  let multipart = new Uint8Array();
  const prepare = async (value = metadata, suppliedConfig = config) => {
    const form = new FormData(); form.set("metadata", JSON.stringify(value)); form.set("index.mjs", new Blob([source], { type: "application/javascript+module" }), "index.mjs");
    multipart = new Uint8Array(await new Response(form).arrayBuffer());
    return preparePrivatePreviewPair({ pair: descriptor, config: suppliedConfig, image, multipart });
  };
  const prepared = await prepare();
  const state = { identity: false, version: false, deployed: false, container: false, schedules: false,
    writes: /** @type {string[]} */ ([]), requests: /** @type {{path: string, method: string}[]} */ ([]),
    beforeWrite: async () => {}, failAction: /** @type {string|null} */ (null), lostAction: /** @type {string|null} */ (null),
    healthLost: false, healthReady: true, corrupt: /** @type {string|null} */ (null), tags: /** @type {string[]} */ ([]), domains: [] };
  const ok = (result, info) => Response.json({ success: true, result, ...(info === undefined ? {} : { result_info: info }) });
  const withNamespace = () => metadata.bindings.map(b => b.type === "inherit" ? { name: b.name, type: "secret_text" }
    : b.name === "RENDERER" && state.deployed ? { ...b, namespace_id: namespaceId, script_name: config.name } : b);
  const detail = () => ({ id: versionId, resources: { bindings: withNamespace(), script_runtime: {
    compatibility_date: config.compatibility_date, compatibility_flags: config.compatibility_flags, exports: config.exports },
    script: { named_handlers: [{ name: "PreviewRenderer" }] } } });
  const code = () => ({ id: versionId, main_module: metadata.main_module, compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags, bindings: withNamespace(), exports: config.exports, containers: metadata.containers, urls: [],
    modules: [{ name: "index.mjs", content_type: "application/javascript+module", content_base64: Buffer.from(state.corrupt === "bytes" ? "changed" : source).toString("base64") }] });
  const app = () => ({ id: applicationId, account_id: prepared.accountId, name: config.name, scheduling_policy: "default", instances: 0, max_instances: 1,
    durable_objects: { namespace_id: namespaceId }, configuration: { image: state.corrupt === "image" ? image + "changed" : image, instance_type: "standard-2" } });
  const effect = async (action, run) => {
    state.writes.push(action); await state.beforeWrite(action);
    if (state.failAction === action) throw new Error("synthetic private boundary");
    run(); if (state.lostAction === action) throw new Error("synthetic lost reply"); return ok({});
  };
  const request = async (url, init = {}) => {
    const u = new URL(url), p = u.pathname, method = init.method ?? "GET";
    state.requests.push({ path: p, method });
    if (u.hostname.endsWith(".workers.dev")) {
      if (state.healthLost) throw new Error("synthetic lost health reply");
      return Response.json({ ready: state.healthReady, pairId: descriptor.pairId, rendererSha: descriptor.rendererSha,
        serializerId: descriptor.serializerId, workerVersion: versionId });
    }
    if (init.redirect !== "error") throw new Error("redirect mode missing");
    if (p.endsWith("/workers/subdomain/edge-preview")) return ok({ token: "synthetic-session" });
    if (p.endsWith("/edge-preview")) return ok({ preview_token: "synthetic-preview" });
    if (p.endsWith("/workers/subdomain")) return ok({ subdomain: "synthetic-account" });
    if (method === "POST" && p.endsWith("/workers/workers")) return effect("identity", () => { state.identity = true; state.tags = JSON.parse(init.body).tags; });
    if (method === "POST" && p.endsWith("/versions")) {
      const form = init.body; const uploaded = JSON.parse(form.get("metadata"));
      if (uploaded.bindings.filter(b => b.type === "secret_text").length !== config.secrets.required.length) throw new Error("missing actual secret bindings");
      await effect("version", () => { state.version = true; }); return ok({ id: versionId });
    }
    if (method === "POST" && p.endsWith("/deployments")) return effect("deployment", () => { state.deployed = true; });
    if (method === "POST" && p.endsWith("/containers/applications")) return effect("container", () => { state.container = true; });
    if (method === "PUT" && p.endsWith("/schedules")) return effect("schedule", () => { state.schedules = true; });
    if (p.endsWith(`/workers/workers/${config.name}`)) return state.identity ? ok({ id: workerId, name: config.name, tags: state.tags, subdomain: { enabled: false, previews_enabled: false } }) : new Response(null, { status: 404 });
    if (p.endsWith(`/versions/${versionId}`)) return ok(p.includes("/workers/workers/") ? code() : detail());
    if (p.endsWith("/versions")) return ok({ items: state.version ? [{ id: versionId }] : [] });
    if (p.endsWith("/deployments")) return ok({ deployments: state.deployed ? [{ id: deploymentId, strategy: "percentage", versions: [{ version_id: versionId, percentage: 100 }] }] : [] });
    if (p.endsWith("/subdomain")) return ok({ enabled: false, previews_enabled: false });
    if (p.endsWith("/workers/domains")) return ok(state.domains);
    if (p.endsWith("/zones")) return ok([], { page: 1, count: 0, total_count: 0 });
    if (p.endsWith("/durable_objects/namespaces")) return ok(state.deployed ? [{ id: namespaceId, script: config.name, class: "PreviewRenderer", use_sqlite: true }] : [],
      { page: 1, count: state.deployed ? 1 : 0, total_count: state.deployed ? 1 : 0 });
    if (p.endsWith("/containers/applications")) return ok(state.container ? [app()] : [], {});
    if (p.endsWith(`/containers/applications/${applicationId}`)) return ok(app());
    if (p.endsWith("/schedules")) return ok({ schedules: state.schedules ? [{ cron: "* * * * *" }] : [] });
    throw new Error("Unexpected synthetic provider endpoint");
  };
  return { prepared, prepare, descriptor, config, image, metadata, multipart, state, request };
}
