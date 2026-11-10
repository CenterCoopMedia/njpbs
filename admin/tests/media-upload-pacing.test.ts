import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../src/lib/functions";
import { MAX_RATE_LIMIT_WAITS, rateLimitWaitSeconds, uploadPacedByRateLimit } from "../src/lib/media-upload";

afterEach(() => vi.useRealTimers());

describe("upload pacing", () => {
  it("waits for the server's retry-after and then resumes", async () => {
    vi.useFakeTimers();
    const waits: number[] = [];
    const send = vi.fn()
      .mockRejectedValueOnce(new HttpError(429, "Too many requests. Try again later.", { retryAfterSeconds: 3 }))
      .mockResolvedValueOnce("uploaded");
    const result = uploadPacedByRateLimit(send, new AbortController().signal, (seconds) => waits.push(seconds));
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(result).resolves.toBe("uploaded");
    expect(waits).toEqual([3]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not retry other failures", async () => {
    const send = vi.fn().mockRejectedValue(new HttpError(413, "Too large"));
    await expect(uploadPacedByRateLimit(send, new AbortController().signal)).rejects.toThrow("Too large");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("stops waiting when the upload is canceled", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const send = vi.fn().mockRejectedValue(new HttpError(429, "Too many requests.", { retryAfterSeconds: 30 }));
    const result = uploadPacedByRateLimit(send, controller.signal);
    const outcome = expect(result).rejects.toThrow("The upload was canceled.");
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await outcome;
  });

  it("gives up after the wait limit", async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockRejectedValue(new HttpError(429, "Too many requests.", { retryAfterSeconds: 1 }));
    const result = uploadPacedByRateLimit(send, new AbortController().signal);
    const outcome = expect(result).rejects.toThrow("Too many requests.");
    await vi.advanceTimersByTimeAsync((MAX_RATE_LIMIT_WAITS + 1) * 1_000);
    await outcome;
    expect(send).toHaveBeenCalledTimes(MAX_RATE_LIMIT_WAITS + 1);
  });

  it("caps and defaults the wait", () => {
    expect(rateLimitWaitSeconds(new HttpError(429, "x", { retryAfterSeconds: 600 }))).toBe(60);
    expect(rateLimitWaitSeconds(new HttpError(429, "x"))).toBe(5);
    expect(rateLimitWaitSeconds(new HttpError(500, "x"))).toBeNull();
  });
});
