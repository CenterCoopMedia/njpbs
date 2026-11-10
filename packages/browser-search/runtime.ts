import { MAX_DOCUMENTS, MAX_DOCUMENT_CHARS, MAX_QUERY_CHARS, QUERY_PREFIX, type MeaningDocument, type MeaningProgress, type MeaningRequest, type MeaningResponse } from './contracts';
import { chunkText, meanVector, normalize, rankVectors } from './math';

type Encoder = (text: string) => Promise<Float32Array>;
type Row = { text: string; vector: Float32Array };
type Query = Extract<MeaningRequest, { type: 'search' }>;
const MAX_CACHED_QUERIES = 32;
const ERROR_CODES = new Set(['invalid_documents', 'empty_document', 'invalid_vector', 'invalid_search_options', 'superseded', 'index_not_ready', 'model_unavailable']);

function documentIds(documents: MeaningDocument[]): Set<string> {
  if (!Array.isArray(documents) || documents.length > MAX_DOCUMENTS) throw new Error('invalid_documents');
  const ids = new Set<string>();
  for (const document of documents) {
    if (!document || typeof document.id !== 'string' || !document.id || document.id.length > 300 || ids.has(document.id) || typeof document.text !== 'string') throw new Error('invalid_documents');
    ids.add(document.id);
  }
  return ids;
}

/** No persistence: private documents and vectors exist only in this worker. */
export function createMeaningRuntime(createEncoder: (progress: (value: MeaningProgress) => void) => Promise<Encoder>, send: (message: MeaningResponse) => void) {
  let encoderPromise: Promise<Encoder> | undefined;
  let rows = new Map<string, Row>();
  // Every vector this worker encoded, so a document that returns with the same text is not
  // encoded again after a filter change or a narrower corpus. Search still uses only rows.
  let encoded = new Map<string, Row>();
  // Repeated questions reuse inference, but are ranked against the current rows.
  // Like document vectors, this bounded cache dies with the session's worker.
  const queries = new Map<string, Float32Array>();
  let prepared = false;
  let generation = 0;
  let latestQuery = 0;
  let waitingQuery: Query | undefined;
  let queue = Promise.resolve();
  let progressId = 0;

  const progress = (value: MeaningProgress) => send({ id: progressId, type: 'progress', progress: value });
  const fail = (id: number, error: unknown) => {
    const code = error instanceof Error && ERROR_CODES.has(error.message) ? error.message : 'search_unavailable';
    send({ id, type: 'error', code });
  };
  const encoder = () => {
    encoderPromise ??= createEncoder(progress).catch(() => {
      encoderPromise = undefined;
      throw new Error('model_unavailable');
    });
    return encoderPromise;
  };
  const current = (version: number) => {
    if (version !== generation) throw new Error('superseded');
  };

  async function search(request: Query) {
    if (!prepared) throw new Error('index_not_ready');
    if (typeof request.query !== 'string' || !request.query.trim()) return [];
    const encode = await encoder();
    if (request.id !== latestQuery) throw new Error('superseded');
    const text = request.query.trim().slice(0, MAX_QUERY_CHARS);
    const query = queries.get(text) ?? await encode(QUERY_PREFIX + text);
    if (request.id !== latestQuery) throw new Error('superseded');
    queries.delete(text);
    queries.set(text, query);
    if (queries.size > MAX_CACHED_QUERIES) queries.delete(queries.keys().next().value!);
    // rows excludes removed IDs as soon as a replacement corpus is admitted.
    return rankVectors(rows, query, request.options.limit, request.options.minScore);
  }

  async function answerWaitingQuery() {
    const request = waitingQuery;
    if (!request) return;
    waitingQuery = undefined;
    try { send({ id: request.id, type: 'result', value: await search(request) }); }
    catch (error) { fail(request.id, error); }
  }

  async function prepare(documents: MeaningDocument[], version: number) {
    const next = new Map<string, Row>();
    let completed = 0;
    let newlyEncoded = 0;
    progress({ phase: 'index', completed, count: documents.length });
    for (const document of documents) {
      current(version);
      const text = document.text.trim().slice(0, MAX_DOCUMENT_CHARS);
      const old = rows.get(document.id) ?? encoded.get(document.id);
      let vector: Float32Array;
      if (document.vector) vector = normalize(document.vector);
      else if (old?.text === text) vector = old.vector;
      else {
        const chunks = chunkText(text);
        if (!chunks.length) throw new Error('empty_document');
        const encode = await encoder();
        const vectors: Float32Array[] = [];
        for (const chunk of chunks) {
          current(version);
          // Run the latest question between passage encodes, on the last
          // completed index. Model operations still never overlap.
          if (prepared) await answerWaitingQuery();
          current(version);
          vectors.push(normalize(await encode(chunk)));
        }
        vector = meanVector(vectors);
        newlyEncoded++;
        encoded.set(document.id, { text, vector });
      }
      next.set(document.id, { text, vector });
      progress({ phase: 'index', completed: ++completed, count: documents.length });
    }
    current(version);
    rows = next;
    if (encoded.size > MAX_DOCUMENTS) encoded = new Map(next);
    prepared = true;
    progress({ phase: 'ready', completed, count: rows.size });
    return { count: rows.size, encoded: newlyEncoded };
  }

  return (request: MeaningRequest) => {
    if (request.type === 'prepare') {
      try {
        documentIds(request.documents);
        // Changed text or supplied vectors cannot reuse an old score while a
        // replacement encodes. Build first so invalid requests change nothing.
        const retained = new Map<string, Row>();
        for (const document of request.documents) {
          const old = rows.get(document.id);
          if (!old || old.text !== document.text.trim().slice(0, MAX_DOCUMENT_CHARS)) continue;
          const supplied = document.vector ? normalize(document.vector) : undefined;
          if (supplied && supplied.some((value, index) => value !== old.vector[index])) continue;
          retained.set(document.id, old);
        }
        rows = retained;
        generation++;
      } catch (error) { fail(request.id, error); return; }
    }
    if (request.type === 'search') {
      latestQuery = request.id;
      if (waitingQuery) fail(waitingQuery.id, new Error('superseded'));
      waitingQuery = request;
    }
    const version = generation;
    queue = queue.then(async () => {
      if (request.type === 'search') {
        if (waitingQuery?.id === request.id) await answerWaitingQuery();
        return;
      }
      progressId = request.id;
      try {
        if (request.type === 'start') {
          await encoder();
          send({ id: request.id, type: 'result', value: undefined });
        } else {
          current(version);
          send({ id: request.id, type: 'result', value: await prepare(request.documents, version) });
        }
      } catch (error) { fail(request.id, error); }
    });
  };
}
