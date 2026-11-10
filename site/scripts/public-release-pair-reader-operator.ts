import type { Firestore } from "firebase-admin/firestore";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import { privatePublicReleaseSlotTarget } from "../../scripts/lib/private-public-release-slot-target.mjs";
import { PRIVATE_PREFLIGHT_ATTEMPTS, parsePrivatePairPreflightPlan, preflightDigest } from "../../scripts/lib/private-pair-preflight-caller.mjs";
import { operatorRefused as refuse, parseOperatorArgs, readOperatorPacket, assertOperatorSource,
  parseOperatorCredentialIdentity, operatorCredentialStream, operatorAccount, openOperatorDatabase } from "../../scripts/lib/public-release-operator-io.mjs";
import { installPublicReleasePairReaderWithPreflight } from "./install-public-release-pair-reader-with-preflight";
import { parseReaderSeals, exact, same } from "./public-release-pair-reader-contract";
import { readerSealPath } from "./public-release-pair-private-reader";
import type { PairRolloutReadback } from "../../functions/lib/public-release-pair-rollout";

// The legacy declaration omits this existing runtime utility. Keep the typed
// adapter here rather than widening the shared protocol contract for a CLI.
const freeze = (protocol as typeof protocol & { freeze<T>(value: T): Readonly<T> }).freeze;
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function parsePrivateReaderOperatorPacket(raw: unknown) {
  const value = exact(raw, ["schemaVersion", "kind", "operatorCommitSha", "credentialIdentity", "providerCredentialRef",
    "pair", "installPlan", "rollout", "preflightOperationId"]);
  if (value.schemaVersion !== 1 || value.kind !== "private-pair-reader-operator" || !/^[a-f0-9]{40}$/.test(String(value.operatorCommitSha)) ||
      !/^pass:\/\/[A-Za-z0-9/_-]{1,200}$/.test(String(value.providerCredentialRef))) refuse();
  const target = privatePublicReleaseSlotTarget({ pair: value.pair, installPlan: value.installPlan });
  parseOperatorCredentialIdentity(value.credentialIdentity, target.pair.environment);
  const rollout = exact(value.rollout, ["publisherApplication", "publisherWorkerVersionId", "imageDigest", "publicService", "publicWorkerVersionId",
    "publisherDeploymentId", "publicDeploymentId", "publisherTrafficPercent", "publicTrafficPercent"]);
  if (rollout.publisherApplication !== target.pair.publisher.application || rollout.publisherWorkerVersionId !== target.pair.publisher.workerVersionId ||
      rollout.imageDigest !== target.pair.publisher.imageDigest || rollout.publicService !== target.pair.publicWorker.service ||
      rollout.publicWorkerVersionId !== target.pair.publicWorker.versionId || rollout.publisherTrafficPercent !== 100 || rollout.publicTrafficPercent !== 100 ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(String(rollout.publisherDeploymentId)) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(String(rollout.publicDeploymentId))) refuse();
  parsePrivatePairPreflightPlan({ schemaVersion: 1, operationId: value.preflightOperationId, kind: "reader-installation",
    accountId: target.config.account_id, workerName: target.pair.publicWorker.service,
    workerVersion: target.pair.publicWorker.versionId, identity: target.pair, installedTargetDigest: "0".repeat(64) });
  return freeze({ ...structuredClone(value), operatorCommitSha: value.operatorCommitSha as string,
    credentialIdentity: structuredClone(value.credentialIdentity), installPlan: structuredClone(value.installPlan),
    preflightOperationId: value.preflightOperationId as string, pair: target.pair, rollout: rollout as PairRolloutReadback });
}

/** Historical SDK reads only. No provider GET, ephemeral session, RPC, grant or
 * freshness claim. Completion is distinct from the current installed target. */
export async function readPrivateReaderOperatorAttempt({ firestore, packet: raw }: { firestore: Firestore; packet: unknown }) {
  const packet = parsePrivateReaderOperatorPacket(raw), target = privatePublicReleaseSlotTarget({ pair: packet.pair, installPlan: packet.installPlan });
  work.assertPublicReleasePairDatabase(firestore, packet.pair);
  return firestore.runTransaction(async tx => {
    const [original, sealed] = await tx.getAll(firestore.doc(`${PRIVATE_PREFLIGHT_ATTEMPTS}/${packet.preflightOperationId}`),
      firestore.doc(readerSealPath(packet.pair)));
    if (!original.exists) {
      if (sealed.exists) refuse();
      return { preflight: null, readerInstall: null };
    }
    const row = original.data()!, request = parsePrivatePairPreflightPlan(row.request);
    if (request.kind !== "reader-installation" || request.operationId !== packet.preflightOperationId || request.accountId !== target.config.account_id ||
        request.workerName !== packet.pair.publicWorker.service || request.workerVersion !== packet.pair.publicWorker.versionId ||
        !same(request.identity, packet.pair) || row.schemaVersion !== 1 || !["started", "uncertain", "failed", "complete"].includes(row.state) ||
        !digest(row.callerSourceDigest) || !digest(row.callerConfigurationDigest) ||
        preflightDigest({ plan: request, callerSourceDigest: row.callerSourceDigest, callerConfigurationDigest: row.callerConfigurationDigest }) !== row.requestDigest) refuse();
    const preflight = { operationId: request.operationId, state: row.state, requestDigest: row.requestDigest,
      installedTargetDigest: request.installedTargetDigest };
    if (row.state !== "complete") {
      if (sealed.exists) refuse();
      return { preflight, readerInstall: null };
    }
    if (row.resultDigest !== preflightDigest(row.result)) refuse();
    const actual = exact(row.result, ["seals", "publisher"]), seals = parseReaderSeals(actual.seals, packet.pair);
    const publisher = exact(actual.publisher, ["pairDigest", "publisher", "readerContractDigest", "capabilities"]);
    if (publisher.pairDigest !== protocol.publicReleaseDigest(packet.pair) || !same(publisher.publisher, packet.pair.publisher) ||
        publisher.readerContractDigest !== packet.pair.readerContractDigest || !same(publisher.capabilities, seals.capabilities)) refuse();
    const identity = { schemaVersion: 1, kind: "private-pair-reader-install", pairDigest: protocol.publicReleaseDigest(packet.pair),
      sealDigest: protocol.publicReleaseDigest(seals), rolloutDigest: protocol.publicReleaseDigest(packet.rollout),
      publisherRpcDigest: protocol.publicReleaseDigest(publisher) };
    const installDigest = protocol.publicReleaseDigest(identity);
    const installed = await tx.get(firestore.doc(`${work.publicReleasePairPath(packet.pair.pairId)}/readerInstalls/${installDigest}`));
    if (!installed.exists) { if (sealed.exists) refuse(); return { preflight, readerInstall: null }; }
    const receipt = exact(installed.data(), [...Object.keys(identity), "installDigest", "completedAt"]);
    if (!sealed.exists || !same(parseReaderSeals(sealed.data(), packet.pair), seals) || receipt.installDigest !== installDigest ||
        !Number.isSafeInteger(receipt.completedAt) || (receipt.completedAt as number) < 1 ||
        Object.entries(identity).some(([key, value]) => receipt[key] !== value)) refuse();
    return { preflight, readerInstall: { installDigest, completedAt: receipt.completedAt, sealDigest: identity.sealDigest } };
  });
}

/** Only credential, SDK and network boundaries are replaceable in tests. The
 * original provider inspection, shared RPC and seal writer are always real. */
export async function runPrivateReaderOperator(args: string[], { readToken = operatorCredentialStream(0),
  readServiceAccount = operatorCredentialStream(3), openDatabase = openOperatorDatabase, fetchImpl = fetch, signal }: {
  readToken?: () => Promise<string>; readServiceAccount?: () => Promise<string>;
  openDatabase?: (account: unknown) => Promise<{ firestore: Firestore; close(): Promise<void> }>;
  fetchImpl?: typeof fetch; signal?: AbortSignal;
} = {}) {
  const options = parseOperatorArgs(args);
  signal?.throwIfAborted();
  const packet = parsePrivateReaderOperatorPacket(await readOperatorPacket(options));
  assertOperatorSource(packet.operatorCommitSha);
  const base = { schemaVersion: 1, kind: "private-pair-reader-operator-result", packetDigest: options.packetDigest,
    pairId: packet.pair.pairId, preflightOperationId: packet.preflightOperationId };
  if (options.mode === "plan") return { ...base, mode: "plan", authorityReads: 0, authorityWrites: 0, providerWrites: 0, runtimePreflight: "not-run" };
  signal?.throwIfAborted();
  const account = operatorAccount(await readServiceAccount(), packet.credentialIdentity);
  signal?.throwIfAborted();
  const connection = await openDatabase(account);
  try {
    signal?.throwIfAborted();
    if (options.mode === "readback") return { ...base, mode: "readback", ...await readPrivateReaderOperatorAttempt({ firestore: connection.firestore, packet }) };
    return { ...base, mode: "apply", ...await installPublicReleasePairReaderWithPreflight({ firestore: connection.firestore,
      pair: packet.pair, installPlan: packet.installPlan, rollout: packet.rollout, preflightOperationId: packet.preflightOperationId as string,
      readToken, fetchImpl, signal, authorized: true }) };
  } finally { await connection.close(); }
}
