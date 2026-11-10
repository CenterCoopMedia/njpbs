import protocol from "../../functions/lib/public-release-pair.js";
import pointer from "../../functions/lib/public-deployment-pointer.js";
import targets from "../../functions/lib/publication-target.js";
import admission from "../../functions/lib/public-release-bootstrap-admission.js";
import writer from "../../functions/lib/public-release-writer-fence.js";
import { closePublicReleaseBootstrapAdmission, abandonPublicReleaseBootstrapAdmission } from "../../functions/lib/public-release-bootstrap-adoption.js";
import { operatorRefused as refuse, parseOperatorArgs, readOperatorPacket, assertOperatorSource,
  parseOperatorCredentialIdentity, operatorCredentialStream, operatorAccount, openOperatorDatabase } from "./public-release-operator-io.mjs";

export function parseBootstrapFencePacket(value) {
  protocol.exact(value, ["schemaVersion", "kind", "operatorCommitSha", "credentialIdentity", "attempt"]);
  if (value.schemaVersion !== 1 || value.kind !== "bootstrap-admission-close-operator" || !/^[a-f0-9]{40}$/.test(value.operatorCommitSha ?? "")) refuse();
  const attempt = value.attempt;
  protocol.exact(attempt, ["schemaVersion", "operationId", "environment", "legacyPointerDigest"]);
  if (attempt.schemaVersion !== 2 || !pointer.isPublicDeploymentIdentifier(attempt.operationId) || !protocol.digest(attempt.legacyPointerDigest)) refuse();
  parseOperatorCredentialIdentity(value.credentialIdentity, attempt.environment);
  return protocol.freeze(structuredClone(value));
}
function database(firestore, environment) {
  if (/^demo-[a-z0-9-]+$/.test(firestore.projectId ?? "") && /^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) return;
  targets.assertPublicationDatabase(firestore, targets.publicationTarget(environment));
}
/** Historical close receipt plus separately labelled current ownership. Never
 * re-closes, opens, abandons, repairs or resumes admission after a lost reply. */
export async function readBootstrapFenceAttempt({ firestore, packet: raw }) {
  const packet = parseBootstrapFencePacket(raw), { attempt } = packet;
  database(firestore, attempt.environment);
  return firestore.runTransaction(async tx => {
    const [saved, fenceRow, writerRow, abandonRow] = await tx.getAll(
      firestore.doc(`${admission.BOOTSTRAP_ADMISSION_ATTEMPTS}/${attempt.operationId}`),
      firestore.doc(admission.BOOTSTRAP_ADMISSION_FENCE_PATH), firestore.doc(writer.RELEASE_WRITER_FENCE_PATH),
      firestore.doc(`system/publicReleaseAdmissions/bootstrapAbandons/${attempt.operationId}`));
    const attemptDigest = protocol.publicReleaseDigest(attempt);
    if (!saved.exists) return { operationId: attempt.operationId, attemptDigest, committed: false, ownsClosedFence: false };
    if (protocol.publicReleaseDigest(saved.data()) !== attemptDigest || !fenceRow.exists) refuse();
    const current = admission.parseBootstrapAdmissionFence(fenceRow.data());
    const ours = current.operationId === attempt.operationId;
    if (ours && current.attemptDigest !== attemptDigest) refuse();
    const ownsClosedFence = ours && current.status === "closed";
    if (ownsClosedFence && protocol.publicReleaseDigest(writer.parseReleaseWriterFence(writerRow.data())) !==
        protocol.publicReleaseDigest({ schemaVersion: 2, operationId: attempt.operationId, attemptDigest })) refuse();
    const abandonReceipt = abandonRow.exists ? abandonRow.data() : null;
    if (abandonReceipt && protocol.publicReleaseDigest(abandonReceipt) !== protocol.publicReleaseDigest({ ...attempt,
      kind: "bootstrap-admission-abandoned", attemptDigest })) refuse();
    return { operationId: attempt.operationId, attemptDigest, committed: true, ownsClosedFence, current, abandonReceipt, writerFencePresent: writerRow.exists };
  });
}
/** Default plan exits before credentials/SDK. Only the existing close owner
 * mutates, with its unchanged queue, pointer, media and writer-fence guards. */
export async function runBootstrapFenceOperator(args, { readServiceAccount = operatorCredentialStream(3),
  openDatabase = openOperatorDatabase, signal } = {}) {
  const options = parseOperatorArgs(args, ["--apply", "--readback", "--abandon"]);
  signal?.throwIfAborted();
  const packet = parseBootstrapFencePacket(await readOperatorPacket(options));
  assertOperatorSource(packet.operatorCommitSha);
  const base = { schemaVersion: 1, kind: "bootstrap-admission-close-result", packetDigest: options.packetDigest,
    operationId: packet.attempt.operationId, attemptDigest: protocol.publicReleaseDigest(packet.attempt) };
  if (options.mode === "plan") return { ...base, mode: "plan", authorityReads: 0, authorityWrites: 0, providerWrites: 0 };
  signal?.throwIfAborted();
  const account = operatorAccount(await readServiceAccount(), packet.credentialIdentity);
  signal?.throwIfAborted();
  const connection = await openDatabase(account);
  try {
    signal?.throwIfAborted();
    if (options.mode === "readback") return { ...base, mode: "readback", ...await readBootstrapFenceAttempt({ firestore: connection.firestore, packet }) };
    const owner = options.mode === "abandon" ? abandonPublicReleaseBootstrapAdmission : closePublicReleaseBootstrapAdmission;
    const result = await owner({ firestore: connection.firestore, attempt: packet.attempt });
    return { ...base, mode: options.mode, ...result };
  } finally { await connection.close(); }
}
