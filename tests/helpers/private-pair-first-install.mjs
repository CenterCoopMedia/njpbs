import { createHash, randomUUID } from "node:crypto";
import { expect } from "vitest";
import * as fixture from "./private-pair-publisher-provider.mjs";
import { configurePublicReleasePairPublisher } from "../../scripts/configure-public-release-pair-publisher.mjs";
import { preparePrivatePairPublisher } from "../../scripts/lib/private-pair-publisher-provider.mjs";
import { cloudflarePrivatePairProvider } from "../../scripts/lib/public-release-private-provider.mjs";
import { releasePair } from "./private-public-release-pair.js";
import { sealedPair } from "./sealed-public-release-pair";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const hex = value => createHash("md5").update(value).digest("hex");
export const slotSource = new TextEncoder().encode("export default {fetch(){return new Response(null,{status:404})}} // slot");
export const ingressSource = new TextEncoder().encode("export default {fetch(){return new Response(null,{status:404})}} // ingress");
export const compile = async main => main.includes("-slot-") ? slotSource : ingressSource;

/** Stateful HTTP-only seam. UUIDs are assigned independently by these provider
 * responses, never copied from the requested pair or from either other Worker. */
export async function firstInstallScenario({ continuationEnabled = false } = {}) {
  const workers = new Map(), publishers = new Map(), effects = [];
  const faults = { losePublisherUpload: false, pendingPublisherUpload: false, loseSlotUpload: false, wrongSlotConfig: false };
  const origins = ["https://old-reader.example.test", "https://new-reader.example.test"];
  const bases = [sealedPair(origins[0]).pair, sealedPair(origins[1], releasePair("b", "b".repeat(40))).pair];
  const intents = [];
  for (const base of bases) {
    const publisher = base.publisher;
    const pairTemplate = { ...base, publicWorker: { ...base.publicWorker }, publisher: { ...publisher } };
    delete pairTemplate.readerReceiptDigest; delete pairTemplate.publicWorker.versionId; delete pairTemplate.publisher.workerVersionId;
    const imageReference = `registry.cloudflare.com/${fixture.accountId}/pair@${publisher.imageDigest}`;
    const config = configurePublicReleasePairPublisher({ pair: base, retainedPairs: [], imageReference,
      ...continuationEnabled ? { executorReady: true, continuationEnabled: true, ingressProofService: 'njpbs-private-ingress-development' } : {},
      legacyConfig: { name: "njpbs-dev-cms-publisher", account_id: fixture.accountId, compatibility_date: "2026-10-28",
        vars: { CMS_DEPLOYMENT_ENVIRONMENT: "development" }, r2_buckets: [{ bucket_name: "njpbs-dev-cms-publication" }] } });
    const metadata = fixture.metadata(config);
    metadata.containers = [{ name: config.name, class_name: "PairPublicationRuntime" }];
    const prepared = await preparePrivatePairPublisher({ multipart: await fixture.multipart(metadata), config, imageReference });
    const plan = { schemaVersion: 3, kind: "private-pair-publisher-upload", pairTemplate,
      accountId: fixture.accountId, imageReference, bundleDigest: prepared.bundleDigest, configurationDigest: prepared.configurationDigest,
      slotInstall: { operationId: "first-private-pair", readerOrigin: origins[intents.length] } };
    const row = { name: publisher.application, config, metadata, imageReference, worker: false, uploaded: false,
      versionId: randomUUID(), deploymentId: randomUUID(), applicationId: randomUUID(), namespaceId: hex(publisher.application), workerId: hex(base.pairId) };
    publishers.set(row.name, row);
    intents.push({ plan, prepared });
  }
  const page = rows => fixture.page(rows, 1, rows.length, rows.length ? 1 : 0);
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input), method = init.method ?? "GET";
    expect(url.origin).toBe("https://api.cloudflare.com");
    const path = url.pathname.replace(`/client/v4/accounts/${fixture.accountId}`, "").replace("/client/v4", "");
    if (method !== "GET") effects.push({ method, path });
    if (path === "/zones") return page([]);
    if (path === "/workers/domains") return fixture.envelope([]);
    if (path === "/containers/applications") {
      if (method === "GET") return fixture.envelope([...publishers.values()].filter(row => row.container).map(container), {});
      const body = JSON.parse(init.body), row = publishers.get(body.name);
      expect(body.durable_objects.namespace_id).toBe(row.namespaceId);
      row.container = true; return fixture.envelope({ id: row.applicationId });
    }
    if (path.startsWith("/containers/applications/")) return fixture.envelope(container([...publishers.values()].find(row => row.applicationId === path.split("/").at(-1))));
    if (path === "/workers/durable_objects/namespaces") return page([...publishers.values()].filter(row => row.deployed)
      .map(row => ({ id: row.namespaceId, class: "PairPublicationRuntime", script: row.name, use_sqlite: true })));
    if (path === "/workers/workers" && method === "POST") {
      const body = JSON.parse(init.body), publisher = publishers.get(body.name);
      if (publisher) { publisher.worker = true; return fixture.envelope({ id: publisher.workerId, name: publisher.name }); }
      workers.set(body.name, { id: hex(body.name), ...body }); return fixture.envelope(workers.get(body.name));
    }
    const match = /^\/workers\/(workers|scripts)\/([^/]+)(.*)$/.exec(path);
    if (!match) throw new Error(`Unexpected closed fixture path ${path}`);
    const [, api, name, tail] = match;
    const publisher = publishers.get(name), row = publisher ?? workers.get(name);
    if (!row || publisher && !publisher.worker) return Response.json({ success: false }, { status: 404 });
    if (!tail) return fixture.envelope(publisher ? { id: publisher.workerId, name, subdomain: { enabled: false, previews_enabled: false },
      deployed_on: publisher.deployed ? "2026-10-31T00:00:00Z" : null } : row);
    if (tail === "/schedules" && publisher) {
      if (method === "PUT") { expect(JSON.parse(init.body)).toEqual([{ cron: "* * * * *" }]); row.trigger = true; }
      return fixture.envelope({ schedules: row.trigger ? [{ cron: "* * * * *" }] : [] });
    }
    if (tail === "/subdomain") return fixture.envelope({ enabled: false, previews_enabled: false });
    if (tail === "/versions" && method === "POST") {
      if (publisher) {
        if (!faults.pendingPublisherUpload) publisher.uploaded = true;
        if (faults.losePublisherUpload || faults.pendingPublisherUpload) { faults.losePublisherUpload = false; throw new Error("Lost original upload response"); }
        return fixture.envelope({ id: publisher.versionId });
      }
      expect(row.versionId).toBeUndefined(); row.versionId = randomUUID();
      row.metadata = JSON.parse(await init.body.get("metadata").text()); row.source = new Uint8Array(await init.body.get("index.mjs").arrayBuffer());
      if (faults.loseSlotUpload) { faults.loseSlotUpload = false; throw new Error("Lost original slot response"); }
      return fixture.envelope({ id: row.versionId });
    }
    if (tail === "/versions") return fixture.envelope({ items: (publisher ? row.uploaded : row.versionId)
      ? [{ id: row.versionId, ...publisher ? {} : { annotations: row.metadata.annotations } }] : [] }, { page: 1,
        count: (publisher ? row.uploaded : row.versionId) ? 1 : 0, total_count: (publisher ? row.uploaded : row.versionId) ? 1 : 0,
        total_pages: (publisher ? row.uploaded : row.versionId) ? 1 : 0 });
    if (tail.startsWith("/versions/")) {
      expect(tail.split("/").at(-1)).toBe(row.versionId);
      if (!publisher) {
        const bindings = structuredClone(row.metadata.bindings);
        if (faults.wrongSlotConfig) bindings.pop();
        return fixture.envelope({ id: row.versionId, annotations: row.metadata.annotations, resources: { bindings,
          script_runtime: { compatibility_date: row.metadata.compatibility_date, compatibility_flags: row.metadata.compatibility_flags } } });
      }
      const bindings = row.metadata.bindings.map(binding => binding.type === "inherit" ? { name: binding.name, type: "secret_text" }
        : binding.type === "durable_object_namespace" ? { ...binding, ...row.deployed ? { namespace_id: row.namespaceId } : {} } : binding);
      if (api === "scripts") return fixture.envelope({ ...fixture.version(), id: row.versionId,
        resources: { ...fixture.version().resources, bindings, script_runtime: { ...fixture.version().resources.script_runtime,
          compatibility_date: row.config.compatibility_date, compatibility_flags: row.config.compatibility_flags } } });
      return fixture.envelope({ ...fixture.versionCode(), id: row.versionId, bindings, compatibility_date: row.config.compatibility_date });
    }
    if (tail === "/deployments") {
      if (method === "POST") {
        const body = JSON.parse(init.body); expect(body.versions[0].version_id).toBe(row.versionId);
        if (publisher) publisher.deployed = true;
        else row.deployment = { id: randomUUID(), versions: body.versions, annotations: body.annotations };
        return fixture.envelope(publisher ? { id: row.deploymentId } : row.deployment);
      }
      return fixture.envelope({ deployments: publisher ? row.deployed ? [{ id: row.deploymentId, strategy: "percentage",
        versions: [{ version_id: row.versionId, percentage: 100 }] }] : [] : row.deployment ? [row.deployment] : [] });
    }
    if (tail === "/content/v2" && !publisher) return new Response(row.source, { headers: { "content-type": "application/javascript" } });
    throw new Error(`Unexpected closed fixture operation ${method} ${path}`);
  };
  function container(row) { return { id: row.applicationId, account_id: fixture.accountId, name: row.name,
    scheduling_policy: "default", configuration: { image: row.imageReference, instance_type: "standard-2" }, instances: 0,
    max_instances: 1, durable_objects: { namespace_id: row.namespaceId } }; }
  const readToken = async () => "synthetic-provider-token";
  const slotPlan = () => ({ schemaVersion: 2, operationId: "first-private-pair", accountId: fixture.accountId,
    ingressName: "njpbs-private-ingress-development", oldPair: template(0), newPair: template(1), slotEnabled: [true, true],
    readerOrigins: origins, readerAccess: origins.map(() => ({ enabled: true, audience: "a".repeat(64), clientId: "reader123.access" })),
    slotBundleDigest: hash(slotSource), ingressBundleDigest: hash(ingressSource), developmentIngress: true });
  function template(index) {
    const intent = intents[index];
    return { ...intent.plan.pairTemplate, publisher: { ...intent.plan.pairTemplate.publisher,
      workerVersionId: publishers.get(intent.prepared.applicationName).versionId } };
  }
  return { intents, workers, publishers, effects, faults, fetchImpl, readToken, slotPlan,
    // Keep the real transport's emulator mutation prohibition intact. Native
    // slot effects use a closed provider seam; its GET verifier stays real.
    provider: { ...cloudflarePrivatePairProvider({ accountId: fixture.accountId, credential: readToken, fetcher: fetchImpl }),
      create: (name, tag) => fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${fixture.accountId}/workers/workers`, {
        method: "POST", body: JSON.stringify({ name, tags: [`private-pair:${tag}`], subdomain: { enabled: false, previews_enabled: false } }) }),
      async upload(name, metadata, source) {
        const body = new FormData(); body.set("metadata", new Blob([JSON.stringify(metadata)])); body.set("index.mjs", new Blob([source]));
        const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${fixture.accountId}/workers/scripts/${name}/versions`, { method: "POST", body });
        return (await response.json()).result.id;
      },
      disableSubdomain: name => fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${fixture.accountId}/workers/scripts/${name}/subdomain`, { method: "POST" }),
      deploy: (name, versionId, tag) => fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${fixture.accountId}/workers/scripts/${name}/deployments`, {
        method: "POST", body: JSON.stringify({ versions: [{ version_id: versionId, percentage: 100 }], annotations: { "workers/message": `private-pair:${tag}` } }) }),
    },
    publisherInput: (db, index) => ({ ...intents[index], firestore: db, authorized: true, readToken,
      readServiceAccount: async () => "synthetic-service-account", fetchImpl,
      preflightCaller: async identity => ({ ...identity, ready: true }) }) };
}
