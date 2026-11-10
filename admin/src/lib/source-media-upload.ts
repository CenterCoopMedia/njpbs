import { postFunction } from "./functions";
import type { SourceMediaAssetSummary, SourceMediaMarker } from "./source-media";

export class UploadFileMismatchError extends Error {}
export class VideoUploadValidationError extends Error {}
export class VideoUploadCompletedError extends Error {
  constructor(readonly asset: SourceMediaAssetSummary) {
    super("The saved upload already finished. Review file history. To replace it with another file, choose that file again.");
  }
}

export const MAX_VIDEO_FILE_BYTES = 250 * 1024 ** 3;
const MAX_VIDEO_PART_BYTES = 64 * 1024 ** 2;
const CONTROL_REQUEST_TIMEOUT_MS = 75_000;
const MAX_PART_RETRIES = 2;

class VideoPartRequestError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}

async function controlRequest<T>(request: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const bounded = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS)])
    : AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS);
  bounded.throwIfAborted();
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<T>((_, reject) => {
    onAbort = () => reject(bounded.reason);
    bounded.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([request(bounded), aborted]);
  } catch (error) {
    if (bounded.aborted && !signal?.aborted) {
      throw new Error("The video upload request timed out. Resume or cancel to try again.");
    }
    throw error;
  } finally {
    bounded.removeEventListener("abort", onAbort);
  }
}

export interface VideoUploadMetadata {
  metadataUpdateRequested?: boolean;
  name: string;
  description?: string;
  credit?: string;
  license?: string;
  tags?: string[];
  rightsStatus?: "pending" | "complete";
  markers?: SourceMediaMarker[];
}
export interface VideoUploadSession {
  sessionId: string;
  assetId: string;
  partSize: number;
  totalParts: number;
  expiresAt: string;
  version: number;
}
interface CompletedPart { partNumber: number; etag: string; checksumSha256: string }
interface SignedPart { partNumber: number; url: string; expiresAt: string; requiredHeaders: Record<string, string> }
interface PreparedPartBatch { numbers: number[]; slices: Blob[]; checksums: string[] }
type ResumeResponse = { success: true; asset: SourceMediaAssetSummary } | {
  success: true;
  upload: VideoUploadSession & { completedParts: CompletedPart[]; originalName: string; sizeBytes: number; lastModified: number };
};

async function checksum(blob: Blob): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  return btoa(String.fromCharCode(...digest));
}

async function prepareNextPartBatch(
  file: File,
  numbers: number[],
  partSize: number,
  signal: AbortSignal,
): Promise<PreparedPartBatch> {
  const slices = numbers.map(number =>
    file.slice((number - 1) * partSize, Math.min(number * partSize, file.size)));
  const checksums: string[] = [];
  // Read one part at a time. The next batch can overlap active PUTs without
  // retaining another whole upload window in ArrayBuffers.
  for (const slice of slices) {
    signal.throwIfAborted();
    checksums.push(await checksum(slice));
    signal.throwIfAborted();
  }
  return { numbers, slices, checksums };
}

type SettledPreparation =
  | { status: "fulfilled"; value: PreparedPartBatch }
  | { status: "rejected"; reason: unknown };

function settlePreparation(preparation: Promise<PreparedPartBatch>): Promise<SettledPreparation> {
  return preparation.then(
    value => ({ status: "fulfilled" as const, value }),
    reason => ({ status: "rejected" as const, reason }),
  );
}

function putPart(part: SignedPart, body: Blob, signal: AbortSignal, progress: (bytes: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    const finish = (error?: Error) => {
      signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    };
    request.open("PUT", part.url);
    for (const [key, value] of Object.entries(part.requiredHeaders)) request.setRequestHeader(key, value);
    request.upload.onprogress = event => progress(event.loaded);
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) { finish(); return; }
      const retryable = request.status === 408 || request.status === 429 || request.status >= 500 ||
        (request.status === 400 && /<Code>\s*RequestTimeout\s*<\/Code>/.test(request.responseText));
      finish(new VideoPartRequestError(`A video part could not be uploaded (HTTP ${request.status}). Resume to try again.`, retryable));
    };
    request.onerror = () => finish(new VideoPartRequestError("The connection was interrupted. Resume to try again.", true));
    request.onabort = () => finish(new DOMException("Upload paused", "AbortError"));
    request.timeout = 300_000;
    request.ontimeout = () => finish(new VideoPartRequestError("The connection timed out. Resume to try again.", true));
    if (signal.aborted) { finish(new DOMException("Upload paused", "AbortError")); return; }
    signal.addEventListener("abort", abort, { once: true });
    request.send(body);
  });
}

function retryDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function uploadPart(part: SignedPart, body: Blob, signal: AbortSignal, progress: (bytes: number) => void): Promise<void> {
  for (let retry = 0; ; retry++) {
    try { await putPart(part, body, signal, progress); return; }
    catch (error) {
      if (signal.aborted || !(error instanceof VideoPartRequestError) || !error.retryable || retry >= MAX_PART_RETRIES) throw error;
      progress(0);
      await retryDelay(1_000 * 2 ** retry, signal);
    }
  }
}

function videoMimeType(file: Pick<File, "name">): string {
  const extensions: Record<string, string> = { mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mpeg: "video/mpeg", mpg: "video/mpeg", mkv: "video/x-matroska", avi: "video/x-msvideo", wmv: "video/x-ms-wmv", mxf: "application/mxf" };
  const inferred = extensions[file.name.split(".").at(-1)?.toLowerCase() ?? ""];
  if (!inferred) throw new VideoUploadValidationError("Choose an MP4, MOV, WebM, MPEG, MKV, AVI, WMV, or MXF video file.");
  return inferred;
}

export function startVideoUpload(token: string | null | (() => Promise<string>), sourceId: string, file: Pick<File, "name" | "size" | "lastModified">, metadata: VideoUploadMetadata,
  options: { requestId?: string; signal?: AbortSignal; replacement?: { assetId: string; expectedVersion: number; confirmed: true } } = {}) {
  if (file.size > MAX_VIDEO_FILE_BYTES) throw new VideoUploadValidationError("Browser uploads support videos up to 250 GiB. Ask an administrator to import larger files.");
  return controlRequest(async signal => {
    const idToken = typeof token === "function" ? await token() : token;
    signal.throwIfAborted();
    return postFunction<{ success: true; upload: VideoUploadSession }>("cmsStartSourceMediaUpload", idToken,
      { sourceId, ...(options.requestId === undefined ? {} : { requestId: options.requestId }), originalName: file.name, mimeType: videoMimeType(file), sizeBytes: file.size, lastModified: file.lastModified,
        ...(options.replacement ? { replacement: options.replacement } : { metadata }) }, {}, { appCheck: true, signal });
  }, options.signal);
}

export function cancelVideoUpload(token: string | null | (() => Promise<string>), sourceId: string, session: VideoUploadSession) {
  return controlRequest(async signal => {
    const idToken = typeof token === "function" ? await token() : token;
    signal.throwIfAborted();
    return postFunction<{ success: true; canceled: true }>("cmsCancelSourceMediaUpload", idToken,
      { sourceId, sessionId: session.sessionId, version: session.version }, {}, { appCheck: true, signal });
  });
}

export async function transferVideo({ file, sourceId, session, getIdToken, signal, onProgress, onSession, onPhase, requireActiveSession = false }: {
  file: File;
  sourceId: string;
  session: VideoUploadSession;
  getIdToken: () => Promise<string>;
  signal: AbortSignal;
  onProgress: (bytes: number) => void;
  onSession: (session: VideoUploadSession) => void;
  onPhase: (phase: "checking" | "uploading" | "finishing") => void;
  requireActiveSession?: boolean;
}): Promise<SourceMediaAssetSummary> {
  onPhase("checking");
  const resumed = await controlRequest(async requestSignal => {
    const token = await getIdToken();
    requestSignal.throwIfAborted();
    return postFunction<ResumeResponse>("cmsResumeSourceMediaUpload", token,
      { sourceId, sessionId: session.sessionId }, {}, { appCheck: true, signal: requestSignal });
  }, signal);
  if ("asset" in resumed) {
    if (requireActiveSession) throw new VideoUploadCompletedError(resumed.asset);
    return resumed.asset;
  }
  const state = resumed.upload;
  if (!Number.isSafeInteger(state.partSize) || state.partSize < 1 || state.partSize > MAX_VIDEO_PART_BYTES) {
    throw new Error("This transfer needs to be restarted with smaller parts. Cancel it and add the video again.");
  }
  if (state.originalName !== file.name || state.sizeBytes !== file.size || state.lastModified !== file.lastModified) {
    throw new UploadFileMismatchError("Select the original file to resume this upload.");
  }
  onSession(state);
  let version = state.version;
  const completed = new Map(state.completedParts.map(part => [part.partNumber, part]));
  let uploadedBytes = 0;
  const pending: number[] = [];
  // Check every retained part against the reselected file before mixing old and new bytes.
  for (let number = 1; number <= state.totalParts; number++) {
    signal.throwIfAborted();
    const slice = file.slice((number - 1) * state.partSize, Math.min(number * state.partSize, file.size));
    const old = completed.get(number);
    if (!old) { pending.push(number); continue; }
    if (await checksum(slice) !== old.checksumSha256) throw new UploadFileMismatchError("This file differs from the original upload. Select the original file or cancel this transfer.");
    uploadedBytes += slice.size;
    onProgress(uploadedBytes);
  }
  onPhase("uploading");
  const concurrency = Math.max(1, Math.min(3, Math.floor(48 * 1024 ** 2 / state.partSize)));
  const initialNumbers = pending.slice(0, concurrency);
  const initialSlices = initialNumbers.map(number =>
    file.slice((number - 1) * state.partSize, Math.min(number * state.partSize, file.size)));
  let prepared: PreparedPartBatch = {
    numbers: initialNumbers,
    slices: initialSlices,
    checksums: await Promise.all(initialSlices.map(checksum)),
  };
  signal.throwIfAborted();
  for (let offset = 0; offset < pending.length; offset += concurrency) {
    signal.throwIfAborted();
    const { numbers, slices, checksums } = prepared;
    const signed = await controlRequest(async requestSignal => {
      const token = await getIdToken();
      requestSignal.throwIfAborted();
      return postFunction<{ success: true; version: number; parts: SignedPart[] }>("cmsSignSourceMediaUploadParts", token,
        { sourceId, sessionId: session.sessionId, version, parts: numbers.map((partNumber, index) => ({ partNumber, sizeBytes: slices[index].size, checksumSha256: checksums[index] })) }, {}, { appCheck: true, signal: requestSignal });
    }, signal);
    version = signed.version;
    onSession({ ...state, version });
    const preparationController = new AbortController();
    const nextOffset = offset + concurrency;
    const nextPreparation = nextOffset < pending.length
      ? settlePreparation(prepareNextPartBatch(
          file,
          pending.slice(nextOffset, nextOffset + concurrency),
          state.partSize,
          AbortSignal.any([signal, preparationController.signal]),
        ))
      : null;
    const progress = new Map<number, number>();
    const batch = new AbortController();
    const abortBatch = () => batch.abort();
    signal.addEventListener("abort", abortBatch, { once: true });
    if (signal.aborted) batch.abort();
    try {
      const results = await Promise.allSettled(numbers.map(async (number, index) => {
        const part = signed.parts.find(item => item.partNumber === number);
        if (!part) throw new Error("The upload could not be authorized. Resume to try again.");
        try {
          await uploadPart(part, slices[index], batch.signal, bytes => {
            progress.set(number, bytes);
            onProgress(uploadedBytes + [...progress.values()].reduce((sum, value) => sum + value, 0));
          });
        } catch (error) { batch.abort(); throw error; }
      }));
      const rejected = results.filter(result => result.status === "rejected");
      const failure = rejected.find(result => result.reason?.name !== "AbortError") ?? rejected[0];
      if (failure?.status === "rejected") throw failure.reason;
      uploadedBytes += slices.reduce((sum, slice) => sum + slice.size, 0);
      onProgress(uploadedBytes);
    } catch (error) {
      preparationController.abort();
      throw error;
    } finally { signal.removeEventListener("abort", abortBatch); }
    if (nextPreparation) {
      const result = await nextPreparation;
      if (result.status === "rejected") throw result.reason;
      prepared = result.value;
    }
  }
  signal.throwIfAborted();
  onPhase("finishing");
  const result = await controlRequest(async requestSignal => {
    const token = await getIdToken();
    requestSignal.throwIfAborted();
    return postFunction<{ success: true; asset: SourceMediaAssetSummary }>("cmsCompleteSourceMediaUpload", token,
      { sourceId, sessionId: session.sessionId, version }, {}, { appCheck: true, signal: requestSignal });
  }, signal);
  return result.asset;
}
