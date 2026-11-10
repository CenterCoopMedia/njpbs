import { beforeAll, beforeEach, expect, it } from "vitest";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import log from "../../functions/lib/public-release-change-log.js";
import { changeInput } from "../helpers/public-release-pair.js";

let db;
const baselineDigest = "f".repeat(64);
const headPath = log.PUBLIC_RELEASE_CHANGES_PATH;
beforeAll(() => { db = isolatedFirestore("public-release-change-log.test.js"); });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`,
    { method: "DELETE" }, db);
  await db.doc(headPath).set(log.initialPublicReleaseChangeHead(baselineDigest));
});
const append = input => db.runTransaction(transaction => log.appendPublicReleaseChangeInTransaction({ firestore: db, transaction, input }));
const entries = async () => (await db.collection(`${headPath}/entries`).orderBy("sequence").get()).docs.map(row => row.data());

it("serializes concurrent mutations into a complete chain, with one idempotent operation", async () => {
  const input = changeInput();
  const [one, two, retry] = await Promise.all([append(input), append(changeInput("publication-two")), append(input)]);
  expect(one.entry).toEqual(retry.entry);
  expect([one.idempotent, retry.idempotent].sort()).toEqual([false, true]);
  expect(new Set([one.entry.sequence, two.entry.sequence])).toEqual(new Set([1, 2]));
  const page = await entries();
  expect(page.map(entry => entry.operationId).sort()).toEqual(["publication-one", "publication-two"]);
  const cursor = log.verifyPublicReleaseChangePage({ sequence: 0, lastDigest: baselineDigest }, page);
  const head = (await db.doc(headPath).get()).data();
  expect(cursor).toEqual({ sequence: head.sequence, lastDigest: head.lastDigest });
  expect((await db.collection(`${headPath}/operations`).get()).size).toBe(2);
});

it("aborts source and outbox together without allocating a sequence gap", async () => {
  await expect(db.runTransaction(async transaction => {
    await log.appendPublicReleaseChangeInTransaction({ firestore: db, transaction, input: changeInput() });
    transaction.create(db.doc("cmsPosts/post-one"), { publishedVersion: 4 });
    throw new Error("source mutation refused");
  })).rejects.toThrow("source mutation refused");
  expect(await entries()).toEqual([]);
  expect((await db.doc("cmsPosts/post-one").get()).exists).toBe(false);
  const result = await db.runTransaction(async transaction => {
    const result = await log.appendPublicReleaseChangeInTransaction({ firestore: db, transaction, input: changeInput() });
    transaction.create(db.doc("cmsPosts/post-one"), { publishedVersion: 4 });
    return result;
  });
  expect(result.entry.sequence).toBe(1);
  expect((await db.doc("cmsPosts/post-one").get()).data()).toEqual({ publishedVersion: 4 });
});

it("deduplicates reordered multi-record inputs, refusing a changed payload for the same operation", async () => {
  const input = changeInput();
  input.changes.push({ kind: "media", id: "image-one", action: "dependency", sourceVersion: 2, snapshotDigest: "e".repeat(64) });
  const first = await append(input);
  const retry = await append({ ...input, changes: [...input.changes].reverse() });
  expect(retry.entry).toEqual(first.entry);
  expect(retry.idempotent).toBe(true);
  await expect(append({ ...input, contextRevision: 13 })).rejects.toThrow();
  expect(await entries()).toHaveLength(1);
});

it("refuses missing bootstrap, overflow, corrupted indexes and incomplete or reordered pages", async () => {
  await db.doc(headPath).delete();
  await expect(append(changeInput())).rejects.toThrow();
  await db.doc(headPath).set({ ...log.initialPublicReleaseChangeHead(baselineDigest), sequence: Number.MAX_SAFE_INTEGER });
  await expect(append(changeInput())).rejects.toThrow();
  await db.doc(headPath).set(log.initialPublicReleaseChangeHead(baselineDigest));
  await append(changeInput());
  await append(changeInput("publication-two"));
  const page = await entries();
  const cursor = { sequence: 0, lastDigest: baselineDigest };
  expect(() => log.verifyPublicReleaseChangePage(cursor, page.slice(1))).toThrow();
  expect(() => log.verifyPublicReleaseChangePage(cursor, [...page].reverse())).toThrow();
  expect(() => log.verifyPublicReleaseChangePage(cursor, [{ ...page[0], contextRevision: 99 }])).toThrow();
  await db.doc(`${headPath}/operations/publication-one`).update({ entryDigest: "0".repeat(64) });
  await expect(append(changeInput())).rejects.toThrow();
  expect(await entries()).toEqual(page);
});

it("refuses duplicate identities, missing fields and unknown mutation contracts", async () => {
  const input = changeInput();
  const patches = [
    { changes: [] }, { changes: [input.changes[0], input.changes[0]] },
    { changes: [{ ...input.changes[0], kind: "unknown" }] },
    { changes: [{ ...input.changes[0], snapshotDigest: null }] },
    { changes: [{ ...input.changes[0], undocumented: true }] },
    { contextRevision: 0 }, { operationId: "../unsafe" }, { unknown: true },
  ];
  for (const patch of patches) await expect(append({ ...input, ...patch })).rejects.toThrow();
  for (const key of Object.keys(input)) {
    const broken = structuredClone(input); delete broken[key];
    await expect(append(broken)).rejects.toThrow();
  }
  expect(await entries()).toEqual([]);
});
