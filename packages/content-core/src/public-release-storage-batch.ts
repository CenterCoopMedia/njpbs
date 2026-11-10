import { Buffer } from "node:buffer";

export const PAIR_STORAGE_BATCH_PATH = "/_batch/v1";
export const PAIR_STORAGE_BATCH_LIMIT = 4;
export const PAIR_STORAGE_BATCH_BODY_LIMIT = 1024 * 1024;
export const PAIR_STORAGE_BATCH_JSON_LIMIT = 6 * 1024 * 1024;
export type PairStorageBatchItem = { key: string; body?: Uint8Array<ArrayBuffer>; customMetadata?: Record<string, string> };
export type PairStorageBatchResult = { key: string; status: number; size?: number;
  body?: Uint8Array<ArrayBuffer>; customMetadata?: Record<string, string> };

function refuse(): never { throw new Error("Private storage batch differs"); }
function object(value: unknown): value is Record<string, any> { return !!value && typeof value === "object" && !Array.isArray(value); }
function exact(value: unknown, names: string[]): asserts value is Record<string, any> {
  if (!object(value) || Object.keys(value).sort().join() !== [...names].sort().join()) refuse();
}
function key(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 1024; }
export function pairStorageBatchMetadata(value: unknown): value is Record<string, string> {
  return object(value) && Object.values(value).every(item => typeof item === "string") && JSON.stringify(value).length <= 4096;
}
function decode(value: unknown) {
  if (typeof value !== "string" || value.length > Math.ceil(PAIR_STORAGE_BATCH_BODY_LIMIT / 3) * 4) refuse();
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > PAIR_STORAGE_BATCH_BODY_LIMIT || bytes.toString("base64") !== value) refuse();
  // Copy into an owned ArrayBuffer; no Buffer slab/shared backing escapes.
  return new Uint8Array(bytes);
}
function entries(value: unknown): any[] {
  exact(value, ["schemaVersion", "items"]);
  if (value.schemaVersion !== 1 || !Array.isArray(value.items) || value.items.length < 2 || value.items.length > PAIR_STORAGE_BATCH_LIMIT) refuse();
  if (value.items.some((item: any) => !object(item) || !key(item.key)) || new Set(value.items.map((item: any) => item.key)).size !== value.items.length) refuse();
  return value.items;
}
export function parsePairStorageBatchRequest(value: unknown, write: boolean): PairStorageBatchItem[] {
  return entries(value).map(item => {
    exact(item, write ? ["key", "bodyBase64", "customMetadata"] : ["key"]);
    if (!write) return { key: item.key };
    if (!pairStorageBatchMetadata(item.customMetadata)) refuse();
    return { key: item.key, body: decode(item.bodyBase64), customMetadata: item.customMetadata };
  });
}
export function encodePairStorageBatchRequest(items: PairStorageBatchItem[], write: boolean) {
  return JSON.stringify({ schemaVersion: 1, items: items.map(item => write
    ? { key: item.key, bodyBase64: Buffer.from(item.body!).toString("base64"), customMetadata: item.customMetadata }
    : { key: item.key }) });
}
export function encodePairStorageBatchResult(items: PairStorageBatchResult[]) {
  return JSON.stringify({ schemaVersion: 1, items: items.map(item => item.status === 200
    ? { key: item.key, status: item.status, size: item.size, customMetadata: item.customMetadata,
      bodyBase64: Buffer.from(item.body!).toString("base64") }
    : { key: item.key, status: item.status }) });
}
export function parsePairStorageBatchResult(value: unknown, keys: string[], write: boolean): PairStorageBatchResult[] {
  const items = entries(value);
  if (items.length !== keys.length) refuse();
  return items.map((item, index) => {
    if (item.key !== keys[index]) refuse();
    if (write ? ![201, 412, 403, 503].includes(item.status) : ![200, 404, 403, 413, 503].includes(item.status)) refuse();
    exact(item, item.status === 200 ? ["key", "status", "size", "customMetadata", "bodyBase64"] : ["key", "status"]);
    if (item.status !== 200) return { key: item.key, status: item.status };
    // The original H/G byte reader still owns mismatched length and digest.
    if (!Number.isSafeInteger(item.size) || item.size < 0 || item.size > 16 * 1024 * 1024 || !pairStorageBatchMetadata(item.customMetadata)) refuse();
    return { key: item.key, status: 200, size: item.size, body: decode(item.bodyBase64), customMetadata: item.customMetadata };
  });
}

/** Require the declared bound before allocation and consume the complete body.
 * Stream failures propagate to their transport owner; malformed data refuses. */
export async function readPairStorageBytes(message: Request | Response, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const size = Number(message.headers.get("content-length"));
  if (!message.headers.has("content-length") || !Number.isSafeInteger(size) || size < 0 || size > limit || size > 0 && !message.body) {
    void message.body?.cancel().catch(() => {}); return null;
  }
  const bytes = new Uint8Array(size), reader = message.body?.getReader(); let total = 0;
  if (reader) try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      if (total + chunk.value.byteLength > size) return null;
      bytes.set(chunk.value, total); total += chunk.value.byteLength;
    }
  } finally { void reader.cancel().catch(() => {}); }
  return total === size ? bytes : null;
}
export async function readPairStorageBatchJson(message: Request | Response) {
  const bytes = await readPairStorageBytes(message, PAIR_STORAGE_BATCH_JSON_LIMIT);
  if (!bytes) return null;
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return null; }
}
