import p from "../../functions/lib/public-release-pair.js";
import owner from "../../functions/lib/dev-public-release-pause-recovery.js";
import { operatorRefused as refuse, parseOperatorArgs, readOperatorPacket, assertOperatorSource,
  parseOperatorCredentialIdentity, operatorCredentialStream, operatorAccount, openOperatorDatabase } from "./public-release-operator-io.mjs";

export function parseDevPublicReleasePauseRecoveryPacket(value) {
  p.exact(value, ["schemaVersion", "kind", "operatorCommitSha", "credentialIdentity", "attempt"]);
  if (value.schemaVersion !== 1 || value.kind !== "dev-public-release-pause-recovery-operator" || !/^[a-f0-9]{40}$/.test(value.operatorCommitSha ?? "")) refuse();
  owner.parseDevPublicReleasePauseRecoveryAttempt(value.attempt);
  parseOperatorCredentialIdentity(value.credentialIdentity, "development");
  return p.freeze(structuredClone(value));
}
export async function runDevPublicReleasePauseRecoveryOperator(args, { readServiceAccount = operatorCredentialStream(3),
  openDatabase = openOperatorDatabase, signal } = {}) {
  const options = parseOperatorArgs(args);
  signal?.throwIfAborted();
  const packet = parseDevPublicReleasePauseRecoveryPacket(await readOperatorPacket(options));
  assertOperatorSource(packet.operatorCommitSha);
  const base = { schemaVersion: 1, kind: "dev-public-release-pause-recovery-result", packetDigest: options.packetDigest,
    mode: options.mode, operationId: packet.attempt.pauseAttempt.operationId, attemptDigest: p.publicReleaseDigest(packet.attempt),
    acceptedWorkChanged: 0, providerWrites: 0 };
  if (options.mode === "plan") return { ...base, authorityReads: 0, authorityWrites: 0 };
  signal?.throwIfAborted();
  const account = operatorAccount(await readServiceAccount(), packet.credentialIdentity);
  signal?.throwIfAborted();
  const connection = await openDatabase(account);
  try {
    signal?.throwIfAborted();
    return { ...base, ...await (options.mode === "readback" ? owner.readDevPublicReleasePauseRecovery : owner.recoverDevPublicReleasePause)(
      { firestore: connection.firestore, attempt: packet.attempt }) };
  } finally { await connection.close(); }
}
