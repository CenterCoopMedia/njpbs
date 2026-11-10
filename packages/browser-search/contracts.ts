export const MODEL_ID = 'Xenova/bge-small-en-v1.5';
export const MODEL_REVISION = 'ea104dacec62c0de699686887e3f920caeb4f3e3';
export const DIMENSIONS = 384;
export const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';
export const MAX_DOCUMENTS = 10000;
export const MAX_DOCUMENT_CHARS = 6000;
export const MAX_QUERY_CHARS = 500;
export const MAX_CHUNKS = 4;
export const CHUNK_CHARS = 1600;
export const CHUNK_OVERLAP = 200;

export interface MeaningDocument { id: string; text: string; vector?: number[] }
export interface MeaningMatch { id: string; score: number }
export interface MeaningProgress {
  phase: 'download' | 'index' | 'ready';
  loaded?: number;
  total?: number;
  completed?: number;
  count?: number;
}
export interface SearchOptions { limit?: number; minScore?: number }
export type MeaningRequest =
  | { id: number; type: 'start' }
  | { id: number; type: 'prepare'; documents: MeaningDocument[] }
  | { id: number; type: 'search'; query: string; options: SearchOptions };
export type MeaningResponse =
  | { id: number; type: 'result'; value: unknown }
  | { id: number; type: 'error'; code: string }
  | { id: number; type: 'progress'; progress: MeaningProgress };
