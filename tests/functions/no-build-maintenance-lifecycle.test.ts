import { beforeAll, beforeEach, expect, it } from "vitest";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { startNoBuildPostMaintenanceService } from "../../site/scripts/no-build-post-maintenance-service";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
let firestore: ReturnType<typeof isolatedFirestore>;
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") ||
      !/^demo-njpbs(?:-[a-z0-9-]+)?$/.test(process.env.GCLOUD_PROJECT ?? "")) throw new Error("Use a local demo Firestore emulator");
  // A named Admin app still shares data; give these listeners their own project.
  firestore = isolatedFirestore("no-build-maintenance-lifecycle.test.ts");
});
beforeEach(async () => {
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${firestore.projectId}/databases/(default)/documents`,
    { method: "DELETE" }, firestore,
  );
});

it("serializes repeated Firestore wakes and drains the running pass on stop", async () => {
  const entered = deferred();
  const release = deferred();
  const observed = deferred();
  const finish = deferred();
  let running = 0;
  let maximum = 0;
  let passes = 0;
  const service = startNoBuildPostMaintenanceService({ firestore, maintain: async () => {
    maximum = Math.max(maximum, ++running);
    passes++;
    if (passes === 1) { entered.resolve(); await release.promise; }
    const current = (await firestore.doc("system/publicDeployment/contexts/public").get()).data();
    if (passes > 1 && current?.lifecycleRevision === 3) { observed.resolve(); await finish.promise; }
    await firestore.doc("runtimeLifecycleTests/progress").set({ revision: current?.lifecycleRevision ?? 0 });
    running--;
  } });
  try {
    await entered.promise;
    for (const lifecycleRevision of [1, 2, 3]) {
      await firestore.doc("system/publicDeployment/contexts/public").set({ lifecycleRevision });
    }
    release.resolve();
    await observed.promise;
    let closed = false;
    void service.closed.then(() => { closed = true; });
    service.stop();
    await Promise.resolve();
    expect(closed).toBe(false);
    finish.resolve();
    await service.closed;
    expect(maximum).toBe(1);
    expect((await firestore.doc("runtimeLifecycleTests/progress").get()).data()).toEqual({ revision: 3 });
  } finally {
    service.stop(); release.resolve(); finish.resolve();
    await service.closed;
  }
});

it("reports maintenance failure and closes its Firestore listeners", async () => {
  const service = startNoBuildPostMaintenanceService({ firestore, maintain: async () => {
    await firestore.doc("runtimeLifecycleTests/failure").set({ attempted: true });
    throw new Error("fixture maintenance failure");
  } });
  await expect(service.closed).rejects.toThrow("fixture maintenance failure");
  service.stop();
  expect((await firestore.doc("runtimeLifecycleTests/failure").get()).data()).toEqual({ attempted: true });
});

it("wakes when another Post owner or the shared renderer capability changes", async () => {
  const started = deferred();
  const ownerObserved = deferred();
  const capabilityObserved = deferred();
  const owner = firestore.doc("system/publicDeployment/noBuildPostOwners/lifecycle-post");
  const capability = firestore.doc("system/publicDeployment/noBuildPosts/capability");
  const service = startNoBuildPostMaintenanceService({ firestore, maintain: async () => {
    const [post, renderer] = await firestore.getAll(owner, capability);
    if (post.data()?.wakeRevision === 1) ownerObserved.resolve();
    if (renderer.data()?.rendererSha === "b".repeat(40)) capabilityObserved.resolve();
    started.resolve();
  } });
  try {
    await started.promise;
    await owner.set({ wakeRevision: 1 });
    await ownerObserved.promise;
    await capability.set({ schemaVersion: 2, rendererSha: "b".repeat(40), servingEnabled: true, generation: 2 });
    await capabilityObserved.promise;
  } finally {
    service.stop();
    await service.closed;
  }
});
