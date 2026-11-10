import protocol from "../../functions/lib/public-release-pair.js";
import { operatorRefused as refuse } from "./public-release-operator-io.mjs";
const hash = protocol.publicReleaseDigest, same = (a, b) => hash(a) === hash(b);
const uuid = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value ?? "");
export const INGRESS_RATE_CONTROLS = "system/publicReleaseIngressRateControls";
/** Fixed read contract for the separately reviewed evidence owner (#4431).
 * record-public-release-rate-controls.mjs creates originals from installed
 * observations; this reader accepts no caller-supplied acceptance flag. */
export function oldIngressRateControlTarget({ packet, attempt, original, config, oldTarget }) {
  const binding = oldTarget.config.services.find(row => row.binding === "CMS_API");
  if (binding?.service !== "njpbs-cms-api" || binding.entrypoint !== "PublicContentEntrypoint" ||
      !same(original.services.find(row => row.binding === "CMS_API"), binding)) refuse();
  const { main: _main, ...portable } = config;
  return protocol.freeze({ environment: "production", operatorCommitSha: packet.operatorCommitSha,
    pairsDigest: hash([attempt.currentPair, attempt.recoveryPair]),
    ingress: { service: original.name, sourceDigest: packet.installPlan.ingressBundleDigest,
      originalVersionId: packet.originalIngressVersionId, originalDeploymentId: packet.originalIngressDeploymentId,
      configurationDigest: hash(portable) },
    cmsRpc: { service: binding.service, entrypoint: binding.entrypoint, method: "getReleaseDecision" } });
}
export async function readReviewedIngressRateControls({ firestore, target, signal }) {
  signal?.throwIfAborted();
  const key = hash(target), read = firestore.runTransaction(async tx => {
    const rows = await tx.getAll(...["viewer", "cmsRpc"].map(role => firestore.doc(`${INGRESS_RATE_CONTROLS}/${role}/${key}`)));
    signal?.throwIfAborted();
    const records = rows.map((row, index) => {
      const receipt = row.data();
      protocol.exact(receipt, ["schemaVersion", "kind", "target", "implementationCommitSha", "reviewDigest", "policyDigest",
        "configurationDigest", "observationsDigest", "providerVersionId", "providerDeploymentId"]);
      if (receipt.schemaVersion !== 1 || receipt.kind !== ["public-release-viewer-rate-control", "public-release-cms-rpc-rate-control"][index] ||
          !same(receipt.target, target) || receipt.implementationCommitSha !== target.operatorCommitSha ||
          ["reviewDigest", "policyDigest", "configurationDigest", "observationsDigest"].some(field => !protocol.digest(receipt[field])) ||
          !uuid(receipt.providerVersionId) || !uuid(receipt.providerDeploymentId)) refuse();
      if (index === 0 && (receipt.providerVersionId !== target.ingress.originalVersionId ||
          receipt.providerDeploymentId !== target.ingress.originalDeploymentId || receipt.configurationDigest !== target.ingress.configurationDigest)) refuse();
      return receipt;
    });
    return protocol.freeze({ target, records, digest: hash(records) });
  });
  if (!signal) return read;
  let abort;
  try { return await Promise.race([read, new Promise((_, reject) => { abort = () => reject(new Error("Rate-control evidence deadline"));
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true }); })]); }
  finally { if (abort) signal.removeEventListener("abort", abort); }
}
/** A receipt for another or no-longer-deployed CMS RPC is not enable authority.
 * The source-pinned owner and full review cover limiter semantics; this adapter checks its exact
 * reviewed witness against the actual immutable provider version/configuration. */
export async function assertReviewedCmsRpcRateControl({ evidence, api }) {
  const { target, records } = evidence, receipt = records[1];
  const path = `/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID ?? ""}/workers/scripts/${target.cmsRpc.service}`;
  const readDeployment = async () => {
    const response = await api(`${path}/deployments`), rows = response?.deployments ?? response;
    if (!Array.isArray(rows) || rows[0]?.id !== receipt.providerDeploymentId ||
        !same(rows[0]?.versions, [{ version_id: receipt.providerVersionId, percentage: 100 }])) refuse();
    return rows[0];
  };
  const before = await readDeployment(), version = await api(`${path}/versions/${receipt.providerVersionId}`);
  if (version?.id !== receipt.providerVersionId || !Array.isArray(version.resources?.bindings) || !version.resources?.script_runtime) refuse();
  const bindings = version.resources.bindings.map(binding => {
    const value = { ...binding }; if (value.type === "service" && value.environment === "production") delete value.environment; return value;
  }).sort((a, b) => a.name.localeCompare(b.name, "en"));
  const configuration = { bindings, compatibility_date: version.resources.script_runtime.compatibility_date,
    compatibility_flags: version.resources.script_runtime.compatibility_flags };
  if (hash(configuration) !== receipt.configurationDigest || !same(await readDeployment(), before)) refuse();
}
