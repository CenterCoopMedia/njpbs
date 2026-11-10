import { createHash } from "node:crypto";
import { releasePair } from "./private-public-release-pair.js";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import { configurePublicReleaseSlot } from "../../scripts/configure-public-release-ingress.mjs";
import { privateWorkerMetadata } from "../../scripts/lib/public-release-private-provider.mjs";
import { PAIR_READER_CONTRACT, privatePairReaderCapabilities } from "../../packages/content-core/src/private-pair-http.mjs";

export const slotAccount = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const publicDeploymentId = "cccccccc-3333-4333-8333-333333333333";
export const slotActions = ["create", "upload", "private-subdomain", "deploy"];
const sourceHash = bytes => createHash("sha256").update(bytes).digest("hex");
export function publicSlotScenario(source = new TextEncoder().encode("export default {fetch(){return new Response(null,{status:404})}}")) {
  const templates = ["a", "b"].map(slot => {
    const pair = releasePair(slot);
    pair.readerContractDigest = protocol.publicReleaseDigest(PAIR_READER_CONTRACT);
    pair.capabilityDigest = protocol.publicReleaseDigest(privatePairReaderCapabilities(pair.commitSha));
    return pair;
  });
  const installPlan = { schemaVersion: 1, operationId: "original-slot-install", accountId: slotAccount,
    ingressName: "njpbs-private-ingress-fixture", oldPair: templates[0], newPair: templates[1], slotEnabled: [false, false],
    readerOrigins: ["https://reader-old.example.test", "https://reader-new.example.test"],
    readerAccess: [0, 1].map(() => ({ enabled: false, audience: "", clientId: "" })),
    slotBundleDigest: sourceHash(source), ingressBundleDigest: "e".repeat(64) };
  const pair = structuredClone(templates[0]);
  pair.publicWorker.versionId = "dddddddd-2222-4222-8222-222222222222";
  const deployment = { schemaVersion: 1, environment: pair.environment, service: pair.publicWorker.service,
    versionId: pair.publicWorker.versionId, commitSha: pair.commitSha, origin: installPlan.readerOrigins[0], contractDigest: pair.readerContractDigest };
  pair.readerReceiptDigest = protocol.publicReleaseDigest(deployment);
  const config = configurePublicReleaseSlot({ pair: templates[0], accountId: slotAccount,
    readerOrigin: deployment.origin, readerAccess: installPlan.readerAccess[0] });
  const { main: _path, ...portableConfig } = config;
  const planDigest = protocol.publicReleaseDigest({ config: portableConfig, sourceDigest: sourceHash(source) });
  const tag = protocol.publicReleaseDigest({ attemptId: installPlan.operationId, planDigest });
  const metadata = privateWorkerMetadata(config, tag);
  const rollout = { publisherApplication: pair.publisher.application, publisherWorkerVersionId: pair.publisher.workerVersionId,
    imageDigest: pair.publisher.imageDigest, publicService: pair.publicWorker.service, publicWorkerVersionId: pair.publicWorker.versionId,
    publisherDeploymentId: "eeeeeeee-3333-4333-8333-333333333333", publicDeploymentId,
    publisherTrafficPercent: 100, publicTrafficPercent: 100 };
  const worker = { name: config.name, id: "1".repeat(32), tags: [`private-pair:${tag}`], subdomain: { enabled: false, previews_enabled: false } };
  const version = { id: pair.publicWorker.versionId, annotations: metadata.annotations,
    resources: { bindings: metadata.bindings, script_runtime: { compatibility_date: metadata.compatibility_date, compatibility_flags: metadata.compatibility_flags } } };
  const active = { id: publicDeploymentId, annotations: metadata.annotations, versions: [{ version_id: pair.publicWorker.versionId, percentage: 100 }] };
  const calls = [];
  const state = { worker, versions: [{ id: pair.publicWorker.versionId, annotations: metadata.annotations }], version,
    deployment: active, source, domains: [], zones: [{ id: "2".repeat(32) }], routes: [], subdomain: { enabled: false, previews_enabled: false } };
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method ?? "GET" });
    if ((init.method ?? "GET") !== "GET" || init.headers.authorization !== "Bearer synthetic-slot-api") throw new Error("Unexpected provider mutation or credential");
    const route = path.endsWith(`/workers/workers/${config.name}`) ? "worker"
      : path.endsWith("/content/v2") ? "source" : path.endsWith("/versions") ? "versions"
      : path.endsWith(`/versions/${pair.publicWorker.versionId}`) ? "version" : path.endsWith("/deployments") ? "deployment"
      : path.endsWith("/subdomain") ? "subdomain" : path.endsWith("/domains") ? "domains"
      : path === "/client/v4/zones" ? "zones" : path.endsWith("/workers/routes") ? "routes" : null;
    if (!route) throw new Error("Unexpected provider route");
    if (route === "source") return new Response(state.source, { headers: { "content-type": "application/javascript" } });
    const value = structuredClone(state[route]);
    return Response.json({ success: true, result: route === "versions" ? { items: value } : route === "deployment" ? [value] : value });
  };
  const seal = { schemaVersion: 1, attemptId: installPlan.operationId, worker: config.name, planDigest };
  const receipts = { create: { workerId: worker.id, name: config.name, tag }, upload: { versionId: pair.publicWorker.versionId },
    "private-subdomain": { private: true }, deploy: { deploymentId: publicDeploymentId, versionId: pair.publicWorker.versionId } };
  const base = work.publicReleasePairPath(pair.pairId), namespace = "system/publicReleasePrivateInstalls";
  const workerKey = protocol.publicReleaseDigest({ worker: config.name });
  const records = {
    [work.PAIRS]: { schemaVersion: 2, pairIds: [pair.pairId] }, [base]: pair,
    [`${base}/controls/runtime`]: { schemaVersion: 2, pairId: pair.pairId, status: "candidate" },
    [`${base}/rollouts/publisher`]: { schemaVersion: 2, pairId: pair.pairId, pairDigest: protocol.publicReleaseDigest(pair), state: "verified", readbackDigest: protocol.publicReleaseDigest(rollout) },
    [`${namespace}/plans/${installPlan.operationId}`]: { schemaVersion: 1, attemptId: installPlan.operationId, planDigest: protocol.publicReleaseDigest(installPlan) },
    [`${namespace}/workers/${workerKey}`]: seal,
  };
  for (const action of slotActions) {
    records[`${namespace}/attempts/${installPlan.operationId}/steps/${workerKey}-${action}`] = { ...seal, action };
    records[`${namespace}/attempts/${installPlan.operationId}/readbacks/${workerKey}-${action}`] = { ...seal, action, result: receipts[action] };
  }
  return { source, pair, installPlan, rollout, config, metadata, tag, state, calls, fetchImpl, records, base,
    readToken: async () => "synthetic-slot-api" };
}
