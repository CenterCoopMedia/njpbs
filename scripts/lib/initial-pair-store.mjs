import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import protocol from '../../functions/lib/public-release-pair.js';
import work from '../../functions/lib/public-release-pair-work.js';
import targets from '../../functions/lib/publication-target.js';
import r2 from '../../functions/lib/r2-media.js';
import { assertInitialPairEnvironment } from './initial-pair-environment.mjs';
import { createPairQualificationStore } from './pair-qualification-store.mjs';
const require = createRequire(new URL('../../site/package.json', import.meta.url));
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { require: typedRequire } = require('tsx/cjs/api');
const { withinReaderDeadline } = typedRequire('../../site/scripts/public-release-pair-reader-contract.ts', import.meta.url);
const refuse = () => { throw new Error('Development initial storage refused'); };

/** Only native immutable H/replay writes and qualification evidence. G belongs
 * to installed runtimes. No overwrite, delete, list or caller-selected bucket. */
export function createInitialPairStore({ pairs: raw, reads, readCredential, signal, client: supplied, environment }) {
  const pairs = raw.map(protocol.parsePublicReleasePair);
  if (!['development', 'production'].includes(environment) || pairs.length !== 2 || pairs[0].pairId === pairs[1].pairId || pairs.some(pair => pair.environment !== environment)) refuse();
  pairs.forEach(work.assertPrivatePairResources);
  const allowed = pairs.flatMap(pair => [`release-pair-inputs/v2/${pair.pairId}/`, `release-pairs/${pair.pairId}/`,
    `release-pair-replay/v2/${protocol.publicReleaseDigest(pair)}/`, `release-pair-qualifications/v1/${protocol.publicReleaseDigest(pair)}/`]);
  const target = targets.publicationTarget(environment);
  allowed.push(`public-content-baseline/v1/${target.workerName}/`);
  let client = supplied, opening, closed = false;
  const current = () => { assertInitialPairEnvironment(environment); signal?.throwIfAborted(); if (closed) refuse(); };
  const get = key => {
    current();
    if (typeof key !== 'string' || key.includes('..') || !allowed.some(prefix => key.startsWith(prefix))) refuse();
    return reads.getWithSignal(key, AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]));
  };
  const evidence = createPairQualificationStore({ environment, pairs, reads: { get }, readCredential, signal, authorized: true, client: supplied });
  return {
    get,
    async put(key, bytes, options) {
      current();
      if (key.startsWith('release-pair-qualifications/')) return evidence.put(key, bytes, options);
      const pair = pairs.find(pair => key.startsWith(`release-pair-inputs/v2/${pair.pairId}/`) ||
        key.startsWith(`release-pair-replay/v2/${protocol.publicReleaseDigest(pair)}/`));
      if (!pair || !(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > 16 * 1024 * 1024) refuse();
      const prefix = key.startsWith('release-pair-inputs/') ? `release-pair-inputs/v2/${pair.pairId}/`
        : `release-pair-replay/v2/${protocol.publicReleaseDigest(pair)}/`;
      const suffix = key.slice(prefix.length);
      if (!(key.startsWith('release-pair-inputs/') ? /^(objects|manifests)\/[a-f0-9]{64}\.json$/
        : /^(pages|selections)\/[a-f0-9]{64}\.json$/).test(suffix)) refuse();
      protocol.exact(options, ['onlyIf', 'sha256', 'customMetadata']); protocol.exact(options.onlyIf, ['etagDoesNotMatch']);
      protocol.exact(options.customMetadata, ['schemaversion', 'pairdigest', 'bodydigest']);
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (options.onlyIf.etagDoesNotMatch !== '*' || options.sha256 !== digest || !key.endsWith(`/${digest}.json`) ||
          options.customMetadata.schemaversion !== '2' || options.customMetadata.pairdigest !== protocol.publicReleaseDigest(pair) ||
          options.customMetadata.bodydigest !== digest) refuse();
      const deadline = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
      try {
        if (!client) {
          opening ??= readCredential().then(credential => { current(); deadline.throwIfAborted();
            return new S3Client({ ...r2.r2ClientConfig({ endpoint: (process.env.CMS_MEDIA_R2_ENDPOINT ?? `https://${process.env.CLOUDFLARE_ACCOUNT_ID ?? ""}.r2.cloudflarestorage.com`),
              accessKeyId: credential.accessKeyId, secretAccessKey: credential.secretAccessKey }), maxAttempts: 1 }); });
          client = await withinReaderDeadline(deadline, () => opening);
        }
        current(); deadline.throwIfAborted();
        await client.send(new PutObjectCommand({ Bucket: target.publicationBucket, Key: key, Body: bytes, ContentLength: bytes.length,
          ContentType: 'application/octet-stream', CacheControl: 'private, no-store', Metadata: options.customMetadata, IfNoneMatch: '*' }), { abortSignal: deadline });
      } catch (error) { if (!r2.isConditionalConflict(error)) refuse(); }
      // Native writers always exhaust and validate their own full readback.
      current();
    },
    close() { closed = true; evidence.close(); if (!supplied) client?.destroy(); },
  };
}
