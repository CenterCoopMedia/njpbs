import { beforeAll, beforeEach, expect, it } from "vitest";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { releaseSelector } from "../helpers/public-release-pair.js";
import coordinator from "../../functions/lib/public-deployment-coordinator.js";
import { confirmPublicationRuntimeReady } from "../../site/scripts/cms-publication-cloud-control";

let db;
beforeAll(() => { db = isolatedFirestore("public-release-legacy-writers.test.js"); });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`,
    { method: "DELETE" }, db);
});

it("legacy reservation/lease writers cannot mutate a schema-two selector", async () => {
  const selector = releaseSelector();
  await db.doc("system/publicDeployment").set(selector);
  const input = { firestore: db, buildBatchId: "new-build", commitSha: "a".repeat(40) };
  await expect(coordinator.reservePublicBuildBatch(input)).rejects.toThrow("invalid");
  expect((await db.collection("system/publicDeployment/buildBatches").get()).empty).toBe(true);
  await db.doc("system/publicDeployment/buildBatches/new-build").set({ schemaVersion: 1 });
  await expect(coordinator.acquirePublicDeploymentLease(input)).rejects.toThrow("invalid");
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(selector);
  expect((await db.doc("system/publicDeployment/buildBatches/new-build").get()).data()).toEqual({ schemaVersion: 1 });
});

it("legacy startup cannot project a schema-two control back into a ready schema-one pin", async () => {
  const control = { schemaVersion: 2, phase: "starting", commitSha: "a".repeat(40), serializerId: "cloudflare-publisher" };
  await db.doc("system/cmsPublicationRuntime").set(control);
  await expect(confirmPublicationRuntimeReady(db, control.commitSha, control.serializerId)).rejects.toThrow("invalid");
  expect((await db.doc("system/cmsPublicationRuntime").get()).data()).toEqual(control);
});
