import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { pausePreviewRuntime, previewRuntimeDrained } from "../../site/scripts/deploy-cms-preview-cloud";

const oldSha = "a".repeat(40);
const newSha = "b".repeat(40);
const serializerId = "cloudflare-preview";
const queueId = "abcdefghijklmnopqrst";
const runtimePath = "system/cmsPreviewRuntime";
const journalPath = `cmsPreviewSerializerJournals/${serializerId}`;
const queuePath = `cmsPreviewQueue/${queueId}`;
let db: Firestore;

async function clearFixtures() {
  await Promise.all([runtimePath, journalPath, queuePath].map(path => db.doc(path).delete()));
}

beforeAll(() => {
  // Drain reads the whole queue; other suites may retain pending default-project jobs.
  db = isolatedFirestore("cms-preview-cloud-release.test.ts");
});
beforeEach(clearFixtures);
afterEach(clearFixtures);

describe("cloud preview release admission", () => {
  it("creates an absent runtime paused at the requested renderer and cloud identity", async () => {
    await pausePreviewRuntime(db, newSha);
    expect((await db.doc(runtimePath).get()).data()).toEqual({
      schemaVersion: 1, phase: "paused", rendererSha: newSha, serializerId,
    });
  });

  it("preserves the old ready renderer and serializer while pausing admission", async () => {
    const current = { schemaVersion: 1, phase: "ready", rendererSha: oldSha, serializerId: "node-compute-preview-primary" };
    await db.doc(runtimePath).set(current);
    await pausePreviewRuntime(db, newSha);
    expect((await db.doc(runtimePath).get()).data()).toEqual({ ...current, phase: "paused" });
  });

  it.each([
    {}, { schemaVersion: 2, phase: "ready", rendererSha: oldSha, serializerId },
    { schemaVersion: 1, phase: "ready", rendererSha: "bad-sha", serializerId },
    { schemaVersion: 1, phase: "unknown", rendererSha: oldSha, serializerId },
  ])("refuses malformed stored control without overwriting it", async current => {
    await db.doc(runtimePath).set(current);
    await expect(pausePreviewRuntime(db, newSha)).rejects.toThrow();
    expect((await db.doc(runtimePath).get()).data()).toEqual(current);
  });
});

describe("cloud preview release drain", () => {
  it.each(["pending", "building"])("waits for a serializer queue in %s", async status => {
    await db.doc(queuePath).set({ transport: "serializer", status });
    expect(await previewRuntimeDrained(db)).toBe(false);
  });

  it("ignores pending GitHub transport work", async () => {
    await db.doc(queuePath).set({ transport: "github", status: "pending" });
    expect(await previewRuntimeDrained(db)).toBe(true);
  });

  it("waits for a retained cloud claim even after its queue is terminal", async () => {
    await db.doc(queuePath).set({ transport: "serializer", status: "ready" });
    await db.doc(journalPath).set({ schemaVersion: 1, serializerId, job: {
      queueId, buildBatchId: `preview-${queueId}`, commitSha: oldSha,
      claimToken: randomUUID(), createdAt: "2026-09-09T12:00:00.000Z",
    } });
    expect(await previewRuntimeDrained(db)).toBe(false);
  });

  it.each(["ready", "failed", "expired"])("is drained for a %s queue with absent or cleared journal", async status => {
    await db.doc(queuePath).set({ transport: "serializer", status });
    expect(await previewRuntimeDrained(db)).toBe(true);
    await db.doc(journalPath).set({ schemaVersion: 1, serializerId, job: null });
    expect(await previewRuntimeDrained(db)).toBe(true);
  });

  it("fails closed on a malformed cloud journal", async () => {
    await db.doc(journalPath).set({ schemaVersion: 1, serializerId, job: { claimToken: "invalid" } });
    await expect(previewRuntimeDrained(db)).rejects.toThrow(/journal.*invalid/);
  });
});
