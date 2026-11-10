import { deploymentEmail } from "./deployment-settings.mjs";
import p from "../../functions/lib/public-release-pair.js";
import owner from "./dev-public-predecessor.cjs";
import { developmentInstallCredential } from "./development-install-credentials.mjs";
import { assertDevelopmentRehearsalEnvironment } from "./development-rehearsal-credentials.mjs";
import { operatorRefused as refuse, parseOperatorArgs, readOperatorPacket, assertOperatorSource,
  parseOperatorCredentialIdentity, operatorAccount, openOperatorDatabase } from "./public-release-operator-io.mjs";

export function parseDevPublicPredecessorPacket(value) {
  p.exact(value, ["schemaVersion", "kind", "step", "operatorCommitSha", "credentialIdentity", "request"]);
  if (value.schemaVersion !== 1 || value.kind !== "dev-public-predecessor-operator" ||
      !["runtime", "media-lifecycle"].includes(value.step) || !/^[a-f0-9]{40}$/.test(value.operatorCommitSha ?? "")) refuse();
  owner.parseRequest(value.request);
  parseOperatorCredentialIdentity(value.credentialIdentity, "development");
  if (value.credentialIdentity.clientEmail !== deploymentEmail("CMS_DEV_SDK_CLIENT_EMAIL")) refuse();
  return p.freeze(structuredClone(value));
}
export async function runDevPublicPredecessorOperator(args) {
  const options = parseOperatorArgs(args);
  const packet = parseDevPublicPredecessorPacket(await readOperatorPacket(options));
  assertOperatorSource(packet.operatorCommitSha);
  assertDevelopmentRehearsalEnvironment();
  const base = { schemaVersion: 1, kind: "dev-public-predecessor-result", mode: options.mode, step: packet.step,
    packetDigest: options.packetDigest, requestDigest: p.publicReleaseDigest(packet.request), providerWrites: 0 };
  if (options.mode === "plan") return { ...base, authorityReads: 0, authorityWrites: 0 };
  const credential = developmentInstallCredential(3, raw => operatorAccount(raw, packet.credentialIdentity));
  let connection;
  try {
    connection = await openOperatorDatabase(await credential.read());
    const result = await (options.mode === "readback" ? owner.readDevPublicPredecessor : owner.initializeDevPublicPredecessor)(
      { firestore: connection.firestore, step: packet.step, request: packet.request });
    return { ...base, ...result };
  } finally { credential.close(); await connection?.close(); }
}
