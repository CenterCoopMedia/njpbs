import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import protocol from '../../functions/lib/public-release-pair.js';
import work from '../../functions/lib/public-release-pair-work.js';
import targets from '../../functions/lib/publication-target.js';
import r2 from '../../functions/lib/r2-media.js';
import { initialPairNative as native } from './initial-pair-native.mjs';
const { S3Client, PutObjectCommand } = createRequire(new URL('../../site/package.json', import.meta.url))('@aws-sdk/client-s3');
const { createBootstrapS3Reads } = native('../../site/scripts/public-release-bootstrap-s3-read.ts', import.meta.url);
const { withinReaderDeadline } = native('../../site/scripts/public-release-pair-reader-contract.ts', import.meta.url);
const { QUALIFICATION_EVIDENCE_ROOT_BYTES_LIMIT: limit } = native('../../site/scripts/public-release-pair-qualification-evidence.ts', import.meta.url);
const { committedRecoveryKey } = native('../../workers/src/public-release-recovery.ts', import.meta.url);
const refuse = () => { throw new Error('Production switch storage refused'); };

/** Fixed production bucket, native pair namespaces and conditional evidence
 * writes only. No source/render writes, overwrite, list, delete or rollout. */
export function createProductionSwitchStore({ pairs: raw, readCredential, signal, client: supplied, readOnly = false }) {
  const pairs = raw.map(protocol.parsePublicReleasePair);
  if (pairs.length !== 2 || pairs[0].pairId === pairs[1].pairId || pairs.some(pair => pair.environment !== 'production')) refuse();
  pairs.forEach(work.assertPrivatePairResources);
  const digests = pairs.map(protocol.publicReleaseDigest), target = targets.publicationTarget('production');
  const prefixes = pairs.flatMap((pair, index) => [`release-pair-inputs/v2/${pair.pairId}/`, `release-pairs/${pair.pairId}/`,
    `release-pair-replay/v2/${digests[index]}/`, `release-pair-qualifications/v1/${digests[index]}/`]);
  prefixes.push(`public-content-baseline/v1/${target.workerName}/`);
  const reads = createBootstrapS3Reads({ environment: 'production', readCredential, client: supplied });
  let client = supplied, opening, closed = false;
  const current = () => { signal?.throwIfAborted(); if (closed) refuse(); };
  return {
    get(key) {
      current();
      if (typeof key !== 'string' || key.includes('..') ||
          key !== committedRecoveryKey('production') && !prefixes.some(prefix => key.startsWith(prefix))) refuse();
      return reads.getWithSignal(key, AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]));
    },
    async put(key, body, options) {
      current();
      const match = /^release-pair-qualifications\/v1\/([a-f0-9]{64})\/[a-f0-9]{64}\/(?:pages|roots)\/([a-f0-9]{64})\.json$/.exec(key ?? '');
      if (readOnly || !match || !digests.includes(match[1]) || !(body instanceof Uint8Array) || body.length < 1 || body.length > limit) refuse();
      protocol.exact(options, ['onlyIf', 'sha256', 'customMetadata']); protocol.exact(options.onlyIf, ['etagDoesNotMatch']);
      protocol.exact(options.customMetadata, ['schemaversion', 'pairdigest', 'witnessdigest', 'bodydigest']);
      const digest = createHash('sha256').update(body).digest('hex'), metadata = options.customMetadata;
      if (options.onlyIf.etagDoesNotMatch !== '*' || options.sha256 !== digest || match[2] !== digest || metadata.schemaversion !== '1' ||
          metadata.pairdigest !== match[1] || metadata.bodydigest !== digest || !protocol.digest(metadata.witnessdigest)) refuse();
      const deadline = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
      try {
        if (!client) {
          opening ??= readCredential().then(credential => new S3Client({ ...r2.r2ClientConfig({
            endpoint: (process.env.CMS_MEDIA_R2_ENDPOINT ?? `https://${process.env.CLOUDFLARE_ACCOUNT_ID ?? ""}.r2.cloudflarestorage.com`), ...credential }), maxAttempts: 1 }));
          client = await withinReaderDeadline(deadline, () => opening);
        }
        current(); deadline.throwIfAborted();
        await client.send(new PutObjectCommand({ Bucket: target.publicationBucket, Key: key, Body: body, ContentLength: body.length,
          ContentType: 'application/octet-stream', CacheControl: 'private, no-store', Metadata: metadata, IfNoneMatch: '*' }), { abortSignal: deadline });
      } catch (error) { if (!r2.isConditionalConflict(error)) refuse(); }
      current(); // The native qualifier exhausts the exact full readback, even after 412.
    },
    close() { closed = true; reads.close(); if (!supplied) client?.destroy(); },
  };
}
