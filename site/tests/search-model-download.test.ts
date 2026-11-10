// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fetchSearchModel, loadSearchEncoder } from "../src/search/model";
import { MODEL_ID, MODEL_REVISION } from "../../packages/browser-search/contracts";

const transformers = vi.hoisted(() => ({
  pipeline: vi.fn(),
  env: { cacheDir: "/model-cache", fetch: vi.fn(), allowRemoteModels: true },
  ModelFileNotFoundError: class extends Error {},
}));
vi.mock("@huggingface/transformers", () => transformers);

const modelUrl = "https://huggingface.co/example/resolve/pinned/config.json";
const networkError = () =>
  new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  transformers.pipeline.mockReset();
});

describe("pinned search model cache", () => {
  const cachedModel = path.join("/model-cache", MODEL_ID, MODEL_REVISION);
  const encoder = vi.fn();

  it("loads a warm cache without permitting a remote probe", async () => {
    vi.stubEnv("PUBLIC_ARTIFACT_BUNDLE_PATH", "");
    transformers.pipeline.mockImplementation(async (_task, model, options) => {
      expect(transformers.env.allowRemoteModels).toBe(false);
      expect(model).toBe(cachedModel);
      expect(options).toMatchObject({ local_files_only: true, revision: MODEL_REVISION, dtype: "q8" });
      return encoder;
    });
    expect(await loadSearchEncoder()).toBe(encoder);
    expect(transformers.pipeline).toHaveBeenCalledTimes(1);
  });

  it("downloads the pinned revision only when required cache files are missing", async () => {
    const originalFetch = transformers.env.fetch;
    transformers.pipeline
      .mockRejectedValueOnce(new transformers.ModelFileNotFoundError("missing model"))
      .mockImplementationOnce(async (_task, model, options) => {
        expect(transformers.env.allowRemoteModels).toBe(true);
        expect(transformers.env.fetch).toBe(fetchSearchModel);
        expect(model).toBe(MODEL_ID);
        expect(options).toMatchObject({ local_files_only: false, revision: MODEL_REVISION, dtype: "q8" });
        return encoder;
      });
    expect(await loadSearchEncoder(false)).toBe(encoder);
    expect(transformers.pipeline).toHaveBeenCalledTimes(2);
    expect(transformers.env.fetch).toBe(originalFetch);
  });

  it.each(["explicit", "frozen artifact"])("never downloads for %s offline publication", async (kind) => {
    vi.stubEnv("PUBLIC_ARTIFACT_BUNDLE_PATH", kind === "frozen artifact" ? "/release" : "");
    const missing = new transformers.ModelFileNotFoundError("missing model");
    transformers.pipeline.mockRejectedValue(missing);
    await expect(kind === "explicit" ? loadSearchEncoder(true) : loadSearchEncoder()).rejects.toBe(missing);
    expect(transformers.pipeline).toHaveBeenCalledTimes(1);
    expect(transformers.env.allowRemoteModels).toBe(false);
  });

  it("does not replace an invalid cached model with a network download", async () => {
    const originalFetch = transformers.env.fetch;
    const error = new Error("model integrity mismatch");
    transformers.pipeline.mockRejectedValue(error);
    await expect(loadSearchEncoder(false)).rejects.toBe(error);
    expect(transformers.pipeline).toHaveBeenCalledTimes(1);
    expect(transformers.env.allowRemoteModels).toBe(false);
    expect(transformers.env.fetch).toBe(originalFetch);
  });
});

describe("search model download", () => {
  it("retries two transport failures with backoff, then returns the response", async () => {
    vi.useFakeTimers();
    const response = new Response("model");
    const fetch = vi.fn()
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", fetch);
    const download = fetchSearchModel(modelUrl);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await download).toBe(response);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("stops after three transport failures", async () => {
    vi.useFakeTimers();
    const error = networkError();
    const fetch = vi.fn().mockRejectedValue(error);
    vi.stubGlobal("fetch", fetch);
    const rejected = expect(fetchSearchModel(modelUrl)).rejects.toBe(error);
    await vi.runAllTimersAsync();
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not retry an integrity mismatch from fetch", async () => {
    const error = new TypeError("fetch failed", {
      cause: new Error("integrity mismatch"),
    });
    const fetch = vi.fn().mockRejectedValue(error);
    vi.stubGlobal("fetch", fetch);
    await expect(fetchSearchModel(modelUrl)).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([404, 500])("does not retry an HTTP %i response", async (status) => {
    const response = new Response("unavailable", { status });
    const fetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetch);
    expect(await fetchSearchModel(modelUrl)).toBe(response);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
