import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, webcrypto } from "node:crypto";
import { postFunction, RequestNotDispatchedError } from "../src/lib/functions";
import { transferVideo, startVideoUpload, MAX_VIDEO_FILE_BYTES, UploadFileMismatchError, VideoUploadCompletedError } from "../src/lib/source-media-upload";
vi.mock("../src/lib/functions", () => ({
  postFunction: vi.fn(),
  RequestNotDispatchedError: class extends Error {
    constructor(cause: unknown) {
      super(cause instanceof Error ? cause.message : "The request could not start.");
    }
  },
}));
const session = { sessionId: "session-1", assetId: "asset-1", version: 1, partSize: 4, totalParts: 2, expiresAt: "2026-09-15T00:00:00Z" };
function file(data = "abcdefgh") {
  return { name: "news.mp4", size: data.length, lastModified: 42, slice: (start: number, end: number) => {
    const bytes = new TextEncoder().encode(data.slice(start, end));
    return { size: bytes.length, arrayBuffer: async () => bytes.buffer };
  } } as File;
}
const callbacks = () => ({ sourceId: "video-library", session, file: file(), getIdToken: async () => "fresh-token", signal: new AbortController().signal, onProgress: vi.fn(), onSession: vi.fn(), onPhase: vi.fn() });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function advanceUntil(condition: () => boolean) {
  for (let index = 0; index < 100 && !condition(); index += 1) await Promise.resolve();
  expect(condition()).toBe(true);
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.stubGlobal("crypto", webcrypto);
});
describe("resumable video transfers", () => {
  it("rejects oversized browser uploads before requesting a session", () => {
    const oversized = { ...file(), size: MAX_VIDEO_FILE_BYTES + 1 } as File;
    expect(() => startVideoUpload("token", "video-library", oversized, { name: "news" })).toThrow("250 GiB");
    expect(postFunction).not.toHaveBeenCalled();
  });
  it("stops waiting for a hung start while retaining the same request id for retry", async () => {
    vi.mocked(postFunction).mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const request = startVideoUpload("token", "video-library", file(), { name: "news" },
      { requestId: "local-row-1", signal: controller.signal });
    expect(postFunction).toHaveBeenCalledWith("cmsStartSourceMediaUpload", "token",
      expect.objectContaining({ requestId: "local-row-1", originalName: "news.mp4" }), {},
      { appCheck: true, signal: expect.any(AbortSignal) });
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });
  it("preserves a typed pre-dispatch failure from the request transport", async () => {
    const failure = new RequestNotDispatchedError(
      new Error("Account-request protection is not configured"),
    );
    vi.mocked(postFunction).mockRejectedValueOnce(failure);
    await expect(startVideoUpload("token", "video-library", file(), { name: "news" }))
      .rejects.toBe(failure);
  });
  it("does not send a start when its token arrives after cancellation", async () => {
    let resolveToken!: (token: string) => void;
    const token = () => new Promise<string>(resolve => { resolveToken = resolve; });
    const controller = new AbortController();
    const request = startVideoUpload(token, "video-library", file(), { name: "news" },
      { requestId: "local-row-1", signal: controller.signal });
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    resolveToken("late-token");
    await Promise.resolve();
    expect(postFunction).not.toHaveBeenCalled();
  });
  it("refuses oversized retained parts before hashing file bytes", async () => {
    vi.mocked(postFunction).mockResolvedValueOnce({ success: true, upload: { ...session, partSize: 64 * 1024 ** 2 + 1, originalName: "news.mp4", sizeBytes: 8, lastModified: 42, completedParts: [] } });
    await expect(transferVideo(callbacks())).rejects.toThrow("smaller parts");
    expect(postFunction).toHaveBeenCalledTimes(1);
  });
  it("recovers a completed upload after losing the completion response", async () => {
    const asset = { id: "asset-1" };
    vi.mocked(postFunction).mockResolvedValueOnce({ success: true, asset });
    expect(await transferVideo(callbacks())).toEqual(asset);
    expect(postFunction).toHaveBeenCalledTimes(1);
    expect(postFunction).toHaveBeenCalledWith("cmsResumeSourceMediaUpload", "fresh-token", { sourceId: "video-library", sessionId: "session-1" }, {}, { appCheck: true, signal: expect.any(AbortSignal) });
  });
  it("refuses a completed saved replacement before accepting the newly selected file", async () => {
    vi.mocked(postFunction).mockResolvedValueOnce({ success: true, asset: { id: "asset-1" } });
    const selected = { ...file("new-file"), name: "next-cut.mp4" } as File;
    await expect(transferVideo({ ...callbacks(), file: selected, requireActiveSession: true }))
      .rejects.toBeInstanceOf(VideoUploadCompletedError);
    expect(postFunction).toHaveBeenCalledTimes(1);
    expect(postFunction).not.toHaveBeenCalledWith("cmsCompleteSourceMediaUpload", expect.anything(), expect.anything(), expect.anything(), expect.anything());
  });
  it("resumes matching retained bytes when a replacement requires an active session", async () => {
    const asset = { id: "asset-1" };
    vi.mocked(postFunction)
      .mockResolvedValueOnce({ success: true, upload: { ...session, originalName: "news.mp4", sizeBytes: 8, lastModified: 42,
        completedParts: ["abcd", "efgh"].map((bytes, index) => ({ partNumber: index + 1, etag: `part-${index + 1}`,
          checksumSha256: createHash("sha256").update(bytes).digest("base64") })) } })
      .mockResolvedValueOnce({ success: true, asset });
    const options = callbacks();
    await expect(transferVideo({ ...options, requireActiveSession: true })).resolves.toEqual(asset);
    expect(options.onProgress).toHaveBeenLastCalledWith(8);
    expect(postFunction).toHaveBeenLastCalledWith("cmsCompleteSourceMediaUpload", "fresh-token",
      { sourceId: "video-library", sessionId: "session-1", version: 1 }, {}, { appCheck: true, signal: expect.any(AbortSignal) });
  });
  it("rejects a different reselected file before signing any new parts", async () => {
    vi.mocked(postFunction).mockResolvedValueOnce({ success: true, upload: { ...session, originalName: "other.mp4", sizeBytes: 8, lastModified: 42, completedParts: [] } });
    await expect(transferVideo(callbacks())).rejects.toBeInstanceOf(UploadFileMismatchError);
    expect(postFunction).toHaveBeenCalledTimes(1);
  });
  it("checks retained part bytes even when name, size and modification time match", async () => {
    vi.mocked(postFunction).mockResolvedValueOnce({ success: true, upload: { ...session, originalName: "news.mp4", sizeBytes: 8, lastModified: 42, completedParts: [{ partNumber: 1, etag: "etag", checksumSha256: "wrong-digest" }] } });
    await expect(transferVideo(callbacks())).rejects.toBeInstanceOf(UploadFileMismatchError);
    expect(postFunction).toHaveBeenCalledTimes(1);
  });
  it("reports the failed part when another part is aborted", async () => {
    vi.mocked(postFunction)
      .mockResolvedValueOnce({ success: true, upload: { ...session, originalName: "news.mp4", sizeBytes: 8, lastModified: 42, completedParts: [] } })
      .mockResolvedValueOnce({ success: true, version: 2, parts: [
        { partNumber: 1, url: "https://example.invalid/1", requiredHeaders: {} },
        { partNumber: 2, url: "https://example.invalid/2", requiredHeaders: {} },
      ] });
    let sent = 0;
    vi.stubGlobal("XMLHttpRequest", class {
      upload = { onprogress: null };
      status = 0;
      timeout = 0;
      onload: (() => void) | null = null;
      onabort: (() => void) | null = null;
      open() {}
      setRequestHeader() {}
      send() {
        if (++sent === 2) queueMicrotask(() => { this.status = 403; this.onload?.(); });
      }
      abort() { this.onabort?.(); }
    });

    await expect(transferVideo(callbacks())).rejects.toThrow("HTTP 403");
    expect(sent).toBe(2);
  });
  it("prepares one next part at a time during PUTs and signs it only after the batch settles", async () => {
    const nextFourth = deferred<void>();
    const nextFifth = deferred<void>();
    const reads: number[] = [];
    let activeNextReads = 0;
    let maxActiveNextReads = 0;
    const data = "abcdefghijklmnopqrst";
    const trackedFile = {
      name: "news.mp4",
      size: data.length,
      lastModified: 42,
      slice: (start: number, end: number) => {
        const bytes = new TextEncoder().encode(data.slice(start, end));
        const partNumber = start / 4 + 1;
        return {
          size: bytes.length,
          arrayBuffer: async () => {
            reads.push(partNumber);
            if (partNumber >= 4) {
              activeNextReads += 1;
              maxActiveNextReads = Math.max(maxActiveNextReads, activeNextReads);
            }
            try {
              if (partNumber === 4) await nextFourth.promise;
              if (partNumber === 5) await nextFifth.promise;
              return bytes.buffer;
            } finally {
              if (partNumber >= 4) activeNextReads -= 1;
            }
          },
        };
      },
    } as File;
    vi.stubGlobal("crypto", {
      subtle: { digest: vi.fn(async () => new Uint8Array(32).buffer) },
    });
    const signBatches: number[][] = [];
    vi.mocked(postFunction).mockImplementation(async (endpoint, _token, body) => {
      if (endpoint === "cmsResumeSourceMediaUpload") {
        return { success: true, upload: {
          ...session, partSize: 4, totalParts: 5, originalName: "news.mp4",
          sizeBytes: data.length, lastModified: 42, completedParts: [],
        } } as never;
      }
      if (endpoint === "cmsSignSourceMediaUploadParts") {
        const request = body as { parts: { partNumber: number }[] };
        const numbers = request.parts.map(part => part.partNumber);
        signBatches.push(numbers);
        return { success: true, version: signBatches.length + 1, parts: numbers.map(partNumber => ({
          partNumber, url: `https://example.invalid/${partNumber}`, requiredHeaders: {},
        })) } as never;
      }
      if (endpoint === "cmsCompleteSourceMediaUpload") {
        return { success: true, asset: { id: "asset-1" } } as never;
      }
      throw new Error(`Unexpected endpoint ${endpoint}`);
    });
    const requests: Array<{ partNumber: number; succeed: () => void }> = [];
    vi.stubGlobal("XMLHttpRequest", class {
      upload = { onprogress: null };
      status = 0;
      timeout = 0;
      partNumber = 0;
      onload: (() => void) | null = null;
      onabort: (() => void) | null = null;
      open(_method: string, url: string) { this.partNumber = Number(url.split("/").at(-1)); }
      setRequestHeader() {}
      send() {
        requests.push({
          partNumber: this.partNumber,
          succeed: () => { this.status = 200; this.onload?.(); },
        });
      }
      abort() { this.onabort?.(); }
    });

    const transfer = transferVideo({ ...callbacks(), file: trackedFile });
    await advanceUntil(() => requests.length === 3 && reads.includes(4));
    expect(signBatches).toEqual([[1, 2, 3]]);
    expect(maxActiveNextReads).toBe(1);

    nextFourth.resolve();
    await advanceUntil(() => reads.includes(5));
    expect(maxActiveNextReads).toBe(1);
    nextFifth.resolve();
    await advanceUntil(() => activeNextReads === 0);
    expect(signBatches).toEqual([[1, 2, 3]]);

    requests.slice(0, 3).forEach(request => request.succeed());
    await advanceUntil(() => requests.length === 5);
    expect(signBatches).toEqual([[1, 2, 3], [4, 5]]);
    requests.slice(3).forEach(request => request.succeed());
    await expect(transfer).resolves.toEqual({ id: "asset-1" });
    expect(reads).toEqual([1, 2, 3, 4, 5]);
  });
  it("stops overlapped preparation after a PUT failure without signing another batch", async () => {
    const fourth = deferred<void>();
    const reads: number[] = [];
    const data = "abcdefghijklmnopqrst";
    const trackedFile = {
      name: "news.mp4",
      size: data.length,
      lastModified: 42,
      slice: (start: number, end: number) => {
        const bytes = new TextEncoder().encode(data.slice(start, end));
        const partNumber = start / 4 + 1;
        return {
          size: bytes.length,
          arrayBuffer: async () => {
            reads.push(partNumber);
            if (partNumber === 4) await fourth.promise;
            return bytes.buffer;
          },
        };
      },
    } as File;
    vi.stubGlobal("crypto", {
      subtle: { digest: vi.fn(async () => new Uint8Array(32).buffer) },
    });
    const signed: number[][] = [];
    vi.mocked(postFunction).mockImplementation(async (endpoint, _token, body) => {
      if (endpoint === "cmsResumeSourceMediaUpload") {
        return { success: true, upload: {
          ...session, partSize: 4, totalParts: 5, originalName: "news.mp4",
          sizeBytes: data.length, lastModified: 42, completedParts: [],
        } } as never;
      }
      if (endpoint === "cmsSignSourceMediaUploadParts") {
        const request = body as { parts: { partNumber: number }[] };
        const numbers = request.parts.map(part => part.partNumber);
        signed.push(numbers);
        return { success: true, version: 2, parts: numbers.map(partNumber => ({
          partNumber, url: `https://example.invalid/${partNumber}`, requiredHeaders: {},
        })) } as never;
      }
      throw new Error(`Unexpected endpoint ${endpoint}`);
    });
    const requests: Array<{ partNumber: number; fail: () => void }> = [];
    vi.stubGlobal("XMLHttpRequest", class {
      upload = { onprogress: null };
      status = 0;
      timeout = 0;
      partNumber = 0;
      onload: (() => void) | null = null;
      onabort: (() => void) | null = null;
      open(_method: string, url: string) { this.partNumber = Number(url.split("/").at(-1)); }
      setRequestHeader() {}
      send() {
        requests.push({
          partNumber: this.partNumber,
          fail: () => { this.status = 403; this.onload?.(); },
        });
      }
      abort() { this.onabort?.(); }
    });

    const transfer = transferVideo({ ...callbacks(), file: trackedFile });
    await advanceUntil(() => requests.length === 3 && reads.includes(4));
    requests[0].fail();
    await expect(transfer).rejects.toThrow("HTTP 403");
    fourth.resolve();
    await advanceUntil(() => reads.length >= 4);
    await Promise.resolve();
    expect(reads).toEqual([1, 2, 3, 4]);
    expect(signed).toEqual([[1, 2, 3]]);
  });
  it("retries a transient part failure without staff intervention", async () => {
    const asset = { id: "asset-1" };
    vi.mocked(postFunction)
      .mockResolvedValueOnce({ success: true, upload: { ...session, originalName: "news.mp4", sizeBytes: 8, lastModified: 42, completedParts: [] } })
      .mockResolvedValueOnce({ success: true, version: 2, parts: [
        { partNumber: 1, url: "https://example.invalid/1", requiredHeaders: {} },
        { partNumber: 2, url: "https://example.invalid/2", requiredHeaders: {} },
      ] })
      .mockResolvedValueOnce({ success: true, asset });
    let sent = 0;
    vi.stubGlobal("XMLHttpRequest", class {
      upload = { onprogress: null };
      status = 0;
      timeout = 0;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      open() {}
      setRequestHeader() {}
      send() {
        const attempt = ++sent;
        queueMicrotask(() => {
          if (attempt === 1) this.onerror?.();
          else { this.status = 200; this.onload?.(); }
        });
      }
      abort() {}
    });

    await expect(transferVideo(callbacks())).resolves.toEqual(asset);
    expect(sent).toBe(3);
  });
  it("retries S3 RequestTimeout but stops after two failed retries", async () => {
    vi.mocked(postFunction)
      .mockResolvedValueOnce({ success: true, upload: { ...session, originalName: "news.mp4", sizeBytes: 8, lastModified: 42, completedParts: [] } })
      .mockResolvedValueOnce({ success: true, version: 2, parts: [
        { partNumber: 1, url: "https://example.invalid/1", requiredHeaders: {} },
        { partNumber: 2, url: "https://example.invalid/2", requiredHeaders: {} },
      ] });
    let sent = 0;
    vi.stubGlobal("XMLHttpRequest", class {
      upload = { onprogress: null };
      status = 0;
      responseText = "<Error><Code>RequestTimeout</Code></Error>";
      timeout = 0;
      part = 0;
      onload: (() => void) | null = null;
      onabort: (() => void) | null = null;
      open(_method: string, url: string) { this.part = url.endsWith("/1") ? 1 : 2; }
      setRequestHeader() {}
      send() {
        if (this.part === 1) ++sent;
        queueMicrotask(() => { this.status = this.part === 1 ? 400 : 200; this.onload?.(); });
      }
      abort() { this.onabort?.(); }
    });

    await expect(transferVideo(callbacks())).rejects.toThrow("HTTP 400");
    expect(sent).toBe(3);
  }, 10_000);
  it("does not complete an aborted transfer", async () => {
    vi.mocked(postFunction).mockResolvedValueOnce({ success: true, upload: { ...session, originalName: "news.mp4", sizeBytes: 8, lastModified: 42, completedParts: [] } });
    const abort = new AbortController();
    abort.abort();
    await expect(transferVideo({ ...callbacks(), signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(postFunction).not.toHaveBeenCalled();
  });
});
