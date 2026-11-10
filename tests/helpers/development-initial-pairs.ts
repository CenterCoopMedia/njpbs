import { releasePair } from './private-public-release-pair.js';
export function initialPairsPacket() {
  const pairs = [releasePair(), releasePair('b', 'b'.repeat(40))];
  return { schemaVersion: 1, kind: 'development-initial-pairs', operatorCommitSha: 'a'.repeat(40),
    credentialIdentity: { projectId: 'njpbs-site-dev', clientEmail: 'install-operator@njpbs-site-dev.iam.gserviceaccount.com',
      privateKeyId: 'c'.repeat(40), secretRef: 'pass://dev/install' }, step: 'qualify', bootstrapOperationId: 'original-bootstrap',
    enrollmentRequestDigest: 'd'.repeat(64), currentPair: pairs[0], recoveryPair: pairs[1], qualificationIds: ['initial-old', 'initial-new'],
    artifacts: pairs.map(pair => ({ distDirectory: '/protected/dist', compiledDirectory: '/protected/compiled', publicContextPath: '/protected/context.json',
      preparedArtifact: { schemaVersion: 1, digestAlgorithm: 'sha256', buildBatchId: 'original-build', generation: 1, commitSha: pair.commitSha,
        artifactDigest: 'a'.repeat(64), artifactReceiptDigest: 'b'.repeat(64), mediaManifestDigest: 'c'.repeat(64),
        publicationReceiptDigest: 'd'.repeat(64), artifactFileCount: 2, artifactBytes: 1 } })) };
}
