"use strict";
const pairs = require("./cms-preview-pair");
const { readerIdentities } = require("./cms-versioned-reader");
const { parseInstalledCmsReaderProof } = require("./cms-reader-bridge-proof");
const SUPPORT = Object.freeze({ previewRequest: [1], postChrome: [1], settings: [1], capabilities: [1], adminSession: [1, 2] });
const refuse = () => { throw new Error("CMS reader mount unavailable"); };
function mountConfiguration(environment) {
  const operationId = environment.CMS_READER_BRIDGE_OPERATION_ID;
  if (environment.CMS_READER_BRIDGE_ENABLED !== "true" || !/^reader-[a-z0-9][a-z0-9-]{0,63}$/.test(operationId ?? "")) refuse();
  const candidates = { functions: environment.CMS_READER_BRIDGE_FUNCTIONS_CANDIDATE,
    cmsApi: environment.CMS_READER_BRIDGE_CMS_API_CANDIDATE };
  for (const component of ["functions", "cmsApi"]) {
    if (!new RegExp(`^${component}-[0-9]{1,20}-[0-9]{1,4}$`).test(candidates[component] ?? "")) refuse();
  }
  return { operationId, candidates };
}

/** Existing authority only. Before the first installed proof, both original
 * verified candidates must match COMPLETE legacy deployment receipts. Later
 * global deployments cannot replace the original proof's retained descriptors.
 */
async function readCmsReaderMountDescriptor({ firestore, environment = process.env, transaction: supplied }) {
  const config = mountConfiguration(environment);
  const inspect = async transaction => {
    const proof = (await transaction.get(firestore.doc(`cmsReaderBridgeInstalledProofs/${config.operationId}`))).data();
    let readers;
    if (proof) {
      // This is immutable reader identity readback, not a converted serving or
      // switch guard. Those consumers retain the strict default Stage B parser.
      parseInstalledCmsReaderProof(proof, config.operationId, { stage: proof.proof?.stage ?? "public-converted" });
      readers = proof.proof.readers;
    } else {
      const components = ["functions", "cmsApi"];
      const rows = await transaction.getAll(...components.flatMap(component => [
        firestore.doc(`cmsDeploymentReceipts/${component}`), firestore.doc(`cmsDeploymentCandidates/${config.candidates[component]}`),
      ]));
      readers = Object.fromEntries(components.map((component, index) => {
        const legacy = rows[index * 2].data(), candidate = rows[index * 2 + 1].data();
        const mutation = candidate?.mutation;
        if (legacy?.schemaVersion !== 1 || legacy.component !== component || legacy.state !== "complete" ||
            candidate?.schemaVersion !== 2 || candidate.component !== component || candidate.state !== "verified" ||
            `${component}-${mutation?.runId}-${mutation?.runAttempt}` !== config.candidates[component] ||
            ["sourceSha", "inputFingerprint", "configurationFingerprint", "providerIdentities"]
              .some(key => pairs.digest(legacy.mutation?.[key] ?? null) !== pairs.digest(mutation?.[key] ?? null))) refuse();
        return [component, pairs.parseReader({ schemaVersion: 2, component, sourceSha: mutation.sourceSha,
          inputFingerprint: mutation.inputFingerprint, configurationFingerprint: mutation.configurationFingerprint,
          providerIdentities: mutation.providerIdentities, verifiedAt: mutation.completedAt, supported: SUPPORT })];
      }));
    }
    const identities = readerIdentities(readers);
    return { operationId: config.operationId, readers, identities };
  };
  if (supplied) return inspect(supplied);
  const read = firestore.runTransaction(inspect, { readOnly: true });
  let timer;
  try {
    return await Promise.race([read, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("CMS reader descriptor timed out")), 3000);
    })]);
  } finally { clearTimeout(timer); }
}
module.exports = { mountConfiguration, readCmsReaderMountDescriptor };
