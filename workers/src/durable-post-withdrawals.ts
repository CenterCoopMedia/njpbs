import { isServerMintableSlugShape as isPublicContentSlug } from "../../packages/content-core/src/post-slugs";

export const WITHDRAWAL_MANIFEST_BYTES = 1024 * 1024;
export const WITHDRAWAL_MANIFEST_POSTS = 2500;
export const WITHDRAWAL_MANIFEST_SLUGS = 10000;
/** Marks a 503 caused by unknown durable withdrawal state; callers never replace it with a static copy. */
export const WITHDRAWAL_UNKNOWN_HEADER = "x-njpbs-withdrawal-state";

export type Withdrawal = {
  postId: string;
  operationId: string;
  sourceVersion: number;
  revision: number;
  ownedSlugs: string[];
  verifiedAt: number;
};
export type WithdrawalManifest = {
  schemaVersion: 1;
  workerName: string;
  contextRevision: number;
  withdrawals: Withdrawal[];
};
export type WithdrawalObject = {
  etag: string;
  size: number;
  body: ReadableStream<Uint8Array>;
};
export type WithdrawalReader = { get(key: string): Promise<WithdrawalObject | null> };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}
function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
function refuse(): never { throw new Error("Durable withdrawal manifest is invalid or exceeds its limit"); }

export function withdrawalManifestKey(workerName: string): string {
  if (!["njpbs-production", "template-dev-public"].includes(workerName)) refuse();
  return `post-withdrawals/${workerName}/catalog-v1.json`;
}

export function validateWithdrawalManifest(value: unknown, workerName: string): WithdrawalManifest {
  withdrawalManifestKey(workerName);
  if (!record(value) || !exactKeys(value, ["schemaVersion", "workerName", "contextRevision", "withdrawals"]) ||
      value.schemaVersion !== 1 || value.workerName !== workerName || !positive(value.contextRevision) ||
      !Array.isArray(value.withdrawals) || value.withdrawals.length > WITHDRAWAL_MANIFEST_POSTS) refuse();
  const posts = new Set<string>(), slugs = new Set<string>();
  const withdrawals = (value.withdrawals as unknown[]).map(raw => {
    if (!record(raw) || !exactKeys(raw, ["postId", "operationId", "sourceVersion", "revision", "ownedSlugs", "verifiedAt"]) ||
        typeof raw.postId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(raw.postId) || posts.has(raw.postId) ||
        typeof raw.operationId !== "string" || !/^[A-Za-z0-9]{20}$/.test(raw.operationId) ||
        !positive(raw.sourceVersion) || !positive(raw.revision) || !positive(raw.verifiedAt) || !Array.isArray(raw.ownedSlugs) ||
        !raw.ownedSlugs.length || raw.ownedSlugs.length > 100) refuse();
    posts.add(raw.postId as string);
    const ownedSlugs = (raw.ownedSlugs as unknown[]).map(slug => {
      if (typeof slug !== "string" || !isPublicContentSlug(slug) || slugs.has(slug)) refuse();
      slugs.add(slug as string);
      if (slugs.size > WITHDRAWAL_MANIFEST_SLUGS) refuse();
      return slug as string;
    }).sort();
    return { postId: raw.postId, operationId: raw.operationId, sourceVersion: raw.sourceVersion, revision: raw.revision,
      ownedSlugs, verifiedAt: raw.verifiedAt } as Withdrawal;
  }).sort((left, right) => left.postId.localeCompare(right.postId));
  return { schemaVersion: 1, workerName, contextRevision: value.contextRevision as number, withdrawals };
}

export function encodeWithdrawalManifest(value: unknown, workerName: string): string {
  const text = JSON.stringify(validateWithdrawalManifest(value, workerName));
  if (new TextEncoder().encode(text).byteLength > WITHDRAWAL_MANIFEST_BYTES) refuse();
  return text;
}

export async function readWithdrawalObject(object: WithdrawalObject, workerName: string,
  signal?: AbortSignal): Promise<WithdrawalManifest> {
  return validateWithdrawalManifest(await readWithdrawalValue(object, signal), workerName);
}

export async function readWithdrawalValue(object: WithdrawalObject, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) { await object.body.cancel(); refuse(); }
  if (!Number.isSafeInteger(object.size) || object.size < 1 || object.size > WITHDRAWAL_MANIFEST_BYTES) {
    await object.body.cancel(); refuse();
  }
  const reader = object.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > WITHDRAWAL_MANIFEST_BYTES) refuse();
      chunks.push(value);
    }
  } finally { signal?.removeEventListener("abort", cancel); await reader.cancel(); }
  if (signal?.aborted) refuse();
  if (length !== object.size) refuse();
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/** Tombstones never expire or clear. A newer visible publication may serve
 * only through reachable authority; an outage keeps the durable absence.
 * Missing storage or a missing catalog reads as no withdrawal. A present but
 * unreadable catalog, an R2 error or a timeout rejects: withdrawal state is unknown. */
export async function readDurablePostWithdrawal(store: WithdrawalReader | undefined, workerName: string,
  slug: string): Promise<Withdrawal | null> {
  if (!store || !isPublicContentSlug(slug)) return null;
  return readKnownDurableWithdrawal(store, async (reader, signal) => {
    const object = await reader.get(withdrawalManifestKey(workerName));
    if (!object) return null;
    const manifest = await readWithdrawalObject(object, workerName, signal);
    return manifest.withdrawals.find(entry => entry.ownedSlugs.includes(slug)) ?? null;
  });
}

/** Every public withdrawal reader shares this 500 ms bound. Unreadable storage
 * rejects instead of reading as absence. */
export async function readKnownDurableWithdrawal<T>(store: WithdrawalReader | undefined,
  load: (reader: WithdrawalReader, signal: AbortSignal) => Promise<T | null>): Promise<T | null> {
  if (!store) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    return await Promise.race([
      load(store, controller.signal),
      new Promise<never>((_, reject) => { timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Durable withdrawal read timed out"));
      }, 500); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
