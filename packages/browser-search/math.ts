import { CHUNK_CHARS, CHUNK_OVERLAP, DIMENSIONS, MAX_CHUNKS, MAX_DOCUMENT_CHARS, type MeaningMatch } from './contracts';

/** Caller supplies separate timestamped documents for transcript passages. */
export function chunkText(text: string): string[] {
  const bounded = text.trim().slice(0, MAX_DOCUMENT_CHARS);
  const chunks: string[] = [];
  for (let offset = 0; offset < bounded.length && chunks.length < MAX_CHUNKS; offset += CHUNK_CHARS - CHUNK_OVERLAP) {
    chunks.push(bounded.slice(offset, offset + CHUNK_CHARS));
    if (offset + CHUNK_CHARS >= bounded.length) break;
  }
  return chunks;
}

export function normalize(vector: ArrayLike<number>): Float32Array {
  if (vector.length !== DIMENSIONS) throw new Error('invalid_vector');
  const out = Float32Array.from(vector);
  let sum = 0;
  for (const value of out) {
    if (!Number.isFinite(value)) throw new Error('invalid_vector');
    sum += value * value;
  }
  if (sum === 0) throw new Error('invalid_vector');
  const length = Math.sqrt(sum);
  return out.map(value => value / length);
}

export function meanVector(vectors: Float32Array[]): Float32Array {
  const out = new Float32Array(DIMENSIONS);
  for (const vector of vectors) for (let i = 0; i < DIMENSIONS; i++) out[i] += vector[i];
  return normalize(out);
}

export function rankVectors(rows: Map<string, { vector: Float32Array }>, query: Float32Array, limit = 25, minScore = 0.5): MeaningMatch[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isFinite(minScore) || minScore < -1 || minScore > 1) {
    throw new Error('invalid_search_options');
  }
  const normalized = normalize(query);
  const matches: MeaningMatch[] = [];
  for (const [id, { vector }] of rows) {
    let score = 0;
    for (let i = 0; i < DIMENSIONS; i++) score += vector[i] * normalized[i];
    if (score >= minScore) matches.push({ id, score });
  }
  return matches.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}

/** Merge ranks instead of comparing keyword scores with cosine similarities. */
export function fuseRanks(keywordIds: string[], meaningIds: string[], limit = 25): string[] {
  const scores = new Map<string, number>();
  for (const ids of [keywordIds, meaningIds]) {
    [...new Set(ids)].forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + index + 1)));
  }
  return [...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([id]) => id);
}
