import { MAX_DOCUMENTS, MAX_DOCUMENT_CHARS, type MeaningDocument, type MeaningMatch, type MeaningProgress, type MeaningRequest, type MeaningResponse, type SearchOptions } from './contracts';
export { MODEL_ID, MODEL_REVISION, DIMENSIONS, type MeaningDocument, type MeaningMatch, type MeaningProgress } from './contracts';
export { chunkText, fuseRanks } from './math';

type RequestInput = { [K in MeaningRequest['type']]: Omit<Extract<MeaningRequest, { type: K }>, 'id'> }[MeaningRequest['type']];

interface WorkerPort {
  postMessage(message: MeaningRequest): void;
  addEventListener(type: 'message' | 'error', listener: (event: any) => void): void;
  terminate(): void;
}
interface Options {
  onProgress?: (progress: MeaningProgress) => void;
  /** Test seam; applications use the bundled module worker. */
  workerFactory?: () => WorkerPort;
  timeoutMs?: number;
}
interface Pending {
  type: MeaningRequest['type'];
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
const abortError = () => new DOMException('Search superseded', 'AbortError');

/** Call start on surface mount. There is no consent toggle or remote inference. */
export function createMeaningSearch({ onProgress, workerFactory, timeoutMs = 120000 }: Options = {}) {
  let worker: WorkerPort | undefined;
  let nextId = 0;
  let disposed = false;
  const pending = new Map<number, Pending>();
  const settle = (id: number) => {
    const request = pending.get(id);
    if (request) clearTimeout(request.timer);
    pending.delete(id);
    return request;
  };
  const reset = (error: Error) => {
    worker?.terminate();
    worker = undefined;
    for (const id of pending.keys()) settle(id)?.reject(error);
  };
  const ensureWorker = () => {
    if (worker) return worker;
    worker = workerFactory ? workerFactory() : new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'njpbs-meaning-search' });
    const activeWorker = worker;
    worker.addEventListener('message', (event: MessageEvent<MeaningResponse>) => {
      if (worker !== activeWorker) return;
      const message = event.data;
      if (!pending.has(message.id)) return;
      if (message.type === 'progress') {
        const request = pending.get(message.id)!;
        clearTimeout(request.timer);
        request.timer = setTimeout(() => reset(new Error('search_timeout')), timeoutMs);
        onProgress?.(message.progress);
        return;
      }
      const request = settle(message.id);
      if (message.type === 'error') request?.reject(message.code === 'superseded' ? abortError() : new Error(message.code));
      else request?.resolve(message.value);
    });
    worker.addEventListener('error', () => {
      if (worker === activeWorker) reset(new Error('search_worker_unavailable'));
    });
    return worker;
  };
  const cancel = (types: MeaningRequest['type'][]) => {
    for (const [id, request] of pending) if (types.includes(request.type)) settle(id)?.reject(abortError());
  };
  const post = <T>(message: RequestInput): Promise<T> => {
    if (disposed) return Promise.reject(new Error('search_disposed'));
    let port: WorkerPort;
    try { port = ensureWorker(); } catch { return Promise.reject(new Error('search_worker_unavailable')); }
    const id = ++nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reset(new Error('search_timeout')), timeoutMs);
      pending.set(id, { type: message.type, resolve: value => resolve(value as T), reject, timer });
      try { port.postMessage({ ...message, id } as MeaningRequest); }
      catch { reset(new Error('search_worker_unavailable')); }
    });
  };
  return {
    start: () => post<void>({ type: 'start' }),
    prepare: (documents: MeaningDocument[]) => {
      if (!Array.isArray(documents) || documents.length > MAX_DOCUMENTS || documents.some(document => !document || typeof document.text !== 'string')) return Promise.reject(new Error('invalid_documents'));
      cancel(['prepare']);
      // Bound the copy before crossing the worker boundary. Do not retain a
      // second corpus on the main thread for transparent timeout retries.
      const bounded = documents.map(document => ({ ...document, text: document.text.slice(0, MAX_DOCUMENT_CHARS) }));
      return post<{ count: number; encoded: number }>({ type: 'prepare', documents: bounded });
    },
    search: (query: string, options: SearchOptions = {}) => {
      cancel(['search']);
      return post<MeaningMatch[]>({ type: 'search', query, options });
    },
    dispose: () => { disposed = true; reset(abortError()); },
  };
}
