import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import { compilePrivateWorker } from "../install-private-public-release.mjs";
import { privateWorkerMetadata, cloudflarePrivatePairProvider } from "./public-release-private-provider.mjs";
import { privatePublicReleaseSlotTarget } from "./private-public-release-slot-target.mjs";
import { oldIngressConfiguration } from "./public-release-old-ingress-operator.mjs";
import { oldIngressRateControlTarget, INGRESS_RATE_CONTROLS } from "./public-release-old-ingress-rate-control.mjs";
import { operatorCloudflareApi } from "./public-release-private-bridge-operator.mjs";
import { operatorRefused as refuse } from "./public-release-operator-io.mjs";
import { readRateControlFullReview } from "./public-release-rate-review.mjs";
import { prepareCmsRateControlBundle, rateControlModuleManifest } from "./public-release-rate-control-bundle.mjs";
const hash = protocol.publicReleaseDigest, same = (a, b) => hash(a) === hash(b);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const account = (process.env.CLOUDFLARE_ACCOUNT_ID ?? "");
const uuid = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value ?? "");
let preparedCms;
export function ingressRateEvidenceConfiguration(raw) {
  protocol.exact(raw, ["schemaVersion", "kind", "operatorCommitSha", "reviewBaseCommitSha", "oldIngressPacket"]);
  if (raw.schemaVersion !== 1 || raw.kind !== "public-release-rate-control-evidence" ||
      !/^[a-f0-9]{40}$/.test(raw.operatorCommitSha ?? "") || !/^[a-f0-9]{40}$/.test(raw.reviewBaseCommitSha ?? "") ||
      raw.oldIngressPacket?.operatorCommitSha !== raw.operatorCommitSha || raw.oldIngressPacket.enableOldIngress !== true) refuse();
  const parsed = oldIngressConfiguration(raw.oldIngressPacket);
  const oldTarget = privatePublicReleaseSlotTarget({ pair: parsed.attempt.currentPair, installPlan: parsed.packet.installPlan });
  return { ...parsed, request: protocol.freeze(structuredClone(raw)),
    rateTarget: oldIngressRateControlTarget({ ...parsed, oldTarget }) };
}
async function originalInstall(firestore, packet, original) {
  const { main: _main, ...portable } = original, namespace = "system/publicReleasePrivateInstalls", key = hash({ worker: original.name });
  const seal = { schemaVersion: 1, attemptId: packet.installPlan.operationId, worker: original.name,
    planDigest: hash({ config: portable, sourceDigest: packet.installPlan.ingressBundleDigest }) };
  const actions = ["create", "upload", "private-subdomain", "deploy"];
  return firestore.runTransaction(async tx => {
    const [plan, owner, ...rows] = (await tx.getAll(firestore.doc(`${namespace}/plans/${seal.attemptId}`), firestore.doc(`${namespace}/workers/${key}`),
      ...actions.flatMap(action => [firestore.doc(`${namespace}/attempts/${seal.attemptId}/steps/${key}-${action}`),
        firestore.doc(`${namespace}/attempts/${seal.attemptId}/readbacks/${key}-${action}`)]))).map(row => row.data());
    if (!same(plan, { schemaVersion: 1, attemptId: seal.attemptId, planDigest: hash(packet.installPlan) }) || !same(owner, seal)) refuse();
    for (const [index, action] of actions.entries()) {
      if (!same(rows[index * 2], { ...seal, action }) || !same({ ...rows[index * 2 + 1], result: null }, { ...seal, action, result: null })) refuse();
    }
    const results = actions.map((_, index) => rows[index * 2 + 1].result);
    if (results[0]?.name !== original.name || !/^[a-f0-9]{32}$/.test(results[0].workerId ?? "") ||
        results[0].tag !== hash({ attemptId: seal.attemptId, planDigest: seal.planDigest }) ||
        !same(results[1], { versionId: packet.originalIngressVersionId }) || !same(results[2], { private: true }) ||
        !same(results[3], { versionId: packet.originalIngressVersionId, deploymentId: packet.originalIngressDeploymentId })) refuse();
    return { seal, results };
  });
}
async function moduleVersion(service, versionId, readToken, fetchImpl, signal) {
  signal?.throwIfAborted(); const token = await readToken(); signal?.throwIfAborted();
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/workers/${service}/versions/${versionId}?include=modules`, {
    method: "GET", redirect: "error", signal, headers: { authorization: `Bearer ${token}` },
  });
  const reader = response.body?.getReader(); if (!reader) refuse();
  let size = 0; const chunks = [];
  try { while (true) { const row = await reader.read(); if (row.done) break;
    size += row.value.length; if (size > 4 * 1024 * 1024) refuse(); chunks.push(row.value);
  } } finally { await reader.cancel().catch(() => {}); }
  if (!response.ok) refuse();
  const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (envelope.success !== true || envelope.result?.id !== versionId) refuse();
  return envelope.result;
}
/** Build/observe/record only. No provider mutation, route, producer or selector
 * effect exists here. Default plan performs no credential/SDK/provider access. */
export async function produceIngressRateControls({ firestore, packet: raw, readToken, fetchImpl = fetch, signal, apply = false, host }) {
  try {
    const { request, packet, attempt, original, config, rateTarget: target } = ingressRateEvidenceConfiguration(raw);
    if (!apply) return { mode: "plan", target, targetDigest: hash(target), providerWrites: 0, receiptsWritten: 0 };
    if (apply !== true) refuse(); signal?.throwIfAborted(); work.assertPublicReleasePairDatabase(firestore, attempt.currentPair);
    const reviewDigest = await readRateControlFullReview(request, host), before = await originalInstall(firestore, packet, original);
    const source = await compilePrivateWorker(original.main);
    if (sha(source) !== target.ingress.sourceDigest) refuse();
    // Each call already proved a clean exact checkout. Reuse only that exact
    // source's offline bundle during one process; every provider read is fresh.
    if (preparedCms?.commit !== request.operatorCommitSha) preparedCms = { commit: request.operatorCommitSha, value: prepareCmsRateControlBundle() };
    const expectedCms = await preparedCms.value;
    const policy = JSON.parse(await readFile(new URL("../../packages/content-core/src/public-release-rate-policy.json", import.meta.url), "utf8"));
    const api = operatorCloudflareApi({ readToken, fetchImpl, signal });
    const provider = cloudflarePrivatePairProvider({ accountId: account, credential: readToken, fetcher: fetchImpl });
    const script = name => `/accounts/${account}/workers/scripts/${name}`;
    const deployment = async (name, expectedVersion, expectedDeployment) => {
      const result = await api(`${script(name)}/deployments`), current = (result.deployments ?? result)[0];
      if (!uuid(current?.id) || !Array.isArray(current.versions) || current.versions.length !== 1 || current.versions[0].percentage !== 100 ||
          !uuid(current.versions[0].version_id) || expectedVersion && current.versions[0].version_id !== expectedVersion ||
          expectedDeployment && current.id !== expectedDeployment) refuse();
      return current;
    };
    const ingressDeployment = await deployment(original.name, target.ingress.originalVersionId, target.ingress.originalDeploymentId);
    const cmsDeployment = await deployment(target.cmsRpc.service);
    const ingressVersion = await provider.version(original.name, target.ingress.originalVersionId, signal);
    const expectedIngress = privateWorkerMetadata(original, before.results[0].tag);
    const normalized = version => ({ bindings: version.resources?.bindings?.map(binding => {
      const value = { ...binding }; if (value.type === "service" && value.environment === "production") delete value.environment; return value;
    }).sort((a, b) => a.name.localeCompare(b.name, "en")), compatibility_date: version.resources?.script_runtime?.compatibility_date,
    compatibility_flags: version.resources?.script_runtime?.compatibility_flags });
    if (ingressVersion.id !== target.ingress.originalVersionId || !same(normalized(ingressVersion), { bindings: expectedIngress.bindings,
      compatibility_date: expectedIngress.compatibility_date, compatibility_flags: expectedIngress.compatibility_flags }) ||
      await provider.sourceDigest(original.name, signal) !== target.ingress.sourceDigest) refuse();
    const exposure = await provider.subdomain(original.name, signal);
    if (exposure.enabled !== false || exposure.previews_enabled !== false) refuse();
    await provider.assertNoPublicRoutes(original.name, signal);
    const cmsVersionId = cmsDeployment.versions[0].version_id, cmsVersion = await api(`${script(target.cmsRpc.service)}/versions/${cmsVersionId}`);
    if (cmsVersion.id !== cmsVersionId) refuse();
    const cmsConfiguration = normalized(cmsVersion), bindings = cmsConfiguration.bindings;
    if (!same({ compatibility_date: cmsConfiguration.compatibility_date, compatibility_flags: cmsConfiguration.compatibility_flags }, expectedCms.runtime) ||
        !Array.isArray(bindings) || new Set(bindings.map(row => row.name)).size !== bindings.length) refuse();
    for (const [name, text] of Object.entries({ PUBLIC_RELEASE_RATE_CONTROLS_ENABLED: "true", PUBLIC_RELEASE_READERS_ENABLED: "true",
      FIREBASE_PROJECT_ID: "njpbs-site", FUNCTIONS_ORIGIN: "https://us-central1-njpbs-site.cloudfunctions.net" })) {
      if (!same(bindings.find(row => row.name === name), { name, type: "plain_text", text })) refuse();
    }
    const limiter = bindings.find(row => row.name === "RATE_LIMITERS"), namespaces = await api(`/accounts/${account}/workers/durable_objects/namespaces?per_page=100`);
    if (limiter?.type !== "durable_object_namespace" || limiter.class_name !== "CmsRateLimiter" ||
        !(/^[a-f0-9]{32}$/.test(limiter.namespace_id ?? "") || uuid(limiter.namespace_id)) ||
        !Array.isArray(namespaces) || namespaces.filter(row => row.id === limiter.namespace_id && row.class === "CmsRateLimiter" &&
          row.script === target.cmsRpc.service && row.use_sqlite === true && row.preview === undefined && row.dispatch_namespace === undefined).length !== 1) refuse();
    const code = await moduleVersion(target.cmsRpc.service, cmsVersionId, readToken, fetchImpl, signal);
    if (!same({ mainModule: code.main_module, modules: rateControlModuleManifest(code.modules) }, expectedCms.bundle)) refuse();
    if (!same(await deployment(original.name), ingressDeployment) || !same(await deployment(target.cmsRpc.service), cmsDeployment) ||
        !same(await originalInstall(firestore, packet, original), before) || await readRateControlFullReview(request, host) !== reviewDigest) refuse();
    const observation = { originalIngressConfigurationDigest: hash(normalized(ingressVersion)), enabledIngressConfigurationDigest: target.ingress.configurationDigest,
      ingressSourceDigest: target.ingress.sourceDigest, cmsBundleDigest: hash(expectedCms.bundle), cmsConfigurationDigest: hash(cmsConfiguration),
      namespaceId: limiter.namespace_id, ingressDeployment, cmsDeployment };
    const records = ["viewer", "cmsRpc"].map((role, index) => ({ schemaVersion: 1,
      kind: index ? "public-release-cms-rpc-rate-control" : "public-release-viewer-rate-control", target,
      implementationCommitSha: request.operatorCommitSha, reviewDigest, policyDigest: hash(policy), observationsDigest: hash(observation),
      configurationDigest: index ? hash(cmsConfiguration) : target.ingress.configurationDigest,
      providerVersionId: index ? cmsVersionId : target.ingress.originalVersionId,
      providerDeploymentId: index ? cmsDeployment.id : target.ingress.originalDeploymentId }));
    signal?.throwIfAborted();
    await firestore.runTransaction(async tx => {
      const refs = ["viewer", "cmsRpc"].map(role => firestore.doc(`${INGRESS_RATE_CONTROLS}/${role}/${hash(target)}`));
      const existing = await tx.getAll(...refs); signal?.throwIfAborted();
      for (const [index, row] of existing.entries()) if (row.exists && !same(row.data(), records[index])) refuse();
      for (const [index, row] of existing.entries()) if (!row.exists) tx.create(refs[index], records[index]);
    });
    return { mode: "recorded", targetDigest: hash(target), evidenceDigest: hash(records), providerWrites: 0 };
  } catch { refuse(); }
}
