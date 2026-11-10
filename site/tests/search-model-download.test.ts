// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSearchModel } from "../src/search/model";

const modelUrl = "https://huggingface.co/example/resolve/pinned/config.json";
const networkError = () =>
  new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
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
