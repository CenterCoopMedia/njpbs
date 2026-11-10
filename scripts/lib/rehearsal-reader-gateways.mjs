import protocol from '../../functions/lib/public-release-pair.js';
import { parsePrivateBridgePacket, installPrivatePairBridge } from './public-release-private-bridge-operator.mjs';
import { parseRehearsalPacket, rehearsalSourceCommit } from './public-release-rehearsal.mjs';
import { readOnlyBootstrapFirestore } from './public-release-bootstrap-preflight.mjs';
import { assertDemoRehearsalEnvironment, assertDevelopmentRehearsalEnvironment } from './development-rehearsal-credentials.mjs';

const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
const refuse = () => { throw new Error('Installed rehearsal reader gateways refused'); };

/** Consume gap4's actual original-attempt readback for the two reader roles.
 * Its operator-only disabled-ingress rule does not apply to these roles.
 * Literal readback:true plus a readonly SDK facade prevents an install path.
 */
export async function readRehearsalReaderGateways({ firestore, packet: raw, gateways, readToken, sourceSha,
  signal, authorized = false, fetchImpl = fetch }) {
  const packet = parseRehearsalPacket(raw);
  if (authorized !== true || firestore?.projectId !== packet.projectId || typeof readToken !== 'function' ||
      !Array.isArray(gateways) || gateways.length !== 2 || rehearsalSourceCommit() !== sourceSha) refuse();
  if (packet.schemaVersion === 1) {
    assertDemoRehearsalEnvironment(packet); if (fetchImpl === fetch) refuse();
  } else {
    assertDevelopmentRehearsalEnvironment();
    if (packet.setupMode !== 'preinstalled' || fetchImpl !== fetch || ![undefined, 'development'].includes(process.env.CMS_DEPLOYMENT_ENVIRONMENT)) refuse();
  }
  const parsed = gateways.map(parsePrivateBridgePacket), pairs = [packet.oldPair, packet.newPair];
  parsed.forEach((value, index) => {
    if (value.role !== ['old-reader', 'new-reader'][index] || value.enabled !== true || !same(value.pairs, pairs) ||
        value.accessPacket.environment !== 'development' || value.credentialIdentity.projectId !== 'njpbs-site-dev') refuse();
  });
  if (!same(parsed[0].accessPacket, parsed[1].accessPacket)) refuse();
  const readonly = readOnlyBootstrapFirestore(firestore), results = [];
  for (const value of parsed) {
    signal?.throwIfAborted();
    const result = await installPrivatePairBridge({ firestore: readonly, packet: value, readToken, fetchImpl, signal, readback: true });
    if (result.operationId !== value.operationId || result.role !== value.role || result.enabled !== true ||
        result.domainClaimState !== 'observed' || !result.domain || result.sourceDigest !== value.sourceDigest) refuse();
    results.push(result);
  }
  if (rehearsalSourceCommit() !== sourceSha) refuse();
  return Object.freeze({ receiptDigest: protocol.publicReleaseDigest({ kind: 'installed-rehearsal-reader-gateways',
    projectId: packet.projectId, packets: parsed.map(protocol.publicReleaseDigest), results }) });
}
