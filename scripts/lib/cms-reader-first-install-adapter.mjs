import p from "../../functions/lib/public-release-pair.js";
import cms from "../../functions/lib/cms-preview-pair.js";
import { readFirstInstallReaderState, deriveFirstInstallReaderRequest, assertFirstInstallReaderSources } from "./cms-reader-first-install-cases.mjs";
import { prepareInstalledCmsReaderConsumers, FIRST_INSTALL_STAGE, CONVERTED_STAGE } from "./cms-reader-bridge-install.mjs";

const refuse = () => { throw new Error("CMS reader install adapter unavailable"); };
export function parseReaderInstallAdapterConfig(raw) {
  p.exact(raw, ["schemaVersion", "projectId", "readerOperationId", "sourceBodyDigest", "candidates", "accountId", "consumerStage", "bridgeOperationId"]);
  p.exact(raw.candidates, ["functions", "cmsApi"]);
  if (raw.schemaVersion !== 1 || !["njpbs-site", "njpbs-site-dev"].includes(raw.projectId) || !p.digest(raw.sourceBodyDigest) ||
      !/^[a-f0-9]{32}$/.test(raw.accountId ?? "") || ![FIRST_INSTALL_STAGE, CONVERTED_STAGE].includes(raw.consumerStage) ||
      [raw.readerOperationId, raw.bridgeOperationId].some(value => !/^reader-[a-z0-9][a-z0-9-]{0,63}$/.test(value ?? ""))) refuse();
  for (const component of ["functions", "cmsApi"]) if (!new RegExp(`^${component}-[0-9]{1,20}-[0-9]{1,4}$`).test(raw.candidates[component] ?? "")) refuse();
  return p.freeze(structuredClone(raw));
}

export async function createReaderInstallAdapter({ firestore, config: raw, readProviders, readStaffToken, readEdgeSecret, signal }) {
  const config = parseReaderInstallAdapterConfig(raw);
  if (firestore?.projectId !== config.projectId || [readProviders, readStaffToken, readEdgeSecret].some(value => typeof value !== "function")) refuse();
  signal?.throwIfAborted();
  const observe = transaction => readFirstInstallReaderState({ firestore, config, ...(transaction ? { transaction } : {}) });
  const stage = value => value.root.schemaVersion === 1 ? FIRST_INSTALL_STAGE : CONVERTED_STAGE;
  const before = await observe();
  const candidates = {};
  for (const component of ["functions", "cmsApi"]) {
    const row = (await firestore.doc(`cmsDeploymentCandidates/${config.candidates[component]}`).get()).data();
    if (row?.schemaVersion !== 2 || row.state !== "verified" || row.component !== component) refuse();
    const mutation = row.mutation;
    candidates[component] = { component, ...Object.fromEntries(["sourceSha", "trustedWorkflowSha", "runId", "runAttempt", "inputFingerprint", "configurationFingerprint"]
      .map(key => [key, mutation[key]])) };
  }
  const current = () => { signal?.throwIfAborted(); if (firestore.projectId !== config.projectId) refuse(); };
  const assertState = async ({ transaction, request }, allowPausedBootstrap = false) => {
    current();
    const observed = await observe(transaction);
    if (cms.digest(observed.state) !== request.expectedStateDigest ||
        (request.stage === FIRST_INSTALL_STAGE) !== (stage(observed) === FIRST_INSTALL_STAGE)) refuse();
    return assertFirstInstallReaderSources({ firestore, config, transaction, observed, allowPausedBootstrap });
  };
  const development = config.projectId === "njpbs-site-dev";
  const targets = { functions: Object.fromEntries([1, 2].map(version => [version,
    `https://us-central1-${config.projectId}.cloudfunctions.net/cmsReaderV${version}`])),
    cmsApi: Object.fromEntries([1, 2].map(version => [version,
      `${development ? "https://dev-api.example.org" : "https://api.example.org"}/api/cms/v${version}/reader`])) };
  return Object.freeze({ targets, candidates, readProviders, readStaffToken, readEdgeSecret,
    readLiveState: async () => { current(); return (await observe()).state; },
    assertStateInTransaction: input => assertState(input),
    async prepareRequest({ operationId, stage: requestedStage }) {
      current(); return deriveFirstInstallReaderRequest({ firestore, config, operationId, stage: requestedStage, signal });
    },
    async readRetainedCases(request) {
      current();
      const original = await deriveFirstInstallReaderRequest({ firestore, config, operationId: request.operationId, stage: request.stage, signal });
      return original.stage === FIRST_INSTALL_STAGE ? { cases: original.cases, refusals: original.refusals } : original.cases;
    },
    async prepareInstalledConsumers({ request }) {
      current();
      const observed = await observe();
      if (stage(observed) !== config.consumerStage || request.oldPairId !== observed.seal.previewPairs[0].pairId ||
          request.newPairId !== observed.seal.previewPairs[1].pairId) refuse();
      if (config.consumerStage === FIRST_INSTALL_STAGE) {
        const runtime = (await firestore.doc(cms.SELECTOR_PATH).get()).data();
        if (cms.digest(runtime) !== request.expectedRuntimeDigest || runtime.phase !== "paused") refuse();
      }
      return prepareInstalledCmsReaderConsumers({ firestore, operationId: config.bridgeOperationId, readProviders,
        stage: config.consumerStage, signal, assertStateInTransaction: input => assertState(input, config.consumerStage === FIRST_INSTALL_STAGE) });
    },
    // Read-only provenance for tools which bind the returned adapter to its
    // verified bundle. Neither descriptor nor provider result grants install.
    initialStateDigest: cms.digest(before.state),
  });
}
