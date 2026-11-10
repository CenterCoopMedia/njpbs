import { deploymentEmail } from "./deployment-settings.mjs";
import p from "../../functions/lib/public-release-pair.js";
import owner from "./dev-publication-history.cjs";
import history from "../../functions/lib/dev-publication-history.js";
import { developmentInstallCredential } from "./development-install-credentials.mjs";
import { assertDevelopmentRehearsalEnvironment } from "./development-rehearsal-credentials.mjs";
import { operatorRefused as refuse, parseOperatorArgs, readOperatorPacket, assertOperatorSource,
  parseOperatorCredentialIdentity, operatorAccount, openOperatorDatabase } from "./public-release-operator-io.mjs";

export function parseDevPublicationHistoryPacket(value, { planning = false } = {}) {
  p.exact(value, ["schemaVersion", "kind", "operatorCommitSha", "credentialIdentity", "request"]);
  if (value.schemaVersion !== 1 || value.kind !== "dev-publication-history-operator" ||
      !/^[a-f0-9]{40}$/.test(value.operatorCommitSha ?? "")) refuse();
  history.parseRequest(value.request, { planning });
  parseOperatorCredentialIdentity(value.credentialIdentity, "development");
  if (value.credentialIdentity.clientEmail !== deploymentEmail("CMS_DEV_SDK_CLIENT_EMAIL")) refuse();
  return p.freeze(structuredClone(value));
}
export async function runDevPublicationHistoryOperator(args) {
  const options = parseOperatorArgs(args);
  const packet = parseDevPublicationHistoryPacket(await readOperatorPacket(options), { planning: options.mode === "plan" });
  assertOperatorSource(packet.operatorCommitSha);
  assertDevelopmentRehearsalEnvironment();
  const base = { schemaVersion: 1, kind: "dev-publication-history-result", mode: options.mode,
    packetDigest: options.packetDigest, requestDigest: history.digest(packet.request), providerWrites: 0 };
  const credential = developmentInstallCredential(3, raw => operatorAccount(raw, packet.credentialIdentity));
  let connection;
  try {
    connection = await openOperatorDatabase(await credential.read());
    const result = await (options.mode === "plan" ? owner.plan : owner.operate)({ firestore: connection.firestore, request: packet.request,
      operatorCommitSha: packet.operatorCommitSha, readOnly: options.mode === "readback" });
    return { ...base, ...result };
  } finally { credential.close(); await connection?.close(); }
}
