import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { publicReleaseR2Fixture } from "../helpers/public-release-r2-fixture";

it("streams fresh real R2 bytes and plain metadata, retaining conditional writes, checksums and cancellation", async () => {
  const { runtime, store } = await publicReleaseR2Fixture("pair-fixture-contract");
  try {
    const bytes = new TextEncoder().encode("actual R2 fixture bytes"), key = "pair/object";
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(await store.get(key)).toBeNull();
    await store.put(key, bytes, { onlyIf: { etagDoesNotMatch: "*" }, sha256, customMetadata: { bodydigest: sha256, label: "é" } });
    const direct = await runtime.getR2Bucket("CONTENT"), expected = (await direct.get(key))!;
    const observed = (await store.get(key))!;
    expect(observed.size).toBe(expected.size);
    expect(observed.customMetadata).toEqual(expected.customMetadata);
    expect(observed.etag).toBe(expected.etag);
    expect(observed.uploaded.toISOString()).toBe(expected.uploaded.toISOString());
    expect(Object.getOwnPropertyDescriptor(observed, "size")?.value).toBe(bytes.length);
    expect(observed.bodyUsed).toBe(false);
    expect(new Uint8Array(await observed.arrayBuffer())).toEqual(bytes);
    expect(observed.bodyUsed).toBe(true);
    await expected.body.cancel();
    // A failed create-only replacement must preserve the actual retained bytes.
    expect(await store.put(key, new TextEncoder().encode("overwrite"), { onlyIf: { etagDoesNotMatch: "*" } })).toBeNull();
    expect(await (await store.get(key))!.text()).toBe(new TextDecoder().decode(bytes));
    await expect(store.put("bad-checksum", bytes, { sha256: "0".repeat(64) })).rejects.toThrow();
    expect(await store.get("bad-checksum")).toBeNull();
    const canceled = (await store.get(key))!;
    await canceled.body.cancel();
    const latest = new TextEncoder().encode("changed actual bytes");
    await direct.put(key, latest, { customMetadata: { revision: "2" } });
    const changed = (await store.get(key))!;
    expect(changed.customMetadata).toEqual({ revision: "2" });
    expect(new Uint8Array(await changed.arrayBuffer())).toEqual(latest);
    expect((await store.list({ prefix: "pair/" })).objects.map(object => object.key)).toEqual([key]);
    expect((await store.head(key))!.size).toBe(latest.length);
    await store.delete(key);
    expect(await store.get(key)).toBeNull();
    await expect(store.get(key, {})).rejects.toThrow("GET options are unsupported");
  } finally { await runtime.dispose(); }
}, 30_000);
