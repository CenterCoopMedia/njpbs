import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";

const firestore = isolatedFirestore("media-public-credit-repair-identity.test.js");
const originalRepairId = process.env.CMS_MEDIA_PUBLIC_CREDIT_REPAIR_ID;
const contextPath = "system/publicDeployment/contexts/public";
const image = {
  url: "https://media.njpbs.org/cms-media/general/example/original.webp",
  altText: "Synthetic image", mimeType: "image/webp", width: 20, height: 10,
  credit: "Example credit", source: "site_seed", lifecycle: "active", version: 1,
  name: "Example image", originalName: "example.webp", category: "general",
  kind: "image", sizeBytes: 42,
};

async function operation(repairId) {
  process.env.CMS_MEDIA_PUBLIC_CREDIT_REPAIR_ID = repairId;
  vi.resetModules();
  const module = await import("../../scripts/backfill-media-public-credit.mjs");
  return options => module.recordCurrentMediaPublicCredit({ firestore, expectedCount: 1,
    auditEntry: async fields => ({ ...fields, timestamp: "synthetic-time" }), ...options });
}

beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`,
    { method: "DELETE" }, firestore);
  await Promise.all([
    firestore.doc(contextPath).set({ schemaVersion: 1, revision: 7 }),
    firestore.doc("system/mediaDiscovery").set({ revision: 5 }),
    firestore.doc("media_assets/example").set(image),
    firestore.doc("media_assets_public/example").set({ url: image.url, altText: image.altText,
      mimeType: image.mimeType, width: image.width, height: image.height, credit: image.credit }),
  ]);
});

afterAll(() => {
  if (originalRepairId === undefined) delete process.env.CMS_MEDIA_PUBLIC_CREDIT_REPAIR_ID;
  else process.env.CMS_MEDIA_PUBLIC_CREDIT_REPAIR_ID = originalRepairId;
});

it.each([false, true])("refuses a different valid startup identity atomically after an existing receipt (apply=%s)", async apply => {
  const first = await operation("a1b2c3d4");
  await expect(first({ apply: true })).resolves.toMatchObject({ recorded: true, publicContextRevision: 8 });
  const wrong = await operation("deadbeef");
  await expect(wrong({ apply })).rejects.toThrow("identity conflicts");
  expect((await firestore.doc(contextPath).get()).data().revision).toBe(8);
  expect((await firestore.doc("system/mediaDiscovery").get()).data().revision).toBe(6);
  expect((await firestore.collection("admin_logs").get()).size).toBe(1);
  const retry = await operation("a1b2c3d4");
  await expect(retry({ apply: true })).resolves.toMatchObject({ recorded: false, alreadyRecorded: true,
    publicContextRevision: 8 });
}, 20_000);

it("serializes competing startup identities into a single context update", async () => {
  const first = await operation("a1b2c3d4"), second = await operation("deadbeef");
  const results = await Promise.allSettled([first({ apply: true }), second({ apply: true })]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const refused = results.find(result => result.status === "rejected");
  expect(refused.reason.message).toContain("identity conflicts");
  expect((await firestore.doc(contextPath).get()).data().revision).toBe(8);
  expect((await firestore.doc("system/mediaDiscovery").get()).data().revision).toBe(6);
  expect((await firestore.collection("admin_logs").get()).size).toBe(1);
}, 20_000);
