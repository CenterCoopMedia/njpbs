import { createHash } from "node:crypto";
import { contentLink } from "../../packages/content-core/src/content-link.ts";
import type { ContentLinkSearchRecord } from "../src/lib/content-link-search";
import { performance } from "node:perf_hooks";
import { MODEL_ID, MODEL_REVISION, DIMENSIONS, MAX_DOCUMENTS } from "../../packages/browser-search/contracts";
import { extractPassages, type SearchPassage } from "../src/search/passages";
import views from "../../functions/lib/public-release-pair-view.js";
import work from "../../functions/lib/public-release-pair-work.js";
type Passage = SearchPassage & { vector: number[] };
type Encoder = { modelLoadMs: number; encode(input: string): Promise<number[]>; dispose(): Promise<unknown> };
export class PairSemanticIndexError extends work.PairExecutionError {
  constructor(readonly reason: "semantic-baseline-mismatch" | "semantic-model-revision-mismatch" | "semantic-vector-mismatch") {
    super("input-unavailable"); this.name = "PairSemanticIndexError";
  }
}
function refuse(reason: PairSemanticIndexError["reason"] = "semantic-baseline-mismatch"): never { throw new PairSemanticIndexError(reason); }
const input = (passage: Pick<Passage, "title" | "text">) => `${passage.title}\n${passage.text}`;
const validVector = (vector: unknown): vector is number[] => Array.isArray(vector) && vector.length === DIMENSIONS && vector.every(value => typeof value === "number" && Number.isFinite(value));
function baseline(bytes: Uint8Array) {
  if (bytes.length > views.BODY_BYTES_LIMIT) refuse();
  let value: any;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return refuse(); }
  if (!value || Object.keys(value).sort().join() !== "model,passages,revision,version" || value.version !== 1 || !Array.isArray(value.passages) || value.passages.length > MAX_DOCUMENTS) refuse();
  if (value.model !== MODEL_ID || value.revision !== MODEL_REVISION) refuse("semantic-model-revision-mismatch");
  const cache = new Map<string, number[]>();
  for (const passage of value.passages) {
    if (!passage || Object.keys(passage).filter(key => !["contentLinkUrl", "contentLinkNewTab"].includes(key)).sort().join() !== "id,text,title,url,vector" || typeof passage.id !== "string" || !/^[a-f0-9]{24}$/.test(passage.id) ||
        typeof passage.url !== "string" || !passage.url.startsWith("/") || passage.url.startsWith("//") || passage.url.includes("\\") ||
        typeof passage.title !== "string" || typeof passage.text !== "string" || !validVector(passage.vector)) refuse();
    const key = input(passage), before = cache.get(key);
    if (before && JSON.stringify(before) !== JSON.stringify(passage.vector)) refuse("semantic-vector-mismatch");
    cache.set(key, [...passage.vector]);
  }
  return cache;
}
/** The baseline body is already opened from the original immutable code pack.
 * Reuse requires identical full encoder input and model revision, never just a
 * passage ID. New metadata and the complete passage roster always come from
 * NEW admitted HTML. Encoding is lazy, pinned and local to the offline child. */
export async function buildPublicReleasePairSemanticIndex(options: { contentLinks?: readonly ContentLinkSearchRecord[]; html: AsyncIterable<{ path: string; bytes: Uint8Array }>;
  baselineBytes: Uint8Array; priorBytes?: Uint8Array; createEncoder(): Promise<Encoder> }) {
  let cache = baseline(options.baselineBytes);
  // A prior complete roster may supply exact inputs from a newer same-pair
  // publication. Doubt about this optional computation cache means fresh encode.
  if (options.priorBytes) {
    try {
      const prior = baseline(options.priorBytes);
      for (const [key, vector] of prior) {
        const before = cache.get(key);
        if (before && JSON.stringify(before) !== JSON.stringify(vector)) refuse("semantic-vector-mismatch");
        cache.set(key, vector);
      }
    } catch { cache.clear(); }
  }
  const passages: Passage[] = [], seen = new Set<string>(), started = performance.now();
  let encoder: Encoder | undefined, reused = 0, encoded = 0, encodeMs = 0, previous = "";
  try {
    for await (const file of options.html) {
      if (views.comparePrivatePairArtifactPaths(file.path, previous) <= 0 || file.bytes.length > views.BODY_BYTES_LIMIT) refuse(); previous = file.path;
      const html = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
      for (const passage of extractPassages(html, file.path, "public")) {
        if (seen.has(passage.id) || passages.length >= MAX_DOCUMENTS) refuse(); seen.add(passage.id);
        const key = input(passage); let vector = cache.get(key);
        if (vector) reused++;
        else {
          encoder ??= await options.createEncoder();
          const began = performance.now(); vector = await encoder.encode(key); encodeMs += performance.now() - began;
          if (!validVector(vector)) refuse("semantic-vector-mismatch");
          vector = [...vector]; cache.set(key, vector); encoded++;
        }
        passages.push({ id: passage.id, url: passage.url, title: passage.title, text: passage.text, vector: [...vector] });
      }
    }
    for (const record of options.contentLinks ?? []) {
      const link = contentLink(record, record.path);
      const passage = { id: createHash("sha256").update(`${record.path}\n${record.title}\n${record.text}`).digest("hex").slice(0,24), url: record.path, title: record.title, text: record.text };
      const key = input(passage); let vector = cache.get(key);
      if (vector) reused++;
      else { encoder ??= await options.createEncoder(); vector = await encoder.encode(key); if (!validVector(vector)) refuse("semantic-vector-mismatch"); encoded++; }
      passages.push({ ...passage, contentLinkUrl: link.href, contentLinkNewTab: link.newTab, vector: [...vector] });
    }
    const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, model: MODEL_ID, revision: MODEL_REVISION, passages }));
    if (bytes.length > views.BODY_BYTES_LIMIT) refuse();
    return { path: "/search/meaning-index.json" as const, mime: "application/json; charset=utf-8", bytes,
      metrics: { passages: passages.length, reused, encoded, modelLoadMs: encoder?.modelLoadMs ?? 0, encodeMs, elapsedMs: performance.now() - started } };
  } finally { await encoder?.dispose(); }
}
