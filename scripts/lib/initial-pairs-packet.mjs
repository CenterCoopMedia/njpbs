import path from 'node:path';
import protocol from '../../functions/lib/public-release-pair.js';
import work from '../../functions/lib/public-release-pair-work.js';
import { parseOperatorCredentialIdentity, operatorRefused as refuse } from './public-release-operator-io.mjs';
import { initialPairNative } from './initial-pair-native.mjs';
const { assertPreparedPublicWorkerArtifact } = initialPairNative('../../site/src/lib/public-publication-receipt.ts', import.meta.url);
const { qualificationReceiptPath } = initialPairNative('../../site/scripts/public-release-pair-qualification-receipt.ts', import.meta.url);
export function parseInitialPairsPacket(raw, environment) {
  protocol.exact(raw, ['schemaVersion', 'kind', 'operatorCommitSha', 'credentialIdentity', 'step', 'bootstrapOperationId',
    'enrollmentRequestDigest', 'currentPair', 'recoveryPair', 'artifacts', 'qualificationIds']);
  if (raw.schemaVersion !== 1 || !['development', 'production'].includes(environment) || raw.kind !== `${environment}-initial-pairs` || !/^[a-f0-9]{40}$/.test(raw.operatorCommitSha ?? '') ||
      !['old-code', 'stage', 'qualify'].includes(raw.step) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(raw.bootstrapOperationId ?? '') ||
      !protocol.digest(raw.enrollmentRequestDigest)) refuse();
  parseOperatorCredentialIdentity(raw.credentialIdentity, environment);
  const pairs = [raw.currentPair, raw.recoveryPair].map(protocol.parsePublicReleasePair);
  pairs.forEach(work.assertPrivatePairResources);
  if (pairs.some(pair => pair.environment !== environment) || pairs[0].pairId === pairs[1].pairId ||
      !Array.isArray(raw.artifacts) || raw.artifacts.length !== 2 ||
      !Array.isArray(raw.qualificationIds) || raw.qualificationIds.length !== 2 || raw.qualificationIds[0] === raw.qualificationIds[1]) refuse();
  raw.artifacts.forEach((artifact, index) => {
    protocol.exact(artifact, ['distDirectory', 'compiledDirectory', 'preparedArtifact', 'publicContextPath']);
    for (const key of ['distDirectory', 'compiledDirectory', 'publicContextPath']) if (typeof artifact[key] !== 'string' || !path.isAbsolute(artifact[key])) refuse();
    const prepared = assertPreparedPublicWorkerArtifact(artifact.preparedArtifact);
    if (prepared.commitSha !== pairs[index].commitSha) refuse();
    // Use the native qualification identity grammar, without creating a receipt.
    qualificationReceiptPath(pairs[index], raw.qualificationIds[index]);
  });
  return protocol.freeze(structuredClone(raw));
}
