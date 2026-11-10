import { expect, it } from "vitest";
import { encodePairStorageBatchRequest, parsePairStorageBatchRequest, encodePairStorageBatchResult,
  parsePairStorageBatchResult, readPairStorageBatchJson, PAIR_STORAGE_BATCH_BODY_LIMIT,
  PAIR_STORAGE_BATCH_JSON_LIMIT } from "../packages/content-core/src/public-release-storage-batch";

const keys = ["first", "second"], bytes = new Uint8Array([0, 1, 254, 255]);
const writes = () => JSON.parse(encodePairStorageBatchRequest(keys.map(key => ({ key, body: bytes, customMetadata: { digest: key } })), true));
it("round trips binary and empty bodies without changing caller bytes or metadata", () => {
  const value = writes(); value.items[1].bodyBase64 = "";
  const parsed = parsePairStorageBatchRequest(value, true);
  expect(parsed).toEqual([{ key: "first", body: bytes, customMetadata: { digest: "first" } },
    { key: "second", body: new Uint8Array(), customMetadata: { digest: "second" } }]);
  parsed[0].body![0] = 42; expect(bytes[0]).toBe(0);
  const encoded = encodePairStorageBatchResult([{ key: keys[0], status: 200, size: 0, body: new Uint8Array(), customMetadata: {} },
    { key: keys[1], status: 404 }]);
  expect(parsePairStorageBatchResult(JSON.parse(encoded), keys, false)).toEqual([
    { key: keys[0], status: 200, size: 0, body: new Uint8Array(), customMetadata: {} }, { key: keys[1], status: 404 }]);
});
it.each(["schema", "extra", "member-extra", "duplicate", "one", "five", "bad-base64", "too-large", "metadata"])(
  "refuses malformed %s before use", fault => {
    const value = writes();
    if (fault === "schema") value.schemaVersion = 2;
    if (fault === "extra") value.authorized = true;
    if (fault === "member-extra") value.items[0].authorized = true;
    if (fault === "duplicate") value.items[1].key = value.items[0].key;
    if (fault === "one") value.items.pop();
    if (fault === "five") value.items = Array.from({ length: 5 }, (_, index) => ({ ...value.items[0], key: String(index) }));
    if (fault === "bad-base64") value.items[0].bodyBase64 = "AA==\n";
    if (fault === "too-large") value.items[0].bodyBase64 = Buffer.alloc(PAIR_STORAGE_BATCH_BODY_LIMIT + 1).toString("base64");
    if (fault === "metadata") value.items[0].customMetadata = { digest: 42 };
    expect(() => parsePairStorageBatchRequest(value, true)).toThrow();
  });
it("refuses reordered, incomplete and unknown response members", () => {
  const value = JSON.parse(encodePairStorageBatchResult(keys.map(key => ({ key, status: 201 }))));
  expect(parsePairStorageBatchResult(value, keys, true)).toEqual(keys.map(key => ({ key, status: 201 })));
  expect(() => parsePairStorageBatchResult(value, [...keys].reverse(), true)).toThrow();
  expect(() => parsePairStorageBatchResult(value, [keys[0]], true)).toThrow();
  value.items[0].status = 202;
  expect(() => parsePairStorageBatchResult(value, keys, true)).toThrow();
});
it.each(["missing-size", "short", "long", "oversize", "invalid-utf8"])("bounds complete %s envelopes", async fault => {
  const body = new Uint8Array(fault === "invalid-utf8" ? [255] : [123, 125]);
  const headers = new Headers();
  if (fault !== "missing-size") headers.set("content-length", String(fault === "short" ? 3 : fault === "long" ? 1
    : fault === "oversize" ? PAIR_STORAGE_BATCH_JSON_LIMIT + 1 : body.length));
  expect(await readPairStorageBatchJson(new Response(body, { headers }))).toBe(null);
});
