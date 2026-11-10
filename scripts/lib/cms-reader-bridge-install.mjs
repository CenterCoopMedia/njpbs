import { createHash } from "node:crypto";
import previewPair from "../../functions/lib/cms-preview-pair.js";
import readerSession from "../../functions/lib/cms-reader-session.js";
import readerProof from "../../functions/lib/cms-reader-bridge-proof.js";
import protocol from "../../functions/lib/public-release-pair.js";
import pairCodeGrammar from "../../functions/lib/current-public-code-v2.js";

const api = () => previewPair;
const sessionApi = () => readerSession;
const proofApi = () => readerProof;
export const BRIDGE_ATTEMPTS = "cmsReaderBridgeInstallAttempts";
export const BRIDGE_PROOFS = "cmsReaderBridgeInstalledProofs";
export const FIRST_INSTALL_STAGE = "legacy-first-install";
export const CONVERTED_STAGE = "public-converted";
const stageOf = value => proofApi().cmsReaderBridgeStage(value);
const HEX = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SCOPES = ["publicOld", "publicNew", "previewOld", "previewNew"];
const FEATURES = ["publicCode", "postChrome", "settings", "capabilities"];
const ENDPOINTS = { publicCode: "cmsReadPairCurrentCodeV2", postChrome: "cmsGetPublicPage", settings: "cmsGetPublishedSettings",
  capabilities: "cmsGetPublicPage", previewRequest: "cmsPreviewStatus" };
const object = value => value && typeof value === "object" && !Array.isArray(value);
const bytesDigest = value => createHash("sha256").update(value).digest("hex");
export class CmsReaderBridgeError extends Error {
  constructor(code) { super("CMS reader bridge refused"); this.name = "CmsReaderBridgeError"; this.code = code; }
}
function fail(code) { throw new CmsReaderBridgeError(code); }
function exact(value, keys) {
  if (!object(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail("bridge-request-invalid");
}
function identities(readers) {
  exact(readers, ["functions", "cmsApi"]);
  return Object.fromEntries(Object.entries(readers).map(([component, reader]) => {
    if (api().parseReader(reader).component !== component || ![1, 2].every(v => reader.supported.adminSession.includes(v))) fail("bridge-reader-invalid");
    return [component, sessionApi().readerSessionDigest(reader)];
  }));
}
export function parseCmsReaderBridgeRequest(input) {
  if (!object(input) || Object.hasOwn(input, "stage") && input.stage !== FIRST_INSTALL_STAGE) fail("bridge-request-invalid");
  const first = Object.hasOwn(input, "stage");
  exact(input, ["schemaVersion", "operationId", "expectedStateDigest", "readers", "cases",
    ...(first ? ["stage", "refusals", "legacyPublicSelectorDigest"] : [])]);
  if (input.schemaVersion !== 2 || !/^reader-[a-z0-9][a-z0-9-]{0,63}$/.test(input.operationId) ||
      !HEX.test(input.expectedStateDigest) || !Array.isArray(input.cases) || input.cases.length < (first ? 28 : 36) || input.cases.length > (first ? 28 : 128) ||
      first && (!HEX.test(input.legacyPublicSelectorDigest) || !Array.isArray(input.refusals) || input.refusals.length !== 2)) fail("bridge-request-invalid");
  identities(input.readers);
  const seen = new Set();
  for (const row of [...input.cases, ...(first ? input.refusals : [])]) {
    const refusal = first && input.refusals.includes(row);
    exact(row, ["scope", "feature", "version", "pairDigest", "endpoint", "body", "expected", ...(first ? ["sourcePairDigest"] : [])]);
    exact(row.expected, ["status", "contentType", "bodyDigest"]);
    const key = `${row.scope}:${row.version}:${row.feature}`;
    const scopes = first ? refusal ? ["publicNew"] : ["publicOld", "previewOld", "previewNew"] : SCOPES;
    if (!scopes.includes(row.scope) || ![1, 2].includes(row.version) || seen.has(key) || !HEX.test(row.pairDigest) ||
        !Object.hasOwn(ENDPOINTS, row.feature) || row.endpoint !== ENDPOINTS[row.feature] || !object(row.body) ||
        Buffer.byteLength(JSON.stringify(row.body)) > 1_500_000 || row.expected.status !== (refusal ? 503 : 200) ||
        first && !HEX.test(row.sourcePairDigest) || refusal && (row.feature !== "publicCode" ||
          row.expected.bodyDigest !== bytesDigest(JSON.stringify({ error: "Private pair CODE unavailable" }))) ||
        row.expected.contentType !== "application/json" || !HEX.test(row.expected.bodyDigest)) fail("bridge-case-invalid");
    if (row.feature === "publicCode" && (row.body.mode !== "current-code-v2" || row.body.schemaVersion !== 2) ||
        row.feature === "postChrome" && row.body.mode !== "no-build-post-v1" ||
        row.feature === "capabilities" && row.body.mode !== "no-build-page-v1" ||
        row.feature === "settings" && typeof row.body.id !== "string" ||
        row.feature === "previewRequest" && !row.scope.startsWith("preview")) fail("bridge-case-invalid");
    seen.add(key);
  }
  for (const scope of first ? ["publicOld", "previewOld", "previewNew"] : SCOPES) for (const version of [1, 2]) {
    const required = scope.startsWith("preview") ? [...FEATURES, "previewRequest"] : FEATURES;
    if (required.some(feature => !seen.has(`${scope}:${version}:${feature}`))) fail("bridge-coverage-incomplete");
  }
  return structuredClone(input);
}

async function boundedBytes(response, max = 2 * 1024 * 1024) {
  if (!response?.body) fail("bridge-http-unavailable");
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break;
      length += part.value.length; if (length > max) fail("bridge-http-too-large"); chunks.push(part.value); }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks, length);
}

/** Authenticated HTTP transport with no deployment, edge-preview session,
 * Wrangler, provider mutation or automatic network retry. Renderer health
 * uses a separate journaled caller.
 */
export function createCmsReaderReplayTransport({ targets, projectId, readStaffToken, readEdgeSecret, fetchImpl = fetch,
  signal, allowLocalEmulator = false } = {}) {
  const production = projectId === "njpbs-site", development = projectId === "njpbs-site-dev";
  const demo = typeof projectId === "string" && /^demo-[a-z0-9-]+$/.test(projectId) && allowLocalEmulator;
  if (!production && !development && !demo) fail("bridge-target-invalid");
  exact(targets, ["functions", "cmsApi"]);
  const parsed = {};
  for (const component of ["functions", "cmsApi"]) {
    exact(targets[component], ["1", "2"]);
    parsed[component] = {};
    for (const version of [1, 2]) {
      const url = new URL(targets[component][version]);
      const local = demo && url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname) &&
        /^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "");
      const remote = !demo && url.protocol === "https:" && !url.port && (component === "functions"
        ? url.hostname === `us-central1-${projectId}.cloudfunctions.net`
        : url.hostname === (production ? "api.example.org" : "dev-api.example.org"));
      if ((!local && !remote) || url.username || url.password || url.search || url.hash ||
          component === "cmsApi" && url.pathname !== `/api/cms/v${version}/reader`) fail("bridge-target-invalid");
      parsed[component][version] = url.href;
    }
  }
  if (typeof readStaffToken !== "function" || typeof readEdgeSecret !== "function") fail("bridge-credentials-unbound");
  return async ({ component, version, envelope, gatewayReaderDigest }) => {
    if (!["functions", "cmsApi"].includes(component) || ![1, 2].includes(version) || !HEX.test(gatewayReaderDigest)) fail("bridge-target-invalid");
    signal?.throwIfAborted();
    const token = await readStaffToken();
    if (typeof token !== "string" || !token || /[\r\n]/.test(token)) fail("bridge-credentials-unavailable");
    const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
    if (component === "functions") {
      const edge = await readEdgeSecret();
      if (typeof edge !== "string" || !edge || /[\r\n]/.test(edge)) fail("bridge-credentials-unavailable");
      headers["x-njpbs-cms-edge"] = edge; headers["x-njpbs-cms-reader"] = gatewayReaderDigest;
    }
    try {
      const timeout = AbortSignal.timeout(20_000);
      const response = await fetchImpl(parsed[component][version], { method: "POST", redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers, body: JSON.stringify(envelope) });
      const bytes = await boundedBytes(response, envelope.action === "request" && envelope.endpoint === "cmsReadPairCurrentCodeV2"
        ? Math.ceil(20 * 1024 * 1024 / 3) * 4 + 64 * 1024 : 2 * 1024 * 1024);
      return { status: response.status, contentType: response.headers.get("content-type")?.split(";")[0], bytes,
        functionsReader: response.headers.get("x-njpbs-functions-reader"), gatewayReader: response.headers.get("x-njpbs-gateway-reader") };
    } catch (error) {
      if (error instanceof CmsReaderBridgeError) throw error;
      fail("bridge-http-uncertain");
    }
  };
}

function assertState(request, state) {
  const pairApi = api();
  if (state?.schemaVersion !== 2 || pairApi.digest(state) !== request.expectedStateDigest ||
      !HEX.test(state.publicSelectorDigest) || !Array.isArray(state.publicPairs) || state.publicPairs.length !== 2 ||
      !Array.isArray(state.previewPairs) || state.previewPairs.length !== 2) fail("bridge-live-state-changed");
  const pairDigests = { publicOld: state.publicPairs[0].pairDigest, publicNew: state.publicPairs[1].pairDigest,
    previewOld: pairApi.digest(pairApi.parsePair(state.previewPairs[0])), previewNew: pairApi.digest(pairApi.parsePair(state.previewPairs[1])) };
  if (new Set(Object.values(pairDigests)).size !== 4 || Object.values(pairDigests).some(value => !HEX.test(value))) fail("bridge-retained-pairs-invalid");
  for (const row of request.cases) if (row.pairDigest !== pairDigests[row.scope]) fail("bridge-case-pair-mismatch");
  if (stageOf(request) === FIRST_INSTALL_STAGE) {
    if (state.publicSelectorDigest !== request.legacyPublicSelectorDigest) fail("bridge-live-state-changed");
    const p = protocol;
    const references = state.publicPairs.map(pair => p.parsePublicReleasePairReference(pair.pair));
    for (const row of [...request.cases, ...request.refusals]) {
      const refusal = request.refusals.includes(row), index = refusal ? 1 : 0;
      if (row.pairDigest !== pairDigests[row.scope] || row.sourcePairDigest !== state.publicPairs[index].pairDigest) fail("bridge-case-pair-mismatch");
      if (row.feature === "publicCode") {
        const body = pairCodeGrammar.parsePairCodeRequest(row.body);
        const consumer = state.previewPairs[row.scope === "previewNew" ? 1 : 0];
        if (body.selection.expectedPublicSelectorDigest !== request.legacyPublicSelectorDigest ||
            api().digest(body.selection.pair) !== api().digest(references[index]) ||
            body.selection.previewPairId !== consumer.pairId || body.rendererSha !== consumer.rendererSha) fail("bridge-case-pair-mismatch");
      }
    }
  }
  for (const reader of Object.values(request.readers)) for (const pair of [...state.publicPairs, ...state.previewPairs]) {
    if (!object(pair.requirements) || pairApi.CONTRACT_KEYS.some(key => !reader.supported[key].includes(pair.requirements[key]))) fail("bridge-contract-unsupported");
  }
  return state;
}
async function assertStageRoot({ firestore, transaction, request }) {
  if (stageOf(request) !== FIRST_INSTALL_STAGE) return;
  const p = protocol;
  const root = p.parseVersionedPublicDeployment((await transaction.get(firestore.doc("system/publicDeployment"))).data());
  if (root.schemaVersion !== 1 || root.state !== "idle" || p.publicReleaseDigest(root) !== request.legacyPublicSelectorDigest) fail("bridge-first-install-root-changed");
}
function functionsBound(value, names) {
  if (names.some(name => typeof value?.[name] !== "function")) fail("bridge-installed-transport-unbound");
}
async function providerMatch(request, readProviders) {
  const live = await readProviders();
  exact(live, ["functions", "cmsApi"]);
  if (["functions", "cmsApi"].some(component => api().digest(live[component]) !== api().digest(request.readers[component].providerIdentities))) fail("bridge-provider-changed");
  return live;
}

/** Dry-run does not issue sessions or probes, write receipts or fetch secrets. */
export async function dryRunCmsReaderBridge({ request: raw, readLiveState }) {
  const request = parseCmsReaderBridgeRequest(raw);
  functionsBound({ readLiveState }, ["readLiveState"]);
  assertState(request, await readLiveState());
  return { schemaVersion: 2, operationId: request.operationId, requestDigest: api().digest(request),
    stage: stageOf(request), cases: request.cases.length, refusals: request.refusals?.length ?? 0,
    httpAttempts: (request.cases.length + (request.refusals?.length ?? 0)) * 2 + 4, writes: 0 };
}

/** Each attempt is reserved before any HTTP dispatch. Crash or lost response
 * leaves a named uncertain attempt; rerunning cannot issue a second probe.
 * All content evidence is exact status/MIME/byte digest, never a success count.
 */
export async function proveCmsReaderBridge({ firestore, request: raw, transport, readLiveState, readProviders, readRetainedCases,
  assertStateInTransaction, signal, now = Date.now }) {
  const request = parseCmsReaderBridgeRequest(raw), pairApi = api(), requestDigest = pairApi.digest(request);
  functionsBound({ transport, readLiveState, readProviders, readRetainedCases, assertStateInTransaction },
    ["transport", "readLiveState", "readProviders", "readRetainedCases", "assertStateInTransaction"]);
  const ref = firestore.collection(BRIDGE_ATTEMPTS).doc(request.operationId);
  const previous = (await ref.get()).data();
  if (previous) {
    if (previous.requestDigest !== requestDigest) fail("bridge-operation-conflict");
    if (previous.state !== "complete") fail("bridge-attempt-uncertain");
    return previous.proof;
  }
  signal?.throwIfAborted();
  assertState(request, await readLiveState());
  // The loader opens the original retained public/preview packs and verifies
  // their seals. Operator-supplied expected digests alone are not evidence.
  const retained = await readRetainedCases(request);
  if (pairApi.digest(retained) !== pairApi.digest(stageOf(request) === FIRST_INSTALL_STAGE
    ? { cases: request.cases, refusals: request.refusals } : request.cases)) fail("bridge-retained-cases-mismatch");
  await providerMatch(request, readProviders);
  await firestore.runTransaction(async tx => {
    if ((await tx.get(ref)).exists) fail("bridge-attempt-uncertain");
    await assertStageRoot({ firestore, transaction: tx, request });
    if (await assertStateInTransaction({ firestore, transaction: tx, request }) !== request.expectedStateDigest) fail("bridge-live-state-changed");
    tx.create(ref, { schemaVersion: 2, requestDigest, state: "started", startedAt: new Date(now()).toISOString(),
      ...(stageOf(request) === FIRST_INSTALL_STAGE ? { stage: FIRST_INSTALL_STAGE } : {}) });
  });
  try {
    const ids = identities(request.readers), results = [], refusals = [];
    for (const component of ["functions", "cmsApi"]) for (const version of [1, 2]) {
      // Stable IDs from the immutable operation permit only original-session
      // readback after a lost response, never a new lease under the same step.
      const makeId = key => {
        const hex = bytesDigest(`${requestDigest}:${component}:${version}:${key}`);
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
      };
      const sessionIds = { functions: makeId("functions"), cmsApi: makeId("cmsApi") };
      if (Object.values(sessionIds).some(id => !UUID.test(id))) fail("bridge-session-invalid");
      signal?.throwIfAborted();
      const opened = await transport({ component, version, gatewayReaderDigest: ids.cmsApi,
        envelope: { version, action: "open", sessionIds, ttlMs: 300_000 } });
      let value;
      try { value = JSON.parse(opened.bytes.toString("utf8")); } catch { fail("bridge-session-invalid"); }
      if (opened.status !== 200 || opened.contentType !== "application/json" || pairApi.digest(value.identities) !== pairApi.digest(ids) ||
          ["functions", "cmsApi"].some(key => value.leases?.[key]?.sessionId !== sessionIds[key] ||
            value.leases[key].readerDigest !== ids[key] || value.leases[key].expiresAt - value.leases[key].issuedAt !== 300_000)) fail("bridge-session-invalid");
      for (const row of [...request.cases, ...(request.refusals ?? [])].filter(row => row.version === version)) {
        signal?.throwIfAborted();
        const reply = await transport({ component, version, gatewayReaderDigest: ids.cmsApi,
          envelope: { version, action: "request", sessionIds, endpoint: row.endpoint, body: row.body } });
        if (reply.status !== row.expected.status || reply.contentType !== row.expected.contentType ||
            bytesDigest(reply.bytes) !== row.expected.bodyDigest || reply.functionsReader !== ids.functions || reply.gatewayReader !== ids.cmsApi) fail("bridge-replay-mismatch");
        const result = { component, scope: row.scope, version, feature: row.feature, pairDigest: row.pairDigest, ...row.expected,
          ...(stageOf(request) === FIRST_INSTALL_STAGE ? { sourcePairDigest: row.sourcePairDigest } : {}) };
        (request.refusals?.includes(row) ? refusals : results).push(result);
      }
    }
    await providerMatch(request, readProviders);
    assertState(request, await readLiveState());
    const proof = { schemaVersion: 2, operationId: request.operationId, requestDigest, stateDigest: request.expectedStateDigest,
      readerIdentities: ids, readers: request.readers, results, verifiedAt: new Date(now()).toISOString(),
      ...(stageOf(request) === FIRST_INSTALL_STAGE ? { stage: FIRST_INSTALL_STAGE, refusals,
        legacyPublicSelectorDigest: request.legacyPublicSelectorDigest } : {}) };
    await firestore.runTransaction(async tx => {
      const current = (await tx.get(ref)).data();
      if (current?.state !== "started" || current.requestDigest !== requestDigest) fail("bridge-attempt-uncertain");
      await assertStageRoot({ firestore, transaction: tx, request });
      if (await assertStateInTransaction({ firestore, transaction: tx, request }) !== request.expectedStateDigest) fail("bridge-live-state-changed");
      tx.update(ref, { state: "complete", proof });
    });
    return proof;
  } catch (error) {
    // No response body, SDK error, header or credential enters the journal.
    await ref.update({ state: "uncertain", refusalCode: error instanceof CmsReaderBridgeError ? error.code : "bridge-attempt-uncertain" });
    if (error instanceof CmsReaderBridgeError) throw error;
    fail("bridge-attempt-uncertain");
  }
}

/** Receipt installation reuses the candidate/legacy compare-and-swap; it cannot
 * substitute source catalogs for live reader support or mutate a provider.
 */
export async function installCmsReaderBridge({ firestore, request: raw, commitReader, candidates, readProviders,
  readLiveState, assertStateInTransaction, now = Date.now, signal }) {
  const request = parseCmsReaderBridgeRequest(raw), pairApi = api();
  const stage = stageOf(request), parseProof = (record, operationId) => proofApi().parseInstalledCmsReaderProof(record, operationId, { stage });
  functionsBound({ commitReader, readProviders, readLiveState, assertStateInTransaction },
    ["commitReader", "readProviders", "readLiveState", "assertStateInTransaction"]);
  const attemptRef = firestore.collection(BRIDGE_ATTEMPTS).doc(request.operationId);
  const proofRef = firestore.collection(BRIDGE_PROOFS).doc(request.operationId);
  const identityRef = firestore.collection(BRIDGE_PROOFS).doc(proofApi().cmsReaderBridgeProofKey(request.readers, stage));
  const existing = (await proofRef.get()).data();
  if (existing) {
    parseProof(existing, request.operationId);
    if (existing.proof?.requestDigest !== pairApi.digest(request)) fail("bridge-operation-conflict");
    const identity = (await identityRef.get()).data();
    parseProof(identity, identity?.proof?.operationId);
    if (proofApi().cmsReaderBridgeProofKey(identity.proof.readers, stage) !== identityRef.id) fail("bridge-reader-changed");
    // Readback only. A completed retry cannot refresh or reinstall readers.
    return existing;
  }
  const attempt = (await attemptRef.get()).data();
  const proof = attempt?.proof;
  if (attempt?.state !== "complete" || attempt.requestDigest !== pairApi.digest(request) || !proof ||
      now() < Date.parse(proof.verifiedAt) || now() - Date.parse(proof.verifiedAt) > 300_000) fail("bridge-proof-unavailable-or-expired");
  assertState(request, await readLiveState());
  if (stage === FIRST_INSTALL_STAGE) await firestore.runTransaction(transaction => assertStageRoot({ firestore, transaction, request }), { readOnly: true });
  await providerMatch(request, readProviders);
  const receipts = {};
  for (const component of ["functions", "cmsApi"]) {
    signal?.throwIfAborted();
    if (candidates?.[component]?.component !== component) fail("bridge-candidate-unbound");
    receipts[component] = await commitReader(firestore, { ...candidates[component], supported: request.readers[component].supported }, {
      collect: async () => (await providerMatch(request, readProviders))[component],
    });
    if (sessionApi().readerSessionDigest(pairApi.currentReader(receipts[component], component)) !== proof.readerIdentities[component]) fail("bridge-reader-changed");
  }
  const record = { schemaVersion: 2, proof, readerDigests: Object.fromEntries(Object.entries(receipts)
    .map(([component, receipt]) => [component, pairApi.digest(receipt.lastComplete)])) };
  parseProof(record, request.operationId);
  return firestore.runTransaction(async tx => {
    const rows = await tx.getAll(proofRef, attemptRef, ...["functions", "cmsApi"].map(component => firestore.doc(`${pairApi.READER_RECEIPTS}/${component}`)), identityRef);
    if (pairApi.digest(rows[1].data()) !== pairApi.digest(attempt)) fail("bridge-proof-changed");
    await assertStageRoot({ firestore, transaction: tx, request });
    if (["functions", "cmsApi"].some((component, index) => pairApi.digest(rows[index + 2].data()) !== pairApi.digest(receipts[component]))) fail("bridge-reader-changed");
    if (await assertStateInTransaction({ firestore, transaction: tx, request }) !== request.expectedStateDigest) fail("bridge-live-state-changed");
    const durable = rows[0].exists ? rows[0].data() : record;
    if (rows[0].exists) {
      if (pairApi.digest(rows[0].data().proof) !== pairApi.digest(proof)) fail("bridge-operation-conflict");
    } else tx.create(proofRef, record);
    // Create once under the stable deployed-reader identity, independently of
    // probe operation IDs. New explicit attempts can recover or refresh proof
    // without redeploying a reader or changing its original installed binding.
    if (rows[4].exists) {
      const identity = rows[4].data();
      parseProof(identity, identity.proof?.operationId);
      if (proofApi().cmsReaderBridgeProofKey(identity.proof.readers, stage) !== identityRef.id) fail("bridge-reader-changed");
    } else tx.create(identityRef, durable);
    return durable;
  });
}

/** Shared bootstrap CAS adapter. All remote/provider work happens before this
 * guard; the caller supplies its real authority readset inside the original
 * transaction. Supported open old sessions are retained, never a STOP here.
 * Retirement continues to use ALL historical windows in cms-reader-session.
 */
export async function prepareInstalledCmsReaderConsumers({ firestore, operationId, readProviders,
  assertStateInTransaction, now = Date.now, signal, stage = CONVERTED_STAGE }) {
  functionsBound({ readProviders, assertStateInTransaction }, ["readProviders", "assertStateInTransaction"]);
  const ref = firestore.collection(BRIDGE_PROOFS).doc(operationId), record = (await ref.get()).data();
  const parseProof = (value, id) => proofApi().parseInstalledCmsReaderProof(value, id, { stage });
  parseProof(record, operationId);
  const proof = record?.proof;
  const identityRef = firestore.collection(BRIDGE_PROOFS).doc(proofApi().cmsReaderBridgeProofKey(proof.readers, stage));
  const identity = (await identityRef.get()).data();
  parseProof(identity, identity?.proof?.operationId);
  if (proofApi().cmsReaderBridgeProofKey(identity.proof.readers, stage) !== identityRef.id) fail("bridge-reader-changed");
  if (record?.schemaVersion !== 2 || !proof || now() < Date.parse(proof.verifiedAt) || now() - Date.parse(proof.verifiedAt) > 300_000) fail("bridge-installed-proof-unavailable");
  await providerMatch({ readers: proof.readers }, readProviders);
  signal?.throwIfAborted();
  const evidenceDigest = api().digest({ record, identity });
  if (stage === FIRST_INSTALL_STAGE) await firestore.runTransaction(transaction => assertStageRoot({ firestore, transaction, request: proof }), { readOnly: true });
  return { stage, digest: evidenceDigest, async assertCurrentInTransaction({ transaction }) {
    const pairApi = api();
    const rows = await transaction.getAll(ref, ...["functions", "cmsApi"].map(component => firestore.doc(`${pairApi.READER_RECEIPTS}/${component}`)), identityRef);
    if (pairApi.digest({ record: rows[0].data(), identity: rows[3].data() }) !== evidenceDigest || now() - Date.parse(proof.verifiedAt) > 300_000) fail("bridge-installed-proof-changed");
    await assertStageRoot({ firestore, transaction, request: proof });
    for (const [index, component] of ["functions", "cmsApi"].entries()) {
      const reader = pairApi.currentReader(rows[index + 1].data(), component);
      if (sessionApi().readerSessionDigest(reader) !== proof.readerIdentities[component]) fail("bridge-reader-changed");
    }
    if (await assertStateInTransaction({ firestore, transaction, request: { expectedStateDigest: proof.stateDigest,
      ...(stage === FIRST_INSTALL_STAGE ? { stage, legacyPublicSelectorDigest: proof.legacyPublicSelectorDigest } : {}) } }) !== proof.stateDigest) fail("bridge-live-state-changed");
    return evidenceDigest;
  } };
}
