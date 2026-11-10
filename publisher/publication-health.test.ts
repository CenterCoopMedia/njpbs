import { expect, it } from "vitest";
import { checkCloudHealthContract, checkMultipleCloudHealthContract } from "../tests/no-build-cloud-health-contract";
import { documents, runtime } from "../tests/no-build-cloud-contract";
import { Timestamp } from "firebase-admin/firestore";
import { OVERDUE_MS, readPublicationHealth } from "./publication-health";
import publicContext from "../functions/lib/public-context-revision.js";

it("observes overdue, exhausted, withdrawn, prior-release and uncertain work in Node", async () => {
  await expect(checkCloudHealthContract()).resolves.toBeUndefined();
});

it("observes every selected current Post and ignores historical preparations", async () => {
  await expect(checkMultipleCloudHealthContract()).resolves.toBeUndefined();
});

function previewHealthFixture() {
  const docs = documents();
  delete docs["system/publicDeployment/noBuildPosts/current"]; delete docs["cmsBackgroundOutputs/listings"];
  docs["system/publicDeployment/aggregateContexts/current"].acceptedAt = 1000;
  docs["system/publicDeployment"].activeGeneration = 2;
  docs["system/publicDeployment"].updatedAt = Timestamp.fromMillis(1_000_000);
  const preview = docs[`cmsPublishQueue/${"D".repeat(20)}`].previewContext;
  return { docs, preview, health: (now: number) => readPublicationHealth({ runtime, now, read: async name => docs[name] ?? null }) };
}

it.each(["verified", "failed"])("gives new CODE retention its durable budget after %s older generation", async status => {
  const f = previewHealthFixture();
  if (status === "failed") Object.assign(f.preview, { status, attempts: 4, startedAt: 1000, nextAttemptAt: null });
  const fresh = await f.health(1_000_000);
  expect(fresh).toEqual({ healthy: true, reasons: [], oldestDueAt: 1_000_000 });
  const overdue = await f.health(1_000_000 + OVERDUE_MS);
  expect(overdue.reasons).toContain("work_overdue"); expect(overdue.reasons).not.toContain("preview_context_exhausted");
  expect(overdue.oldestDueAt).toBe(1_000_000);
});

it("preserves a current generation's original attempt age and exhaustion despite pointer updates", async () => {
  const f = previewHealthFixture();
  Object.assign(f.preview, { status: "failed", publicationGeneration: 2, attempts: 4, startedAt: 1000, nextAttemptAt: null });
  const health = await f.health(1_000_000);
  expect(health.oldestDueAt).toBe(1000); expect(health.reasons).toContain("work_overdue");
  expect(health.reasons).toContain("preview_context_exhausted");
});

it.each([undefined, -1, 1_000_001])("refuses unknown or invalid new-generation health clock %s", async updatedAt => {
  const f = previewHealthFixture(); f.docs["system/publicDeployment"].updatedAt = updatedAt;
  expect((await f.health(1_000_000)).reasons).toContain("state_unreadable");
});

it("anchors historical generation re-verification at the later acceptance when CODE predates it", async () => {
  const f = previewHealthFixture(); delete f.preview.publicationGeneration;
  f.docs["system/publicDeployment/aggregateContexts/current"].acceptedAt = 1_000_000;
  f.docs["system/publicDeployment"].updatedAt = 0;
  expect(await f.health(1_000_000)).toEqual({ healthy: true, reasons: [], oldestDueAt: 1_000_000 });
});

it.each(["programs", "events"])("reports overdue and exhausted %s namespace work", async family => {
  const docs = documents(), path = `cmsPublishQueue/${"A".repeat(20)}/backgroundOutputs/${family}`;
  docs[`cmsBackgroundOutputs/${family}`] = { ...docs["cmsBackgroundOutputs/listings"], contextOnly: true, taskPath: path };
  docs[path] = { runtime, status: "failed", attempts: 4, nextAttemptAt: null };
  const observed = await readPublicationHealth({ runtime, now: 1_000_000, read: async name => docs[name] ?? null });
  expect(observed.healthy).toBe(false);
  expect(observed.reasons).toContain("family_exhausted");
  expect(observed.reasons).toContain("work_overdue");
});

it("keeps the oldest unpublished change and allows only real selected replacement progress to postpone overdue", async () => {
  const operationId = "C".repeat(20), digest = publicContext.publicContextDigest(1);
  const taskPath = `cmsPublishQueue/${operationId}/backgroundOutputs/listings`;
  const preparation = { runtime, contextDigest: digest, status: "building", attempts: 1, nextAttemptAt: 600_000, progressAt: 240_000 };
  const docs = {
    "system/publicDeployment": { state: "idle", activeCommitSha: runtime.release },
    "system/publicDeployment/contexts/public": { schemaVersion: 1, revision: 2, changedAt: 180_000 },
    "system/publicDeployment/externalRefresh/current": { schemaVersion: 1, runtime, status: "verified", nextAttemptAt: 1_000_000 },
    "system/publicDeployment/aggregateContexts/current": { schemaVersion: 1, runtime, operationId, preparationOperationId: operationId,
      namespaceOperationId: operationId, contextDigest: digest, acceptedAt: 1000, pendingSince: 1000, followUp: { pendingSince: 90_000 } },
    [`cmsPublishQueue/${operationId}`]: { runtime, transport: "public-context-no-build-v1", status: "pending" },
    [`cmsPublishQueue/${operationId}/backgroundPreparation/${digest}`]: preparation,
    "cmsBackgroundOutputs/listings": { runtime, contextOnly: true, contextDigest: digest, status: "pending", taskPath, pendingSince: 1000 },
    [taskPath]: { runtime, status: "pending", attempts: 0, nextAttemptAt: 1000 },
  };
  const health = (now: number) => readPublicationHealth({ runtime, now, read: async name => docs[name] ?? null });
  expect(await health(360_000)).toEqual({ healthy: true, reasons: [], oldestDueAt: 1000 });
  // Coalescing newer changes never changes either reader-staleness clock.
  docs["system/publicDeployment/contexts/public"].revision = 3;
  docs["system/publicDeployment/contexts/public"].changedAt = 450_000;
  expect((await health(540_000)).reasons).toContain("work_overdue");
  // A recent progress timestamp with an expired claim cannot hide a stall.
  preparation.progressAt = 550_000;
  expect((await health(600_000)).reasons).toContain("work_overdue");
  preparation.status = "failed"; preparation.attempts = 4; preparation.nextAttemptAt = null;
  expect((await health(600_000)).reasons).toEqual(["preparation_exhausted", "work_overdue"]);
});

it.each(["pending", "failed"])("observes private retention exhaustion while unrelated outputs leave the aggregate %s", async status => {
  const f = previewHealthFixture(), id = "D".repeat(20);
  f.docs["system/publicDeployment/aggregateContexts/current"].preparationOperationId = id;
  f.docs[`cmsPublishQueue/${id}`].status = status;
  f.docs[`cmsPublishQueue/${id}/backgroundPreparation/${f.preview.contextDigest}`] = {
    runtime, status: "verified", contextDigest: f.preview.contextDigest, preparedDigest: "e".repeat(64) };
  Object.assign(f.preview, { status: "failed", publicationGeneration: 2, attempts: 4, startedAt: 1000, nextAttemptAt: null });
  expect((await f.health(1_000_000)).reasons).toContain("preview_context_exhausted");
  f.preview.manifestId = "invalid";
  expect((await f.health(1_000_000)).reasons).toContain("state_unreadable");

});

it.each(["building", "failed"])("observes projection-only retention exhaustion while public preparation is %s", async status => {
  const f = previewHealthFixture(), id = "D".repeat(20), inputDigest = "a".repeat(64);
  f.docs["system/publicDeployment/aggregateContexts/current"].preparationOperationId = id;
  f.docs[`cmsPublishQueue/${id}`].status = "pending";
  const preparation = { runtime, status, contextDigest: f.preview.contextDigest, inputDigest,
    attempts: 1, nextAttemptAt: 1_100_000,
    previewProjection: { schemaVersion: 1, status: "verified", inputDigest, digest: "b".repeat(64) } };
  f.docs[`cmsPublishQueue/${id}/backgroundPreparation/${f.preview.contextDigest}`] = preparation;
  Object.assign(f.preview, { status: "failed", publicationGeneration: 2, attempts: 4, startedAt: 1000, nextAttemptAt: null });
  const health = await f.health(1_000_000);
  expect(health.reasons).toContain("preview_context_exhausted");
  expect(health.reasons).not.toContain("preparation_exhausted");
  preparation.previewProjection.inputDigest = "c".repeat(64);
  expect((await f.health(1_000_000)).reasons).not.toContain("preview_context_exhausted");
});

it.each(["pending", "failed", "success"].flatMap(status =>
  ["missing", "same-generation", "older-generation"].map(retention => ({ status, retention }))))(
  "uses verified aggregate progress for $retention private retention while the queue is $status", async ({ status, retention }) => {
  const f = previewHealthFixture(), id = "D".repeat(20), progressAt = 1_000_000;
  f.docs["system/publicDeployment"].activeGeneration = retention === "older-generation" ? 2 : 1;
  f.docs["system/publicDeployment"].updatedAt = Timestamp.fromMillis(1000);
  f.docs["system/publicDeployment/aggregateContexts/current"].preparationOperationId = id;
  f.docs["system/publicDeployment/aggregateContexts/current"].progressAt = progressAt;
  f.docs[`cmsPublishQueue/${id}`].status = status;
  if (retention === "missing") delete f.docs[`cmsPublishQueue/${id}`].previewContext;
  else if (retention === "same-generation") Object.assign(f.preview, { status: "building", attempts: 1,
    startedAt: 1000, nextAttemptAt: progressAt + 1_000_000 });
  f.docs[`cmsPublishQueue/${id}/backgroundPreparation/${f.preview.contextDigest}`] = {
    runtime, status: "verified", contextDigest: f.preview.contextDigest, preparedDigest: "e".repeat(64), progressAt: progressAt - 1000 };
  expect(await f.health(progressAt + OVERDUE_MS - 1)).toEqual({ healthy: true, reasons: [], oldestDueAt: 1000 });
  expect(await f.health(progressAt + OVERDUE_MS)).toEqual({ healthy: false, reasons: ["work_overdue"], oldestDueAt: 1000 });
});

it.each(["stale-context", "previous-release"])("does not report private retention exhaustion for a %s aggregate", async reason => {
  const f = previewHealthFixture();
  const aggregate = f.docs["system/publicDeployment/aggregateContexts/current"];
  if (reason === "stale-context") aggregate.contextDigest = publicContext.publicContextDigest(2);
  else aggregate.runtime = { ...runtime, release: "f".repeat(40) };
  Object.assign(f.preview, { status: "failed", publicationGeneration: 2, attempts: 4, startedAt: 1000, nextAttemptAt: null });
  const observed = await f.health(1_000_000);
  expect(observed.reasons).not.toContain("preview_context_exhausted");
  f.preview.manifestId = "invalid";
  expect((await f.health(1_000_000)).reasons).not.toContain("state_unreadable");
});

it("excludes an active release refresh hold from overdue work until expiry", async () => {
  const { docs } = previewHealthFixture();
  const refresh = docs["system/publicDeployment/externalRefresh/current"];
  refresh.nextAttemptAt = 1;
  refresh.hold = { operationId: "H".repeat(20), startedAt: 1, until: 1_000_001 };
  const health = (now: number) => readPublicationHealth({ runtime, now, read: async name => docs[name] ?? null });
  expect((await health(1_000_000)).reasons).not.toContain("work_overdue");
  expect((await health(1_000_001)).reasons).toContain("work_overdue");
});
