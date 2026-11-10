import { afterEach, expect, it, vi } from "vitest";
import { publicReleasePairRpcStore } from "../../site/scripts/public-release-pair-storage-rpc";
import { encodePairStorageBatchResult } from "../../packages/content-core/src/public-release-storage-batch";
const key = `release-pair-inputs/v2/fixture/objects/${"a".repeat(64)}.json`;
afterEach(() => { vi.unstubAllGlobals(); });
it.each(["http503", "transport"])("classifies %s as non-consuming storage unavailability", async mode => {
  vi.stubGlobal("fetch", async () => {
    if (mode === "transport") throw new TypeError("fixture transport interruption");
    return new Response(null, { status: 503 });
  });
  await expect(publicReleasePairRpcStore().get(key)).rejects.toMatchObject({ code: "storage-unavailable" });
});
it("classifies malformed metadata as byte mismatch and missing objects as missing", async () => {
  vi.stubGlobal("fetch", async () => new Response("x", { headers: { "content-length": "1", "x-pair-metadata": "{" } }));
  await expect(publicReleasePairRpcStore().get(key)).rejects.toMatchObject({ code: "byte-mismatch" });
  vi.stubGlobal("fetch", async () => new Response(null, { status: 404 }));
  expect(await publicReleasePairRpcStore().get(key)).toBe(null);
});
it("represents a verified empty object even when HTTP has no body stream", async () => {
  vi.stubGlobal("fetch", async () => new Response(null, { headers: { "content-length": "0", "x-pair-metadata": "{}" } }));
  const object = await publicReleasePairRpcStore().get(key);
  expect(object!.size).toBe(0);
  expect(await object!.body.getReader().read()).toEqual({ value: undefined, done: true });
});
it.each(["transport", "http503", "body-interruption", "reordered", "short-body"])("refuses every member on batch %s without retry", async fault => {
  const keys = [key, key.replace("a".repeat(64), "b".repeat(64))]; let requests = 0;
  vi.stubGlobal("fetch", async () => {
    requests++;
    if (fault === "transport") throw new TypeError("fixture transport interruption");
    if (fault === "http503") return new Response(null, { status: 503 });
    const value = encodePairStorageBatchResult((fault === "reordered" ? [...keys].reverse() : keys).map(key => ({ key, status: 404 })));
    if (fault === "body-interruption") return new Response(new ReadableStream({ start(controller) { controller.error(new Error("interrupted body")); } }),
      { headers: { "content-length": String(Buffer.byteLength(value)) } });
    return new Response(value, { headers: { "content-length": String(Buffer.byteLength(value) + (fault === "short-body" ? 1 : 0)) } });
  });
  const store = publicReleasePairRpcStore(), results = await Promise.allSettled(keys.map(key => store.get(key)));
  expect(results).toEqual([0, 1].map(() => ({ status: "rejected", reason: expect.objectContaining({
    code: ["reordered", "short-body"].includes(fault) ? "byte-mismatch" : "storage-unavailable" }) })));
  expect(requests).toBe(1);
});
it("limits each private request to four concurrent members and leaves the remainder on its original path", async () => {
  const sizes: number[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (init.method !== "POST") { sizes.push(1); return new Response(null, { status: 404 }); }
    const items = JSON.parse(init.body as string).items; sizes.push(items.length);
    const value = encodePairStorageBatchResult(items.map((item: { key: string }) => ({ key: item.key, status: 404 })));
    return new Response(value, { headers: { "content-length": String(Buffer.byteLength(value)) } });
  });
  const store = publicReleasePairRpcStore();
  expect(await Promise.all(["a", "b", "c", "d", "e"].map(digit => store.get(key.replace("a".repeat(64), digit.repeat(64)))))).toEqual([null, null, null, null, null]);
  expect(sizes.sort()).toEqual([1, 4]);
});
