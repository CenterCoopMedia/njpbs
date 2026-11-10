// @vitest-environment node

import type { Firestore } from "firebase-admin/firestore";
import { describe, expect, it, vi } from "vitest";
import { openCmsPublicationCloudTokenJournal } from "../scripts/cms-publication-cloud-token-journal";

const SERIALIZER_ID = "cloud-publication-primary";
const QUEUE_ID = "11111111111111111111";
const BUILD_BATCH_ID = `cms-${QUEUE_ID}`;
const COMMIT_SHA = "a".repeat(40);

function database() {
  let value: unknown;
  const snapshot = () => ({
    exists: value !== undefined,
    data: () => structuredClone(value),
  });
  const ref = { get: async () => snapshot() };
  const doc = vi.fn(() => ref);
  const collection = vi.fn(() => ({ doc }));
  const transactionSet = vi.fn();
  const firestore = {
    collection,
    runTransaction: async <T>(run: (transaction: unknown) => Promise<T>) => {
      let staged: unknown;
      const set = (target: unknown, next: unknown) => {
        transactionSet(target, next);
        expect(target).toBe(ref);
        staged = structuredClone(next);
      };
      const result = await run({
        get: async (target: unknown) => {
          expect(target).toBe(ref);
          return snapshot();
        },
        set,
      });
      if (staged !== undefined) value = staged;
      return result;
    },
  } as unknown as Firestore;
  return {
    firestore,
    collection,
    doc,
    readState: () => structuredClone(value),
  };
}

const reservation = {
  queueId: QUEUE_ID,
  buildBatchId: BUILD_BATCH_ID,
  commitSha: COMMIT_SHA,
};

describe("CMS publication cloud token journal", () => {
  it("reuses the transactionally persisted raw token after restart", async () => {
    const db = database();
    const journal = await openCmsPublicationCloudTokenJournal({
      firestore: db.firestore,
      serializerId: SERIALIZER_ID,
    });
    const first = await journal.reserve(reservation);
    const reopened = await openCmsPublicationCloudTokenJournal({
      firestore: db.firestore,
      serializerId: SERIALIZER_ID,
    });

    await expect(reopened.reserve(reservation)).resolves.toEqual({
      idempotent: true,
      job: first.job,
    });
    expect(first.idempotent).toBe(false);
    expect(first.job.claimToken).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
    );
    expect(db.readState()).toEqual({
      schemaVersion: 1,
      serializerId: SERIALIZER_ID,
      job: first.job,
    });
    expect(journal.journalPath).toBe(
      `firestore:cmsPublicationSerializerJournals/${SERIALIZER_ID}`,
    );
    expect(db.collection).toHaveBeenCalledWith(
      "cmsPublicationSerializerJournals",
    );
    expect(db.doc).toHaveBeenCalledWith(SERIALIZER_ID);
  });

  it.each([
    [
      "another queue",
      {
        queueId: "22222222222222222222",
        buildBatchId: "cms-22222222222222222222",
        commitSha: COMMIT_SHA,
      },
    ],
    ["another source", { ...reservation, commitSha: "b".repeat(40) }],
  ])("refuses to replace a reservation for %s", async (_label, conflict) => {
    const db = database();
    const journal = await openCmsPublicationCloudTokenJournal({
      firestore: db.firestore,
      serializerId: SERIALIZER_ID,
    });
    const first = await journal.reserve(reservation);

    await expect(journal.reserve(conflict)).rejects.toThrow(
      "already has another job",
    );
    await expect(journal.read()).resolves.toEqual(first.job);
  });

  it("clears only the matching queue and raw token", async () => {
    const db = database();
    const journal = await openCmsPublicationCloudTokenJournal({
      firestore: db.firestore,
      serializerId: SERIALIZER_ID,
    });
    const { job } = await journal.reserve(reservation);

    await expect(
      journal.clear({
        queueId: QUEUE_ID,
        claimToken: "22222222-2222-4222-8222-222222222222",
      }),
    ).rejects.toThrow("clear request conflicts");
    await expect(journal.read()).resolves.toEqual(job);
    await expect(
      journal.clear({
        queueId: QUEUE_ID,
        claimToken: job.claimToken,
      }),
    ).resolves.toEqual({ idempotent: false });
    await expect(journal.read()).resolves.toBeNull();
    await expect(
      journal.clear({
        queueId: QUEUE_ID,
        claimToken: job.claimToken,
      }),
    ).resolves.toEqual({ idempotent: true });
  });
});
