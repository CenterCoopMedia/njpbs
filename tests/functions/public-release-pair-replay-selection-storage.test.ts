import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { createHash } from "node:crypto";
import { releasePair } from "../helpers/private-public-release-pair.js";
import protocol from "../../functions/lib/public-release-pair.js";
import {
  readPublicReleasePairReplaySelection,
  writePublicReleasePairReplaySelection,
  type ReplaySelectionMember,
} from "../../site/scripts/public-release-pair-replay-selection-storage";

const pair = releasePair(),
  cursor = { baselineDigest: "b".repeat(64), sequence: 2, lastDigest: "c".repeat(64) };
let runtime: Miniflare, store: R2Bucket;
const reference = {
  identity: {
    schemaVersion: 2 as const,
    pair: protocol.publicReleasePairReference(pair),
    kind: "qualification" as const,
    sourceOperationId: "operation-one",
    sourceVersion: 1,
    snapshotDigest: "d".repeat(64),
    contextSequence: 2,
    inputManifestDigest: "e".repeat(64),
  },
  claimDigest: "f".repeat(64),
  manifestDigest: "a".repeat(64),
  manifestBytes: 100,
};
const row = (index: number): ReplaySelectionMember => ({
  path: `/entry-${String(index).padStart(6, "0")}/`,
  view: reference,
  bodyDigest: createHash("sha256").update(`body-${index}`).digest("hex"),
});
const write = (members: ReplaySelectionMember[], kind: "content" | "code-pack-overlay" = "content") =>
  writePublicReleasePairReplaySelection({ store, pair, kind, cursor, members });
async function read(digest: string, overrides = {}) {
  const rows = [];
  for await (const row of readPublicReleasePairReplaySelection({
    store,
    pair,
    kind: "content",
    cursor,
    digest,
    ...overrides,
  }))
    rows.push(row);
  return rows;
}
beforeAll(async () => {
  runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "pair-replay-store",
          type: "worker",
          compatibilityDate: "2026-07-09",
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" },
            },
          },
          env: { CONTENT: { type: "r2", name: "replay-selections" } },
        },
      },
    ],
  });
  store = await runtime.getR2Bucket("CONTENT");
});
beforeEach(async () => {
  const objects = await store.list();
  if (objects.objects.length) await store.delete(objects.objects.map((object) => object.key));
});
afterAll(async () => {
  await runtime?.dispose();
});

it("retains every sorted member across a page boundary and retries immutable writes", async () => {
  const members = Array.from({ length: 257 }, (_, index) => row(index));
  const first = await write(members),
    retry = await write(members);
  expect(first.root.pages.map((page) => page.count)).toEqual([256, 1]);
  expect(first.root.count).toBe(257);
  expect(retry).toEqual(first);
  expect(await read(first.digest)).toEqual(members);
});

it("seals an explicit empty overlay and rejects another kind, cursor or pair", async () => {
  const empty = await write([], "code-pack-overlay");
  expect(empty.root.count).toBe(0);
  expect(await read(empty.digest, { kind: "code-pack-overlay" })).toEqual([]);
  await expect(read(empty.digest)).rejects.toThrow();
  const content = await write([row(1)]);
  await expect(read(content.digest, { cursor: { ...cursor, sequence: 3 } })).rejects.toThrow();
  await expect(read(content.digest, { pair: releasePair("b", "b".repeat(40)) })).rejects.toThrow();
});

it("refuses duplicate paths, gaps in sorting and future or incomplete view references", async () => {
  await expect(write([row(1), row(1)])).rejects.toThrow();
  await expect(write([row(2), row(1)])).rejects.toThrow();
  await expect(write([{ ...row(1), path: "/../unsafe/" }])).rejects.toThrow();
  await expect(
    write([{ ...row(1), view: { ...reference, identity: { ...reference.identity, contextSequence: 3 } } }]),
  ).rejects.toThrow();
  await expect(write([{ ...row(1), view: { ...reference, manifestBytes: 0 } }])).rejects.toThrow();
});

it.each(["page", "root", "metadata", "missing"])(
  "refuses %s corruption and never repairs immutable storage",
  async (mode) => {
    const written = await write([row(1), row(2)]);
    const listing = await store.list();
    const key = listing.objects.find((object) =>
      object.key.includes(mode === "root" ? "/selections/" : "/pages/"),
    )!.key;
    const original = await store.get(key),
      bytes = new Uint8Array(await original!.arrayBuffer());
    if (mode === "missing") await store.delete(key);
    else if (mode === "metadata") await store.put(key, bytes, { customMetadata: {} });
    else {
      bytes[0] ^= 1;
      await store.put(key, bytes, { customMetadata: original!.customMetadata });
    }
    await expect(read(written.digest)).rejects.toThrow();
    if (mode !== "missing") await expect(write([row(1), row(2)])).rejects.toThrow();
  },
);

it("does not turn a partly consumed first page into full coverage", async () => {
  const written = await write(Array.from({ length: 257 }, (_, index) => row(index)));
  const listing = await store.list();
  const key = listing.objects.find((object) => object.key.includes(`/pages/${written.root.pages[1].digest}.json`))!.key;
  await store.delete(key);
  const iterator = readPublicReleasePairReplaySelection({
    store,
    pair,
    kind: "content",
    cursor,
    digest: written.digest,
  });
  expect((await iterator.next()).value).toEqual(row(0));
  await iterator.return(undefined);
  await expect(read(written.digest)).rejects.toThrow();
});

it("preserves exact NFC Unicode paths and refuses decoded or non-NFC aliases", async () => {
  const member = { ...row(1), path: "/caf\u00e9.json" };
  const written = await write([member], "code-pack-overlay");
  expect(await read(written.digest, { kind: "code-pack-overlay" })).toEqual([member]);
  await expect(write([member])).rejects.toThrow();
  await expect(write([{ ...member, path: "/cafe\u0301.json" }], "code-pack-overlay")).rejects.toThrow();
  await expect(write([{ ...member, path: "/caf%C3%A9.json" }])).rejects.toThrow();
  await expect(write([{ ...member, path: "/caf\u00e9.json?latest" }])).rejects.toThrow();
});

it("keeps unknown artifact file paths out of content selections", async () => {
  await expect(write([{ ...row(1), path: "/unknown.json" }])).rejects.toThrow();
  await expect(write([{ ...row(1), path: "/unknown.css" }])).rejects.toThrow();
});
