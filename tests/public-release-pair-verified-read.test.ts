import { expect, it } from "vitest";
import { readPublicReleasePairVerifiedBytes as read, withPublicReleasePairVerifiedReads as scope } from "../site/scripts/public-release-pair-verified-read";
import type { PairViewStore } from "../site/scripts/public-release-pair-view-storage";

const store: PairViewStore = { get: async () => { throw new Error("Unexpected storage read"); }, put: async () => {} };
const key = `release-pair-inputs/v2/pair/objects/${"a".repeat(64)}.json`, seal = { bodydigest: "a".repeat(64), pairdigest: "pair" };

it("shares verified in-flight bytes, with independent copies and fresh task boundaries", async () => {
  let reads = 0, retained: PairViewStore;
  const fresh = async () => { reads++; return new Uint8Array([1, 2]); };
  await scope(store, async scoped => {
    retained = scoped;
    const [first, second] = await Promise.all([read(scoped, key, 2, seal, undefined, fresh), read(scoped, key, 2, seal, undefined, fresh)]);
    first[0] = 9;
    expect(second).toEqual(new Uint8Array([1, 2]));
    expect(await read(scoped, key, 2, seal, undefined, fresh)).toEqual(second);
    expect(reads).toBe(1);
  });
  await read(retained!, key, 2, seal, undefined, fresh);
  await scope(store, scoped => read(scoped, key, 2, seal, undefined, fresh));
  expect(reads).toBe(3);
});

it("never retains failures, another expected seal, or a key that was written", async () => {
  let reads = 0;
  const fresh = async () => { reads++; return new Uint8Array([1]); };
  await scope(store, async scoped => {
    await expect(read(scoped, key, 1, seal, undefined, async () => { throw new Error("original codec refusal"); })).rejects.toThrow("original codec refusal");
    await read(scoped, key, 1, seal, undefined, fresh);
    await read(scoped, key, 1, { ...seal, pairdigest: "other-pair" }, undefined, fresh);
    await scoped.put(key, new Uint8Array([1]), { onlyIf: { etagDoesNotMatch: "*" }, sha256: seal.bodydigest, customMetadata: seal });
    await read(scoped, key, 1, seal, undefined, fresh);
    expect(reads).toBe(3);
  });
});

it("bounds the retained roster and always freshly reads G output bodies", async () => {
  let reads = 0;
  const fresh = async () => { reads++; return new Uint8Array([1]); };
  await scope(store, async scoped => {
    for (let index = 0; index < 129; index++) await read(scoped, `${key}/${index}`, 1, seal, undefined, fresh);
    await read(scoped, `${key}/128`, 1, seal, undefined, fresh);
    expect(reads).toBe(130);
    const output = `release-pairs/pair/task/claims/claim/objects/${"a".repeat(64)}`;
    await read(scoped, output, 1, seal, undefined, fresh);
    await read(scoped, output, 1, seal, undefined, fresh);
    expect(reads).toBe(132);
  });
});

it("honors abort even for a retained body and leaves raw stores fresh", async () => {
  let reads = 0;
  const fresh = async () => { reads++; return new Uint8Array([1]); };
  await read(store, key, 1, seal, undefined, fresh);
  await read(store, key, 1, seal, undefined, fresh);
  await scope(store, async scoped => {
    await read(scoped, key, 1, seal, undefined, fresh);
    const controller = new AbortController(); controller.abort();
    await expect(read(scoped, key, 1, seal, controller.signal, fresh)).rejects.toThrow();
  });
  expect(reads).toBe(3);
});

it("invalidates a read that finishes while a write to its immutable key is still in flight", async () => {
  let release!: () => void, reads = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const boundary: PairViewStore = { ...store, put: async () => { await gate; } };
  await scope(boundary, async scoped => {
    const write = scoped.put(key, new Uint8Array([1]), { onlyIf: { etagDoesNotMatch: "*" }, sha256: seal.bodydigest, customMetadata: seal });
    try {
      const fresh = async () => new Uint8Array([++reads]);
      expect(await read(scoped, key, 1, seal, undefined, fresh)).toEqual(new Uint8Array([1]));
      release(); await write;
      expect(await read(scoped, key, 1, seal, undefined, fresh)).toEqual(new Uint8Array([2]));
    } finally { release(); await write; }
  });
});
