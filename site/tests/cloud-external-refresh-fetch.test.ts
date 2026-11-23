// @vitest-environment node
import { createServer } from "node:http";
import { once } from "node:events";
import type { CollectionReference } from "firebase-admin/firestore";
import { afterEach, expect, it, vi } from "vitest";
import { boundedFetch, cleanAbandonedExternalInputs } from "../scripts/cloud-external-refresh";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
function simulatedDeadlines() {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), milliseconds);
    return controller.signal;
  });
}
it("preserves the feed's documented 60-second budget through a slow cache-busting rebuild", async () => {
  simulatedDeadlines();
  const provider = (async (_url, options) => new Promise<Response>((resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    setTimeout(() => resolve(new Response("public feed")), 25_000);
  })) as typeof fetch;
  const result = boundedFetch(provider)("https://www.njspotlightnews.org/feed/?_njpbs_refresh=fixture",
    { signal: AbortSignal.timeout(60_000) });
  const assertion = expect(result.then(response => response.text())).resolves.toBe("public feed");
  await vi.advanceTimersByTimeAsync(25_000);
  await assertion;
});
it("still bounds a provider that never responds to at most the largest provider deadline", async () => {
  simulatedDeadlines();
  const provider = (async (_url, options) => new Promise<Response>((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
  })) as typeof fetch;
  const assertion = expect(boundedFetch(provider)("https://www.njspotlightnews.org/feed/")).rejects.toThrow("External provider request failed");
  await vi.advanceTimersByTimeAsync(60_000);
  await assertion;
});

it("bounds an abandoned input sweep and leaves a late deletion pending for retry", async () => {
  vi.useFakeTimers();
  const slowEntry = { id: "A".repeat(20), ref: { delete: vi.fn(), update: vi.fn() } };
  const nextEntry = { id: "B".repeat(20), ref: { delete: vi.fn(), update: vi.fn() } };
  const query = {
    where: () => query, orderBy: () => query, limit: () => query,
    get: async () => ({ docs: [slowEntry, nextEntry] }),
  };
  let finishSlowDelete!: () => void;
  const pending = new Promise<void>(resolve => { finishSlowDelete = resolve; });
  const deleteExternalInputs = vi.fn(async (operationId: string) => {
    if (operationId === slowEntry.id) await pending;
  });
  const sweep = cleanAbandonedExternalInputs(query as unknown as CollectionReference, { deleteExternalInputs }, 0);
  const failure = expect(sweep).rejects.toThrow("Abandoned external input cleanup timed out");
  await vi.advanceTimersByTimeAsync(30_000);
  await failure;
  expect(deleteExternalInputs.mock.calls.map(([id]) => id)).toEqual([slowEntry.id, nextEntry.id]);
  expect(nextEntry.ref.delete).toHaveBeenCalledOnce();

  finishSlowDelete();
  await vi.advanceTimersByTimeAsync(0);
  expect(slowEntry.ref.delete).not.toHaveBeenCalled();
  expect(slowEntry.ref.update).not.toHaveBeenCalled();
});

// Exercise native fetch and a real streamed HTTP response. No production data is used.
it("accepts the measured Media Manager response size while keeping other providers at 2 MiB", async () => {
  const payload = JSON.stringify({ data: [{ attributes: { title: "Fixture", description: "x".repeat(2_668_800) } }] });
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(payload);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/shows/`;
  try {
    const response = await boundedFetch(fetch, "media-manager")(url);
    const value = await response.json();
    expect(value.data[0].attributes.title).toBe("Fixture");
    expect(value.data[0].attributes.description.length).toBe(2_668_800);
    await expect(boundedFetch(fetch)(url)).rejects.toThrow("External provider response exceeds its bound");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
it("rejects and cancels a Media Manager stream above 4 MiB", async () => {
  let closed: Promise<unknown>;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    closed = once(response, "close");
    response.write(Buffer.alloc(4 * 1024 * 1024 + 1, 32));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  try {
    await expect(boundedFetch(fetch, "media-manager")(`http://127.0.0.1:${address.port}/shows/`))
      .rejects.toThrow("External provider response exceeds its bound");
    await closed!;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
