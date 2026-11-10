import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { pausePreviewRuntime, previewRuntimeDrained } from "../../site/scripts/deploy-cms-preview-cloud";
import { collectDevRendererIdentity, verifyPinnedDevPreviewRenderer } from "../../preview-renderer/deploy-dev.mjs";

const oldSha = "a".repeat(40);
const newSha = "b".repeat(40);
const serializerId = "cloudflare-preview";
const queueId = "abcdefghijklmnopqrst";
const runtimePath = "system/cmsPreviewRuntime";
const journalPath = `cmsPreviewSerializerJournals/${serializerId}`;
const queuePath = `cmsPreviewQueue/${queueId}`;
const receiptPath = "cmsDeploymentReceipts/renderer";
let db: Firestore;

async function clearFixtures() {
  await Promise.all([runtimePath, journalPath, queuePath, receiptPath].map(path => db.doc(path).delete()));
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

describe("routine dev deployment verifies its existing renderer without writes", () => {
  const worker = "template-dev-cms-preview-renderer";
  const firstVersion = "11111111-1111-4111-8111-111111111111";
  const releaseStartedAt = "2026-10-11T16:00:00.000Z";
  let activeVersion: string;
  const network = async (input: string) => {
    const suffix = new URL(input).pathname.split("/accounts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/")[1];
    let result;
    if (suffix === "containers/applications") result = [{ name: worker,
      id: "22222222-2222-4222-8222-222222222222", version: 1, created_at: "2026-10-11T16:01:00.000Z", configuration: { image: "fixture-dev-image", image_digest: "sha256:" + "c".repeat(64) } }];
    else if (suffix === "containers/applications/22222222-2222-4222-8222-222222222222/rollouts") result = [];
    else if (suffix === `workers/scripts/${worker}/deployments`) result = { deployments: [{
      id: "33333333-3333-4333-8333-333333333333", versions: [{ version_id: activeVersion, percentage: 100 }] }] };
    else if (suffix === `workers/scripts/${worker}/versions/${activeVersion}`) result = { id: activeVersion,
      annotations: { "workers/tag": oldSha }, resources: { bindings: Object.entries({
        PREVIEW_RENDERER_SHA: oldSha, PREVIEW_RENDERER_ENABLED: "true", PREVIEW_SERIALIZER_ID: serializerId,
        CMS_DEPLOYMENT_ENVIRONMENT: "development", FIREBASE_PROJECT_ID: "njpbs-site-dev",
      }).map(([name, text]) => ({ name, type: "plain_text", text })) } };
    else if (suffix === `workers/scripts/${worker}/schedules`) result = { schedules: [{ cron: "* * * * *" }] };
    else throw new Error("Unexpected provider fixture endpoint");
    return Response.json({ success: true, result });
  };
  async function seedReadyRelease() {
    activeVersion = firstVersion;
    // Exercise the actual provider receipt producer and Firestore serialization
    // together. #2957 requires the consumer to agree with that stored release.
    const provider = await collectDevRendererIdentity("fixture-token", oldSha, network, { releaseStartedAt });
    const control = { schemaVersion: 1, phase: "ready", rendererSha: oldSha, serializerId };
    const receipt = { schemaVersion: 1, environment: "development", projectId: "njpbs-site-dev", state: "complete",
      sourceSha: oldSha, releaseStartedAt, provider, verifiedAt: "2026-10-11T17:00:00.000Z" };
    await db.doc(runtimePath).set(control);
    await db.doc(receiptPath).set(receipt);
    return { control, receipt };
  }
  it("accepts the stored/live pin and preserves both real Firestore records", async () => {
    const before = await seedReadyRelease();
    const result = await verifyPinnedDevPreviewRenderer(db, { rendererSha: oldSha, token: "fixture-token" }, network);
    expect(result).toMatchObject({ sourceSha: oldSha, environment: "development", verificationMode: "pinned-live-readback" });
    expect((await db.doc(runtimePath).get()).data()).toEqual(before.control);
    expect((await db.doc(receiptPath).get()).data()).toEqual(before.receipt);
  });
  it.each(["provider-version", "paused", "another-pin"])("refuses %s without pausing or rewriting the stored release", async drift => {
    const before = await seedReadyRelease();
    if (drift === "provider-version") activeVersion = "44444444-4444-4444-8444-444444444444";
    if (drift === "paused") {
      before.control.phase = "paused";
      await db.doc(runtimePath).set(before.control);
    }
    await expect(verifyPinnedDevPreviewRenderer(db, {
      rendererSha: drift === "another-pin" ? newSha : oldSha, token: "fixture-token",
    }, network)).rejects.toThrow();
    expect((await db.doc(runtimePath).get()).data()).toEqual(before.control);
    expect((await db.doc(receiptPath).get()).data()).toEqual(before.receipt);
  });
});
