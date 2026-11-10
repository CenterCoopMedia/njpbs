import { beforeAll, afterAll, expect, it } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { installedConsumerFixture } from "../helpers/public-release-installed-consumers";
import { prepareInstalledPublicReleaseConsumers, assertInstalledPublicReleaseConsumersInTransaction } from "../../site/scripts/public-release-installed-consumer-owner";

let app: ReturnType<typeof initializeApp>, db: Firestore;
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || process.env.GCLOUD_PROJECT !== "demo-njpbs")
    throw new Error("Use only the loopback demo emulator");
  app = initializeApp({ projectId: "njpbs-site-dev" }, "installed-consumers-sdk"); db = getFirestore(app);
});
afterAll(async () => { if (app) await deleteApp(app); });

it("uses the actual SDK transaction to refuse receipt/root changes before any control write", async () => {
  const f = installedConsumerFixture(), contractDigest = f.contractDigest;
  const options = { ...f.options, firestore: db };
  async function seed() {
    const batch = db.batch();
    for (const [path, value] of f.data) batch.set(db.doc(path), value);
    batch.delete(db.doc("system/publicReleaseInstalledConsumerProofs/attempts/sdk")); await batch.commit();
  }
  const target = db.doc("system/publicReleaseInstalledConsumerProofs/attempts/sdk");
  async function apply(proof: Awaited<ReturnType<typeof prepareInstalledPublicReleaseConsumers>>) {
    return db.runTransaction(async transaction => {
      const before = (await transaction.get(db.doc("system/publicDeployment"))).data();
      await assertInstalledPublicReleaseConsumersInTransaction({ firestore: db, transaction, proof,
        environment: "development", contractDigest, before });
      transaction.create(target, { sourceDigest: proof.sourceDigest });
    });
  }
  await seed();
  const first = await prepareInstalledPublicReleaseConsumers(options);
  await apply(first);
  expect((await target.get()).data()).toEqual({ sourceDigest: first.sourceDigest });
  for (const path of ["system/publicDeployment", "cmsDeploymentReceipts/functions", "cmsReaderCompatibilityReceipts/functions"]) {
    await seed(); const proof = await prepareInstalledPublicReleaseConsumers(options);
    await db.doc(path).update(path === "system/publicDeployment" ? { activeDeploymentId: "changed" } : { state: "in_progress" });
    await expect(apply(proof)).rejects.toThrow();
    expect((await target.get()).exists).toBe(false);
  }
});
