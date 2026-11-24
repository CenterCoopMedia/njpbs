import { expect, it, vi } from "vitest";
import superseded from "../../functions/lib/superseded-preparation.js";

function fixture(queues) {
  const updates = [];
  const firestore = { collection: path => ({ where: (field, operator, value) => ({ path, field, operator, value }) }) };
  const transaction = {
    get: vi.fn(async query => ({ docs: Object.entries(queues[query.path.split("/")[1]] ?? {})
      .filter(([, value]) => value[query.field] === query.value)
      .map(([id, value]) => ({ id, ref: `${query.path}/${id}`, data: () => value })) })),
    update: (ref, value) => updates.push([ref, value]),
  };
  return { firestore, transaction, updates };
}

it("ends only a failed preparation that still keeps a retry time", async () => {
  const f = fixture({ Q: { retry: { status: "failed", claim: null, nextAttemptAt: 1 },
    exhausted: { status: "failed", claim: null, nextAttemptAt: null },
    claimed: { status: "failed", claim: "other", nextAttemptAt: 1 },
    building: { status: "building", claim: "other", nextAttemptAt: 1 }, verified: { status: "verified", nextAttemptAt: null } } });
  const write = await superseded.prepareSupersededPreparationsInTransaction({ ...f, queueIds: ["Q", "Q"] });
  expect(f.updates).toEqual([]);
  expect(f.transaction.get).toHaveBeenCalledOnce();
  write();
  expect(f.updates).toEqual([["cmsPublishQueue/Q/backgroundPreparation/retry",
    { status: "superseded", claim: null, nextAttemptAt: null }]]);
});

it("keeps a preparation that a live reader can still select", async () => {
  const row = { status: "failed", claim: null, nextAttemptAt: 1 };
  const f = fixture({ A: { current: row, old: row }, B: { current: row } });
  const write = await superseded.prepareSupersededPreparationsInTransaction({ ...f, queueIds: ["A", "B"],
    keep: (document, queueId) => document.id === "current" && queueId === "A" });
  write();
  expect(f.updates.map(([ref]) => ref)).toEqual(["cmsPublishQueue/A/backgroundPreparation/old", "cmsPublishQueue/B/backgroundPreparation/current"]);
});

it.each([["pending", 1, true], ["failed", 1, true], ["failed", null, false], ["verified", null, false]])(
  "ends a %s Post proof with retry time %s: %s", (status, nextAttemptAt, ends) => {
    const postProof = { status, nextAttemptAt, attempts: 2, claim: "wake", error: "check" };
    expect(superseded.supersededPostProof({ postProof })).toEqual(ends
      ? { postProof: { status: "superseded", nextAttemptAt: null, attempts: 2, claim: null, error: "check" } } : null);
  });
it("has no Post proof to end on a queue without one", () => {
  expect(superseded.supersededPostProof({ status: "success" })).toBeNull();
  expect(superseded.supersededPostProof(undefined)).toBeNull();
});
