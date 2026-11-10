import { deploymentEmail } from "./deployment-settings.mjs";
import { developmentInstallCredential } from './development-install-credentials.mjs';
import { assertDevelopmentRehearsalEnvironment } from './development-rehearsal-credentials.mjs';
import { parseOperatorCredentialIdentity, operatorAccount, openOperatorDatabase, operatorRefused } from './public-release-operator-io.mjs';

/** The packet contains only the existing public operator identity/source fields. */
export function parseDevelopmentInstallSdkPacket(packet) {
  if (!packet || Object.keys(packet).sort().join() !== 'credentialIdentity,kind,operatorCommitSha,schemaVersion' ||
      packet.schemaVersion !== 1 || packet.kind !== 'development-install-sdk' ||
      !/^[a-f0-9]{40}$/.test(packet.operatorCommitSha ?? '')) operatorRefused();
  const identity = parseOperatorCredentialIdentity(packet.credentialIdentity, 'development');
  if (identity.clientEmail !== deploymentEmail("CMS_DEV_SDK_CLIENT_EMAIL")) operatorRefused();
  return packet;
}

export async function openDevelopmentInstallSdk(packet, fd) {
  parseDevelopmentInstallSdkPacket(packet);
  assertDevelopmentRehearsalEnvironment();
  const pipe = developmentInstallCredential(fd, raw => operatorAccount(raw, packet.credentialIdentity));
  try { return await openOperatorDatabase(await pipe.read()); }
  finally { pipe.close(); }
}
