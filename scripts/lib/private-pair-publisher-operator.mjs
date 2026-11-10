import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import protocol from "../../functions/lib/public-release-pair.js";
import ownership from "../../functions/lib/public-release-pair-work.js";
import rollout from "../../functions/lib/public-release-pair-rollout.js";
import targets from "../../functions/lib/publication-target.js";
import { preparePrivatePairPublisherInstall } from "./private-pair-publisher-prepare.mjs";
import { createPrivatePairPublisherProvider, PrivatePairProviderError } from "./private-pair-publisher-provider.mjs";
import { installPrivatePairPublisherWithPreflight } from "./private-pair-publisher-preflight.mjs";
import { parsePrivatePairPreflightPlan, preflightDigest, PRIVATE_PREFLIGHT_ATTEMPTS } from "./private-pair-preflight-caller.mjs";
import { readPrivatePairProviderResponse } from "./private-pair-publisher-response.mjs";
import { completePrivatePairPublisherInstall } from "./private-pair-first-install-completion.mjs";

const refuse = () => { throw new PrivatePairProviderError("operator-packet-refused"); };
const same = (a, b) => { if (protocol.publicReleaseDigest(a) !== protocol.publicReleaseDigest(b)) refuse(); };
const refusalCodes = new Set(["preflight-attempt-uncertain", "preflight-boundary-unavailable", "preflight-cancelled", "preflight-clock-invalid",
  "preflight-credential-unavailable", "preflight-http-refused", "preflight-input-invalid", "preflight-request-uncertain", "preflight-response-invalid",
  "preflight-subdomain-missing", "preflight-target-changed", "preflight-target-unavailable", "private-preflight-not-ready"]);
const operations = ["identity", "version", "deployment", "container"];
const sha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

/** No default apply mode. The digest is the externally reviewed packet's bytes. */
export function parsePrivatePublisherOperatorArgs(args) {
  if (![4, 5, 9].includes(args.length) || args[0] !== "--packet" || !args[1] || args[2] !== "--packet-digest" ||
      !protocol.digest(args[3]) || args.length === 5 && !["--apply", "--inventory", "--readback", "--upload"].includes(args[4]) ||
      args.length === 9 && (args[4] !== "--complete" || args[5] !== "--slot-plan" || !args[6] || args[7] !== "--slot-plan-digest" || !protocol.digest(args[8]))) refuse();
  return { filename: args[1], packetDigest: args[3], mode: args[4]?.slice(2) ?? "plan",
    ...args.length === 9 ? { slotPlanFilename: args[6], slotPlanDigest: args[8] } : {} };
}

export function parsePrivatePublisherOperatorPacket(value) {
  protocol.exact(value, ["schemaVersion", "kind", "intent", "preparation", "preflightOperationId", "credentialIdentity"]);
  if (value.schemaVersion !== 1 || value.kind !== "private-pair-publisher-operator") refuse();
  const continuation = Object.hasOwn(value.intent, "continuationEnabled");
  protocol.exact(value.intent, ["pairTemplate", "retainedPairs", "legacyConfig", "imageReference", "executorReady",
    ...Object.hasOwn(value.intent, "slotInstall") ? ["slotInstall"] : [],
    ...continuation ? ["continuationEnabled", ...value.intent.continuationEnabled === true ? ["ingressProofService"] : []] : []]);
  if (continuation && (typeof value.intent.continuationEnabled !== "boolean" || value.intent.continuationEnabled &&
      (value.intent.executorReady !== true || typeof value.intent.ingressProofService !== "string" ||
      !/^njpbs-private-ingress-[a-z0-9-]{1,30}$/.test(value.intent.ingressProofService)))) refuse();
  const receipt = value.preparation;
  protocol.exact(receipt, ["schemaVersion", "kind", "plan", "executorReady", "moduleManifest", "providerWrites", "runtimePreflight"]);
  if (receipt.schemaVersion !== 2 || receipt.kind !== "private-pair-publisher-preparation" || receipt.providerWrites !== 0 ||
      receipt.runtimePreflight !== "not-run" || typeof receipt.executorReady !== "boolean" ||
      receipt.executorReady !== value.intent.executorReady || !Array.isArray(receipt.moduleManifest)) refuse();
  const plan = rollout.parsePublicReleasePairUploadPlan(receipt.plan);
  same(plan.pairTemplate, value.intent.pairTemplate);
  if (value.intent.imageReference !== plan.imageReference || !Array.isArray(value.intent.retainedPairs) || value.intent.retainedPairs.length > 8) refuse();
  const projectId = targets.publicationTarget(plan.pairTemplate.environment).projectId;
  const credential = value.credentialIdentity;
  protocol.exact(credential, ["projectId", "clientEmail", "privateKeyId"]);
  if (credential.projectId !== projectId || typeof credential.clientEmail !== "string" ||
      !new RegExp(`^[a-z][a-z0-9-]{2,62}@${projectId}\\.iam\\.gserviceaccount\\.com$`).test(credential.clientEmail) || !sha(credential.privateKeyId)) refuse();
  // Validate the eventual caller binding before bundling, credentials or I/O.
  parsePrivatePairPreflightPlan({ schemaVersion: 1, operationId: value.preflightOperationId, kind: "publisher", accountId: plan.accountId,
    workerName: plan.pairTemplate.publisher.application, workerVersion: "00000000-0000-0000-0000-000000000000", installedTargetDigest: "0".repeat(64),
    identity: { pairId: plan.pairTemplate.pairId, commitSha: plan.pairTemplate.commitSha, environment: plan.pairTemplate.environment,
      journalNamespace: plan.pairTemplate.publisher.journalNamespace } });
  return protocol.freeze(structuredClone(value));
}

function accountForPacket(raw, identity) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 64 * 1024) refuse();
  const account = JSON.parse(raw);
  if (account?.type !== "service_account" || account.project_id !== identity.projectId || account.client_email !== identity.clientEmail ||
      account.private_key_id !== identity.privateKeyId || typeof account.private_key !== "string" || account.private_key.length < 32) refuse();
  return { projectId: account.project_id, clientEmail: account.client_email, privateKey: account.private_key };
}

/** Credential streams are read at first use, only in this process. */
export function privatePublisherCredentialStream(fd) {
  let value;
  return () => {
    if (value === undefined) {
      const bytes = readFileSync(fd);
      if (!bytes.length || bytes.length > 64 * 1024) refuse();
      value = bytes.toString("utf8").trim();
      if (!value) refuse();
    }
    return value;
  };
}

async function openProductionDatabase(account) {
  if (["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "FUNCTIONS_EMULATOR", "FIREBASE_DATABASE_EMULATOR_HOST"].some(key => Object.hasOwn(process.env, key))) refuse();
  const require = createRequire(import.meta.url);
  const { initializeApp, cert, deleteApp } = require("firebase-admin/app"), { getFirestore } = require("firebase-admin/firestore");
  const app = initializeApp({ projectId: account.projectId, credential: cert(account) }, "private-pair-publisher-operator");
  return { firestore: getFirestore(app), close: () => deleteApp(app) };
}

/** Historical receipt inspection only: no grant, RPC, timestamp refresh or GET
 * to the provider. Output is allowlisted, never raw database/provider data. */
export async function readPrivatePublisherOperatorAttempt({ firestore, packet }) {
  const plan = packet.preparation.plan, planDigest = protocol.publicReleaseDigest(plan);
  const installedOperations = [...operations, ...packet.intent.continuationEnabled === true ? ["trigger"] : []];
  ownership.assertPublicReleasePairDatabase(firestore, rollout.publicReleasePairUploadCandidate(plan));
  const uploadPath = rollout.publicReleasePairUploadPath(plan.pairTemplate.pairId);
  const rows = await firestore.runTransaction(tx => tx.getAll(...[uploadPath, ...installedOperations.map(op => `${uploadPath}/operations/${op}`),
    `${PRIVATE_PREFLIGHT_ATTEMPTS}/${packet.preflightOperationId}`].map(path => firestore.doc(path))));
  const upload = rows[0].data();
  if (upload) {
    protocol.exact(upload, ["schemaVersion", "pairId", "planDigest", "state", "workerVersionId", "readbackDigest"]);
    if (upload.schemaVersion !== 2 || upload.pairId !== plan.pairTemplate.pairId || upload.planDigest !== planDigest ||
        !["reserved", "uncertain", "uploaded"].includes(upload.state)) refuse();
    if (upload.state === "uploaded" ? !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(upload.workerVersionId) || !protocol.digest(upload.readbackDigest)
      : upload.workerVersionId !== null || upload.readbackDigest !== null) refuse();
  }
  const steps = {};
  for (const [index, operation] of installedOperations.entries()) {
    const row = rows[index + 1].data();
    if (!row) { steps[operation] = null; continue; }
    protocol.exact(row, ["schemaVersion", "pairId", "planDigest", "operation", "requestDigest", "state", "readbackDigest"]);
    if (!upload || row.schemaVersion !== 2 || row.pairId !== plan.pairTemplate.pairId || row.planDigest !== planDigest || row.operation !== operation ||
        !protocol.digest(row.requestDigest) || !["reserved", "uncertain", "verified"].includes(row.state) ||
        (row.state === "verified" ? !protocol.digest(row.readbackDigest) : row.readbackDigest !== null)) refuse();
    const response = await readPrivatePairProviderResponse({ firestore, plan, operation, requestDigest: row.requestDigest });
    steps[operation] = { state: row.state, requestDigest: row.requestDigest, readbackDigest: row.readbackDigest, response };
  }
  const proof = rows[installedOperations.length + 1].data();
  let preflight = null;
  if (proof) {
    const request = parsePrivatePairPreflightPlan(proof.request);
    same(request.identity, { pairId: plan.pairTemplate.pairId, commitSha: plan.pairTemplate.commitSha, environment: plan.pairTemplate.environment,
      journalNamespace: plan.pairTemplate.publisher.journalNamespace });
    if (request.kind !== "publisher" || request.operationId !== packet.preflightOperationId || request.accountId !== plan.accountId ||
        request.workerVersion !== upload?.workerVersionId || !["started", "uncertain", "failed", "complete"].includes(proof.state) || !protocol.digest(proof.requestDigest) || proof.schemaVersion !== 1 ||
        !protocol.digest(proof.callerSourceDigest) || !protocol.digest(proof.callerConfigurationDigest) ||
        preflightDigest({ plan: request, callerSourceDigest: proof.callerSourceDigest, callerConfigurationDigest: proof.callerConfigurationDigest }) !== proof.requestDigest ||
        proof.state === "complete" && (proof.resultDigest !== preflightDigest(proof.result) || proof.result?.ready !== true ||
          proof.result.pairId !== request.identity.pairId || proof.result.commitSha !== request.identity.commitSha ||
          proof.result.journalNamespace !== request.identity.journalNamespace)) refuse();
    preflight = { operationId: request.operationId, state: proof.state, requestDigest: proof.requestDigest,
      installedTargetDigest: request.installedTargetDigest };
    if (["failed", "uncertain"].includes(proof.state)) {
      preflight.refusalCode = refusalCodes.has(proof.refusalCode) ? proof.refusalCode : "preflight-refusal-unavailable";
      const health = proof.refusalHealth;
      if (health?.ready === false && health.pairId === request.identity.pairId &&
          ["billing-disabled", "waiting-for-executor", "not-ready"].includes(health.reason)) preflight.refusalReason = health.reason;
    }
  }
  return { schemaVersion: 1, kind: "private-pair-publisher-original-attempt", planDigest, pairId: plan.pairTemplate.pairId,
    upload: upload ? { state: upload.state, workerVersionId: upload.workerVersionId, readbackDigest: upload.readbackDigest } : null,
    operations: steps, preflight, publicSelectionChanged: false, publicationSuccess: false };
}

/** Only I/O boundaries are injectable for SDK/HTTP tests. Preparation and the
 * actual installer/shared RPC composition cannot be replaced by a callback. */
export async function runPrivatePublisherOperator(args, { readToken = privatePublisherCredentialStream(0),
  readServiceAccount = privatePublisherCredentialStream(3), openDatabase = openProductionDatabase, fetchImpl = fetch, signal } = {}) {
  const options = parsePrivatePublisherOperatorArgs(args);
  signal?.throwIfAborted();
  const bytes = readFileSync(options.filename);
  if (!bytes.length || bytes.length > 256 * 1024 || hash(bytes) !== options.packetDigest) refuse();
  const packet = parsePrivatePublisherOperatorPacket(JSON.parse(bytes.toString("utf8")));
  // Rebuild the protected handle from the exact clean checkout. Receipt hashes
  // alone never manufacture prepared bytes or confer provider write permission.
  const { plan, prepared } = await preparePrivatePairPublisherInstall(packet.intent);
  same(plan, packet.preparation.plan);
  same(prepared.moduleManifest, packet.preparation.moduleManifest);
  if (prepared.executorReady !== packet.preparation.executorReady) refuse();
  if (["upload", "complete"].includes(options.mode) && plan.schemaVersion !== 3) refuse();
  let installPlan;
  if (options.mode === "complete") {
    const bytes = readFileSync(options.slotPlanFilename);
    if (bytes.length > 64 * 1024 || hash(bytes) !== options.slotPlanDigest) refuse();
    installPlan = JSON.parse(bytes.toString("utf8"));
  }
  signal?.throwIfAborted();
  const base = { packetDigest: options.packetDigest, planDigest: protocol.publicReleaseDigest(plan),
    preflightOperationId: packet.preflightOperationId, executorReady: prepared.executorReady };
  if (options.mode === "plan") return { ...base, providerWrites: 0, runtimePreflight: "not-run", publicSelectionChanged: false, publicationSuccess: false };
  if (options.mode === "inventory") {
    const provider = createPrivatePairPublisherProvider({ prepared, readToken, fetchImpl });
    const inventory = await provider.readInitialInventory({ retainedApplications: packet.intent.retainedPairs.map(pair => pair.publisher.application) });
    return { ...base, inventory, providerWrites: 0, runtimePreflight: "not-run", publicSelectionChanged: false, publicationSuccess: false };
  }
  const rawAccount = await readServiceAccount(), account = accountForPacket(rawAccount, packet.credentialIdentity);
  signal?.throwIfAborted();
  const connection = await openDatabase(account);
  try {
    signal?.throwIfAborted();
    if (options.mode === "readback") {
      const attempt = await readPrivatePublisherOperatorAttempt({ firestore: connection.firestore, packet });
      if (plan.schemaVersion === 3) {
        const completion = (await connection.firestore.doc(rollout.publicReleasePairUploadCompletionPath(plan.pairTemplate.pairId)).get()).data();
        if (completion) {
          same(completion.planDigest, protocol.publicReleaseDigest(plan));
          const pair = await rollout.readPublicReleasePairUploadPair({ firestore: connection.firestore, plan,
            workerVersionId: attempt.upload?.workerVersionId });
          const registered = (await connection.firestore.doc(ownership.publicReleasePairPath(pair.pairId)).get()).data();
          if (registered) same(registered, pair);
          return { ...base, ...attempt, completion: { pair, installation: completion.installation, registered: Boolean(registered) } };
        }
      }
      return { ...base, ...attempt };
    }
    if (options.mode === "complete") {
      return { ...base, ...await completePrivatePairPublisherInstall({ firestore: connection.firestore, plan,
        installPlan, readToken, fetchImpl, signal, authorized: true }) };
    }
    return { ...base, ...await installPrivatePairPublisherWithPreflight({ firestore: connection.firestore, plan, prepared,
      preflightOperationId: packet.preflightOperationId, readToken, readServiceAccount: () => rawAccount, fetchImpl, signal, authorized: true,
      uploadOnly: options.mode === "upload" }) };
  } finally { await connection.close(); }
}
