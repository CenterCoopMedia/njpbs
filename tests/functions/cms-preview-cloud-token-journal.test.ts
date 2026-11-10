import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import admin from "../helpers/firebase-admin.js";
import { openCmsPreviewCloudTokenJournal } from "../../site/scripts/cms-preview-cloud-token-journal";

const queueId = "abcdefghijklmnopqrst";
const reservation = { queueId, buildBatchId: `preview-${queueId}`, commitSha: "a".repeat(40) };

describe("CMS preview cloud token journal", () => {
  beforeAll(() => {
    if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Use the Firestore emulator for token journal tests.");
    if (!admin.apps.length) admin.initializeApp({ projectId: "demo-njpbs" });
  });
  async function fixture() {
    const firestore = admin.firestore();
    const serializerId = `preview-${randomUUID()}`;
    const options = { firestore, serializerId };
    return { options, journal: await openCmsPreviewCloudTokenJournal(options), ref: firestore.doc(`cmsPreviewSerializerJournals/${serializerId}`) };
  }

  it("reserves one exact token concurrently, restores it on restart, and rejects a different job", async () => {
    const { options, journal } = await fixture();
    const results = await Promise.all([journal.reserve(reservation), journal.reserve(reservation)]);
    expect(results.map(result => result.idempotent).sort()).toEqual([false, true]);
    expect(results[0].job).toEqual(results[1].job);
    expect(new Date(results[0].job.createdAt).toISOString()).toBe(results[0].job.createdAt);
    const reopened = await openCmsPreviewCloudTokenJournal(options);
    expect(await reopened.read()).toEqual(results[0].job);
    await expect(reopened.reserve({ ...reservation, commitSha: "b".repeat(40) })).rejects.toThrow("another job");
    expect(await reopened.read()).toEqual(results[0].job);
  }, 30_000);

  it("clears only the matching queue and raw token, with idempotent absent clears", async () => {
    const { journal } = await fixture();
    const { job } = await journal.reserve(reservation);
    await expect(journal.clear({ queueId, claimToken: randomUUID() })).rejects.toThrow("conflicts");
    await expect(journal.clear({ queueId: "z".repeat(20), claimToken: job.claimToken })).rejects.toThrow("conflicts");
    expect(await journal.read()).toEqual(job);
    expect(await journal.clear({ queueId, claimToken: job.claimToken })).toEqual({ idempotent: false });
    expect(await journal.clear({ queueId, claimToken: job.claimToken })).toEqual({ idempotent: true });
    expect(await journal.read()).toBeNull();
    expect((await journal.reserve(reservation)).job.claimToken).not.toBe(job.claimToken);
  });

  it("rejects malformed or mismatched stored records without overwriting them", async () => {
    const { journal, ref, options } = await fixture();
    const { job } = await journal.reserve(reservation);
    const valid = { schemaVersion: 1, serializerId: options.serializerId, job };
    for (const state of [
      { ...valid, schemaVersion: 2 }, { ...valid, serializerId: "another" }, { ...valid, extra: true },
      { ...valid, job: { ...job, queueId: 12345678901234567890 } },
      { ...valid, job: { ...job, buildBatchId: "publication" } },
      { ...valid, job: { ...job, claimToken: "invalid" } },
      { ...valid, job: { ...job, createdAt: "2026-09-09" } },
      { ...valid, job: { ...job, extra: true } },
    ]) {
      await ref.set(state);
      await expect(journal.read()).rejects.toThrow("invalid");
      await expect(journal.reserve(reservation)).rejects.toThrow("invalid");
      await expect(journal.clear({ queueId, claimToken: job.claimToken })).rejects.toThrow("invalid");
      expect((await ref.get()).data()).toEqual(state);
    }
  });

  it("rejects non-preview reservations and invalid serializer identities", async () => {
    const { journal, options } = await fixture();
    await expect(journal.reserve({ ...reservation, buildBatchId: "publication" })).rejects.toThrow("invalid");
    await expect(openCmsPreviewCloudTokenJournal({ ...options, serializerId: "invalid/path" })).rejects.toThrow("invalid");
    expect(await journal.read()).toBeNull();
  });
});
