import p from "../../functions/lib/public-release-pair.js";
import owner from "../../functions/lib/dev-public-release-pause.js";
import { operatorRefused as refuse, parseOperatorArgs, readOperatorPacket, assertOperatorSource,
  parseOperatorCredentialIdentity, operatorCredentialStream, operatorAccount, openOperatorDatabase } from "./public-release-operator-io.mjs";

export function parseDevPublicReleasePausePacket(value) {
  p.exact(value, ["schemaVersion", "kind", "operatorCommitSha", "credentialIdentity", "attempt"]);
  if (value.schemaVersion !== 1 || value.kind !== "dev-public-release-pause-operator" || !/^[a-f0-9]{40}$/.test(value.operatorCommitSha ?? "")) refuse();
  owner.parseDevPublicReleasePauseAttempt(value.attempt);
  parseOperatorCredentialIdentity(value.credentialIdentity, "development");
  return p.freeze(structuredClone(value));
}
export async function runDevPublicReleasePauseOperator(args, { readServiceAccount = operatorCredentialStream(3),
  openDatabase = openOperatorDatabase, signal } = {}) {
  const options = parseOperatorArgs(args);
  signal?.throwIfAborted();
  const packet = parseDevPublicReleasePausePacket(await readOperatorPacket(options));
  assertOperatorSource(packet.operatorCommitSha);
  const base = { schemaVersion: 1, kind: "dev-public-release-pause-result", packetDigest: options.packetDigest,
    mode: options.mode, operationId: packet.attempt.operationId, attemptDigest: p.publicReleaseDigest(packet.attempt),
    acceptedWorkChanged: 0, providerWrites: 0 };
  if (options.mode === "plan") return { ...base, authorityReads: 0, authorityWrites: 0 };
  signal?.throwIfAborted();
  const account = operatorAccount(await readServiceAccount(), packet.credentialIdentity);
  signal?.throwIfAborted();
  const connection = await openDatabase(account);
  try {
    signal?.throwIfAborted();
    return { ...base, ...await (options.mode === "readback" ? owner.readDevPublicReleasePause : owner.pauseDevPublicRelease)(
      { firestore: connection.firestore, attempt: packet.attempt }) };
  } finally { await connection.close(); }
}
