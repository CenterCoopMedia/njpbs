import { beforeAll, beforeEach, expect, it } from "vitest";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { privatePairPublisherScenario } from "../helpers/private-pair-publisher-install.mjs";
import * as fixture from "../helpers/private-pair-publisher-provider.mjs";
import { installPrivatePairPublisher } from "../../scripts/lib/private-pair-publisher-install.mjs";
import { inspectPrivatePairPublisherTarget } from "../../scripts/lib/private-pair-publisher-target.mjs";
import ownership from "../../functions/lib/public-release-pair-work.js";
import rollout from "../../functions/lib/public-release-pair-rollout.js";

let db;
beforeAll(() => { db = isolatedFirestore("private-pair-publisher-target.test.js"); });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`,
    { method: "DELETE" }, db);
});
const pairPath = ownership.publicReleasePairPath(fixture.identity.pairId);
const uploadPath = rollout.publicReleasePairUploadPath(fixture.identity.pairId);

it("seals fresh provider bytes and installed registry state using reads only", async () => {
  const current = await privatePairPublisherScenario(db);
  const installed = await installPrivatePairPublisher(current.input);
  const before = (await db.doc(uploadPath).get()).data();
  const start = current.requests.length;
  const proof = await inspectPrivatePairPublisherTarget(current.input);
  expect(proof).toMatchObject({ pair: installed.pair, identity: fixture.identity,
    installedTargetDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    evidence: { version: { workerVersionId: fixture.versionId },
      application: { imageReference: fixture.imageReference }, privateIngress: { private: true } } });
  expect(await inspectPrivatePairPublisherTarget(current.input)).toEqual(proof);
  expect(current.requests.slice(start).every(row => row.method === "GET")).toBe(true);
  expect(current.writes()).toHaveLength(4);
  expect((await db.doc(uploadPath).get()).data()).toEqual(before);
  expect((await db.doc("system/publicDeployment").get()).exists).toBe(false);
  expect(proof).not.toHaveProperty("ready");
});

it("rejects changed actual module bytes after a completed install", async () => {
  const options = {};
  const current = await privatePairPublisherScenario(db, options);
  await installPrivatePairPublisher(current.input);
  options.wrongBytes = true;
  await expect(inspectPrivatePairPublisherTarget(current.input)).rejects.toMatchObject({ code: "version-bytes" });
  expect(current.writes()).toHaveLength(4);
});

it.each(["identity", "version", "deployment", "container"])("refuses a changed immutable %s readback seal", async operation => {
  const current = await privatePairPublisherScenario(db);
  await installPrivatePairPublisher(current.input);
  await db.doc(`${uploadPath}/operations/${operation}`).update({ readbackDigest: "f".repeat(64) });
  await expect(inspectPrivatePairPublisherTarget(current.input)).rejects.toMatchObject({ code: "installed-target-mismatch" });
  expect(current.writes()).toHaveLength(4);
});

it("refuses an incomplete install before credential or provider reads", async () => {
  const current = await privatePairPublisherScenario(db);
  await installPrivatePairPublisher(current.input);
  await db.doc(`${uploadPath}/operations/container`).update({ state: "uncertain", readbackDigest: null });
  const requests = current.requests.length;
  const credentials = current.counters().credentialReads;
  await expect(inspectPrivatePairPublisherTarget(current.input)).rejects.toMatchObject({ code: "installed-target-mismatch" });
  expect(current.requests).toHaveLength(requests);
  expect(current.counters().credentialReads).toBe(credentials);
});

it("refuses changed registration and retired runtime controls", async () => {
  const current = await privatePairPublisherScenario(db);
  const installed = await installPrivatePairPublisher(current.input);
  await db.doc(pairPath).update({ publisher: { ...installed.pair.publisher, workerVersionId: fixture.otherVersion } });
  await expect(inspectPrivatePairPublisherTarget(current.input)).rejects.toMatchObject({ code: "installed-target-mismatch" });
  await db.doc(pairPath).set(installed.pair);
  await db.doc(`${pairPath}/controls/runtime`).update({ status: "retired" });
  await expect(inspectPrivatePairPublisherTarget(current.input)).rejects.toMatchObject({ code: "installed-target-mismatch" });
  expect(current.writes()).toHaveLength(4);
});

it("rejects a runtime control change during the provider readback", async () => {
  const current = await privatePairPublisherScenario(db);
  await installPrivatePairPublisher(current.input);
  const fetchImpl = async (url, init) => {
    const reply = await current.input.fetchImpl(url, init);
    if (new URL(url).pathname.endsWith(`/versions/${fixture.versionId}`)) {
      await db.doc(`${pairPath}/controls/runtime`).update({ status: "retired" });
    }
    return reply;
  };
  await expect(inspectPrivatePairPublisherTarget({ ...current.input, fetchImpl })).rejects.toMatchObject({ code: "installed-target-mismatch" });
  expect(current.writes()).toHaveLength(4);
});

it("rejects a different prepared intent before credentials or provider reads", async () => {
  const current = await privatePairPublisherScenario(db);
  const start = current.requests.length;
  await expect(inspectPrivatePairPublisherTarget({ ...current.input,
    plan: { ...current.input.plan, configurationDigest: "f".repeat(64) } })).rejects.toMatchObject({ code: "installed-target-mismatch" });
  expect(current.requests).toHaveLength(start);
  expect(current.counters().credentialReads).toBe(0);
});
