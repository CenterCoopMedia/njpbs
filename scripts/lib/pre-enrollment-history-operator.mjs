import p from "../../functions/lib/public-release-pair.js";
import owner from "../../functions/lib/pre-enrollment-history.js";
import { operatorRefused as refuse, parseOperatorArgs, readOperatorPacket, assertOperatorSource,
  parseOperatorCredentialIdentity, operatorCredentialStream, operatorAccount, openOperatorDatabase } from "./public-release-operator-io.mjs";

export async function runPreEnrollmentHistoryOperator(args, { readServiceAccount = operatorCredentialStream(3),
  openDatabase = openOperatorDatabase } = {}) {
  const options = parseOperatorArgs(args);
  if (options.mode === "readback") refuse();
  const packet = await readOperatorPacket(options);
  p.exact(packet, ["schemaVersion", "kind", "operatorCommitSha", "credentialIdentity", "request", "operatorReceipt"]);
  if (packet.schemaVersion !== 1 || packet.kind !== "pre-enrollment-history-operator") refuse();
  owner.parseRequest(packet.request);
  parseOperatorCredentialIdentity(packet.credentialIdentity, packet.request.target.environment);
  if (options.mode === "apply") owner.parseReceipt(packet.operatorReceipt, packet.request);
  else if (packet.operatorReceipt !== null) refuse();
  assertOperatorSource(packet.operatorCommitSha);
  const account = operatorAccount(await readServiceAccount(), packet.credentialIdentity);
  const connection = await openDatabase(account);
  try {
    const result = options.mode === "apply" ? await owner.retirePreEnrollmentHistory({ firestore: connection.firestore,
      request: packet.request, operatorReceipt: packet.operatorReceipt }) :
      await owner.listPreEnrollmentHistory({ firestore: connection.firestore, request: packet.request });
    return { mode: options.mode === "plan" ? "list" : "apply", packetDigest: options.packetDigest, ...result };
  } finally { await connection.close(); }
}
