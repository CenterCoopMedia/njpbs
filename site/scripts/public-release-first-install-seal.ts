import { preparePublicWorkerArtifact, type PreparedPublicWorkerArtifact } from '../src/lib/public-worker-artifact';
import { assertContextMatchesPublication } from '../src/lib/retained-public-context';
import { publicationFromPrepared } from '../src/lib/public-publication-receipt';
import { derivePublicReleasePairCodePack } from './public-release-pair-code-pack';
import { verifyPublicReleasePairRenderer } from './public-release-pair-renderer-release.mjs';
import { firstInstallFile as file, firstInstallRefused as refuse } from './public-release-first-install-files';
import type { PublicArtifactInventoryReceipt } from '../src/lib/public-artifact-inventory';
import path from 'node:path';
import { firstInstallPublicationTarget } from '../../functions/lib/public-release-first-install-target.js';

/** The first seal derives only from actual full-build files. It never accepts
 * a code digest, pack member roster or a preexisting prepared receipt. */
export async function sealFirstInstallPairCodePack(options: { commitSha: string; rendererDigest: string;
  environment?: 'development' | 'production';
  sourceInputs: Uint8Array; distDirectory: string; compiledDirectory: string; directory: string;
  artifactReceipt: PublicArtifactInventoryReceipt }) {
  const target = firstInstallPublicationTarget(options.environment ?? 'development');
  if (options.artifactReceipt.commitSha !== options.commitSha ||
      !Buffer.from(options.sourceInputs).equals(await file(options.compiledDirectory, 'pair-source-inputs.json'))) refuse();
  await verifyPublicReleasePairRenderer(options.compiledDirectory, { commitSha: options.commitSha,
    environment: target.environment, rendererDigest: options.rendererDigest });
  const preparedArtifact: PreparedPublicWorkerArtifact = await preparePublicWorkerArtifact({ artifactReceipt: options.artifactReceipt,
    distDirectory: options.distDirectory, outputPath: path.join(options.directory, 'prepared-worker.json') });
  const context = JSON.parse((await file(options.directory, 'public-context.json')).toString('utf8'));
  assertContextMatchesPublication(context, publicationFromPrepared(preparedArtifact));
  const pack = await derivePublicReleasePairCodePack({ pair: { commitSha: options.commitSha, rendererDigest: options.rendererDigest },
    distDirectory: options.distDirectory, compiledDirectory: options.compiledDirectory, preparedArtifact });
  for (const member of pack.manifest.members) await pack.readMember(member.path);
  return { preparedArtifact, pack };
}
