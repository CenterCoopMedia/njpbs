/** Preserve the public Worker's existing receipt identity byte-for-byte. Both
 * the live reader and a frozen pair use this recipe over their verified state. */
export async function publicPostReceiptIdentity(options: {
  posts: readonly { postId: string; [key: string]: unknown }[]; workerName: string; rendererSha: string;
  contextDigest: string; admissionRevision: number | null | undefined; generation: number;
  baseline: { buildBatchId: unknown; generation: unknown };
}) {
  const posts = [...options.posts].sort((a, b) => a.postId.localeCompare(b.postId));
  const bytes = new TextEncoder().encode(JSON.stringify([posts, options.workerName, options.rendererSha,
    options.contextDigest, options.admissionRevision, options.baseline.buildBatchId, options.baseline.generation]));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const identityDigest = Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("");
  return { schemaVersion: 1 as const, buildBatchId: `post-${identityDigest}`, generation: options.generation,
    commitSha: options.rendererSha, admissionRevision: options.admissionRevision };
}
