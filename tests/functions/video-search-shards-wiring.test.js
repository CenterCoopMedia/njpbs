import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

let app, db;
beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_EMULATOR_HUB) {
    throw new Error("Use the Firestore and Functions emulators for trigger wiring");
  }
  const response = await fetch(`http://${process.env.FIREBASE_EMULATOR_HUB}/emulators`);
  expect(response.ok).toBe(true);
  expect((await response.json()).functions).toBeDefined();
  app = initializeApp({ projectId: "demo-njpbs" }, "video-search-trigger-wiring");
  db = getFirestore(app);
});
afterAll(async () => { if (db) await db.terminate(); if (app) await deleteApp(app); });

it("runs both registered search triggers and removes an obsolete descriptor", async () => {
  const id = `search-wiring-${randomUUID()}`;
  const epoch = randomUUID();
  const asset = db.collection("mediaSourceAssets").doc(id);
  const descriptor = db.collection("mediaSourceSearchShards").doc(id);
  const state = db.collection("mediaSourceSearchState").doc("video-library");
  await state.set({ complete: true, epoch });
  await descriptor.set({ sourceId: "video-library", generation: "before", pending: false, tombstone: true });
  let unsubscribe = () => {}, timeout;
  const removed = new Promise((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("Search triggers did not remove the obsolete descriptor")), 15_000);
    unsubscribe = descriptor.onSnapshot(snapshot => { if (!snapshot.exists) resolve(); }, reject);
  });
  try {
    // The asset trigger must enqueue this change; only the shard trigger can
    // remove its descriptor. Invalid/deleted metadata needs no external S3 work.
    await asset.set({ sourceId: "video-library", lifecycle: "deleted" });
    await removed;
    expect((await descriptor.get()).exists).toBe(false);
    const current = (await state.get()).data();
    expect(current.epoch).toMatch(/^[a-f0-9-]{36}$/);
    expect(current.epoch).not.toBe(epoch);
  } finally {
    clearTimeout(timeout); unsubscribe();
    await asset.delete();
    await descriptor.delete();
  }
});
