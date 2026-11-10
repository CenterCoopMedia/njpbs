import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import protocol from '../../functions/lib/public-release-pair.js';
import work from '../../functions/lib/public-release-pair-work.js';
import targets from '../../functions/lib/publication-target.js';
import r2 from '../../functions/lib/r2-media.js';
import { assertInitialPairEnvironment } from './initial-pair-environment.mjs';

const require = createRequire(new URL('../../site/package.json', import.meta.url));
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { require: typedRequire } = require('tsx/cjs/api');
const { withinReaderDeadline } = typedRequire('../../site/scripts/public-release-pair-reader-contract.ts', import.meta.url);
const { QUALIFICATION_EVIDENCE_ROOT_BYTES_LIMIT: limit } = typedRequire('../../site/scripts/public-release-pair-qualification-evidence.ts', import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
const refuse = () => { throw new Error('Rehearsal qualification evidence storage refused'); };

/** This is a storage boundary, never a qualification writer. The actual
 * native qualification owner creates/verifies every evidence body and its
 * SDK receipt. No overwrite, list, delete, arbitrary bucket or destination.
 */
export function createPairQualificationStore({ pairs: raw, reads, readCredential, signal, environment,
  authorized = false, client: supplied } = {}) {
  if (authorized !== true || !Array.isArray(raw) || raw.length !== 2 || typeof reads?.get !== 'function' ||
      typeof readCredential !== 'function') refuse();
  const pairs = raw.map(protocol.parsePublicReleasePair);
  if (!['development', 'production'].includes(environment) || pairs[0].pairId === pairs[1].pairId || pairs.some(pair => pair.environment !== environment)) refuse();
  pairs.forEach(work.assertPrivatePairResources);
  const digests = new Set(pairs.map(protocol.publicReleaseDigest)), target = targets.publicationTarget(environment);
  let storage = supplied, opening, closed = false;
  const current = () => {
    assertInitialPairEnvironment(environment); signal?.throwIfAborted();
    if (closed) refuse();
  };
  current();
  return Object.freeze({
    async get(key) { current(); return reads.get(key); },
    async put(key, body, options) {
      current();
      const match = /^release-pair-qualifications\/v1\/([a-f0-9]{64})\/[a-f0-9]{64}\/(?:pages|roots)\/([a-f0-9]{64})\.json$/.exec(key ?? '');
      if (!match || !digests.has(match[1]) || !(body instanceof Uint8Array) || body.length < 1 || body.length > limit) refuse();
      protocol.exact(options, ['onlyIf', 'sha256', 'customMetadata']); protocol.exact(options.onlyIf, ['etagDoesNotMatch']);
      const metadata = options.customMetadata;
      protocol.exact(metadata, ['schemaversion', 'pairdigest', 'witnessdigest', 'bodydigest']);
      const digest = hash(body);
      if (options.onlyIf.etagDoesNotMatch !== '*' || options.sha256 !== digest || match[2] !== digest ||
          metadata.schemaversion !== '1' || metadata.pairdigest !== match[1] || metadata.bodydigest !== digest ||
          !protocol.digest(metadata.witnessdigest)) refuse();
      const deadline = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
      try {
        if (!storage) {
          opening ??= (async () => {
            const credential = await readCredential(); current(); deadline.throwIfAborted();
            protocol.exact(credential, ['accessKeyId', 'secretAccessKey']);
            if (typeof credential.accessKeyId !== 'string' || !credential.accessKeyId ||
                typeof credential.secretAccessKey !== 'string' || !credential.secretAccessKey) refuse();
            return new S3Client({ ...r2.r2ClientConfig({ endpoint: (process.env.CMS_MEDIA_R2_ENDPOINT ?? `https://${process.env.CLOUDFLARE_ACCOUNT_ID ?? ""}.r2.cloudflarestorage.com`),
              accessKeyId: credential.accessKeyId, secretAccessKey: credential.secretAccessKey }), maxAttempts: 1 });
          })();
          storage = await withinReaderDeadline(deadline, () => opening);
        }
        current(); deadline.throwIfAborted();
        await storage.send(new PutObjectCommand({ Bucket: target.publicationBucket, Key: key, Body: body,
          ContentLength: body.length, ContentType: 'application/octet-stream', CacheControl: 'private, no-store',
          Metadata: metadata, IfNoneMatch: '*' }), { abortSignal: deadline });
      } catch (error) { if (!r2.isConditionalConflict(error)) refuse(); }
      // Even a 412 is followed by the native owner's exact full readback.
      current();
    },
    close() { closed = true; if (!supplied) storage?.destroy(); },
  });
}
