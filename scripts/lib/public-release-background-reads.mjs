import { createRequire } from 'node:module';
import targets from '../../functions/lib/publication-target.js';
const require = createRequire(import.meta.url);

/** Provider dependency objects live in the SDK background bucket. Publication
 * R2 is a different read store for retained static/public artifact objects. */
export function createPublicReleaseBackgroundReads({ environment, app, signal }) {
  const target = targets.publicationTarget(environment);
  const original = require('../../functions/lib/post-background-storage.js').createPostBackgroundStorage(target.backgroundBucket, app);
  return { async get(key) {
    const deadline = AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]);
    const bytes = await original.get(key, { signal: deadline, maxBytes: 16 * 1024 * 1024 });
    return { size: bytes.length, body: new Response(new Uint8Array(bytes)).body };
  } };
}
