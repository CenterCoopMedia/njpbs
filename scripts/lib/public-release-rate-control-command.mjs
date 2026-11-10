import { produceIngressRateControls, ingressRateEvidenceConfiguration } from "./public-release-rate-control-evidence.mjs";
import { parseOperatorArgs, readOperatorPacket, assertOperatorSource, operatorCredentialStream, operatorAccount, openOperatorDatabase,
  operatorRefused as refuse } from "./public-release-operator-io.mjs";

export async function runIngressRateEvidenceOperator(args) {
  let database;
  try {
    const options = parseOperatorArgs(args);
    if (options.mode === "readback") refuse();
    const packet = await readOperatorPacket(options), { request, packet: ingress } = ingressRateEvidenceConfiguration(packet);
    assertOperatorSource(request.operatorCommitSha);
    if (options.mode === "plan") return produceIngressRateControls({ packet });
    // Open inherited credential pipes only after packet and source validation.
    const account = operatorAccount(await operatorCredentialStream(3)(), ingress.credentialIdentity);
    database = await openOperatorDatabase(account);
    return await produceIngressRateControls({ firestore: database.firestore, packet, readToken: operatorCredentialStream(0), apply: true });
  } finally { await database?.close(); }
}
