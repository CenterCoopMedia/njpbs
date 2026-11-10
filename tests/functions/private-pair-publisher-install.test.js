import { beforeAll, beforeEach, expect, it } from "vitest";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { releasePair } from "../helpers/private-public-release-pair.js";
import * as fixture from "../helpers/private-pair-publisher-provider.mjs";
import { privatePairPublisherScenario } from "../helpers/private-pair-publisher-install.mjs";
import { installPrivatePairPublisher } from "../../scripts/lib/private-pair-publisher-install.mjs";
import protocol from "../../functions/lib/public-release-pair.js";
import ownership from "../../functions/lib/public-release-pair-work.js";

let db;
beforeAll(() => { db = isolatedFirestore("private-pair-publisher-install.test.js"); });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`,
    { method: "DELETE" }, db);
});

const scenario = options => privatePairPublisherScenario(db, options);

it("installs one private new publisher and resumes by exact readback without another mutation", async () => {
  const current = await scenario();
  const old = releasePair("b", "b".repeat(40));
  await ownership.registerPublicReleasePair({ firestore: db, pair: old });
  const oldBefore = (await db.doc(ownership.publicReleasePairPath(old.pairId)).get()).data();
  const receipt = await installPrivatePairPublisher(current.input);
  expect(current.writes()).toHaveLength(4);
  expect(receipt).toMatchObject({ kind: "private-pair-publisher-install", runtime: { ready: true },
    publicSelectionChanged: false, publicationSuccess: false });
  expect(await installPrivatePairPublisher(current.input)).toEqual(receipt);
  expect(current.writes()).toHaveLength(4);
  expect((await db.doc(ownership.publicReleasePairPath(old.pairId)).get()).data()).toEqual(oldBefore);
  expect((await db.doc("system/publicDeployment").get()).exists).toBe(false);
  expect((await db.doc("system/publicReleaseSelector").get()).exists).toBe(false);
});

it("settles a lost upload response using its exact unique UUID without another POST", async () => {
  const current = await scenario({ loseVersionResponse: true });
  expect((await installPrivatePairPublisher(current.input)).version.workerVersionId).toBe(fixture.versionId);
  expect(current.writes().filter(row => row.url.pathname.endsWith("/versions"))).toHaveLength(1);
  await installPrivatePairPublisher(current.input);
  expect(current.writes()).toHaveLength(4);
});

it("keeps an absent uncertain Container operation read-only across restart", async () => {
  const current = await scenario({ failContainer: true });
  await expect(installPrivatePairPublisher(current.input)).rejects.toMatchObject({ code: "operation-readback-pending", uncertain: true });
  const before = current.writes().length;
  await expect(installPrivatePairPublisher(current.input)).rejects.toMatchObject({ code: "operation-readback-pending", uncertain: true });
  expect(current.writes()).toHaveLength(before);
  expect(current.counters().preflights).toBe(0);
  expect((await db.doc("system/publicDeployment").get()).exists).toBe(false);
});

it("refuses wrong actual uploaded bytes before immutable registration or deployment", async () => {
  const current = await scenario({ wrongBytes: true });
  await expect(installPrivatePairPublisher(current.input)).rejects.toMatchObject({ code: "version-bytes", uncertain: false });
  await expect(installPrivatePairPublisher(current.input)).rejects.toMatchObject({ code: "version-bytes", uncertain: false });
  expect(current.writes()).toHaveLength(2);
  const response = (await db.doc(`${ownership.publicReleasePairPath(current.input.plan.pairTemplate.pairId)}/rollouts/upload/operations/version/responses/provider`).get()).data();
  expect(response.response.workerVersionId).toBe(fixture.versionId);
  expect((await db.doc(ownership.publicReleasePairPath(current.input.plan.pairTemplate.pairId)).get()).exists).toBe(false);
  expect(current.counters().preflights).toBe(0);
});

it("refuses a pre-cancelled or unauthorized install before credentials, network or durable reservation", async () => {
  const current = await scenario(), cancelled = new AbortController();
  cancelled.abort();
  await expect(installPrivatePairPublisher({ ...current.input, signal: cancelled.signal })).rejects.toMatchObject({ code: "install-cancelled" });
  await expect(installPrivatePairPublisher({ ...current.input, authorized: false })).rejects.toMatchObject({ code: "install-not-authorized" });
  await expect(installPrivatePairPublisher({ ...current.input, preflightCaller: undefined })).rejects.toMatchObject({ code: "private-preflight-unbound" });
  await expect(installPrivatePairPublisher({ ...current.input, readServiceAccount: undefined })).rejects.toMatchObject({ code: "credential-reader-unbound" });
  expect(current.counters()).toEqual({ credentialReads: 0, preflights: 0 });
  expect(current.requests).toHaveLength(0);
  expect((await db.doc("system/publicReleasePairUploads").get()).exists).toBe(false);
});

it("binds the actual prepared metadata to the full requested source identity before I/O", async () => {
  const current = await scenario();
  const changed = structuredClone(current.input.plan);
  changed.pairTemplate.commitSha = "f".repeat(40);
  await expect(installPrivatePairPublisher({ ...current.input, plan: changed })).rejects.toMatchObject({ code: "prepared-plan-mismatch" });
  expect(current.requests).toHaveLength(0);
  expect(current.counters().credentialReads).toBe(0);
  expect(protocol.publicReleaseDigest(changed)).not.toBe(protocol.publicReleaseDigest(current.input.plan));
});


it("leaves a version grant available after a local credential failure before dispatch", async () => {
  const current = await scenario();
  await expect(installPrivatePairPublisher({ ...current.input,
    readServiceAccount: () => { throw new Error("Fixture credential reader unavailable"); } }))
    .rejects.toMatchObject({ code: "credential-unavailable", uncertain: false });
  expect(current.writes()).toHaveLength(1);
  const operation = db.doc(`${ownership.publicReleasePairPath(current.input.plan.pairTemplate.pairId)}/rollouts/upload/operations/version`);
  expect((await operation.get()).exists).toBe(false);
  expect((await installPrivatePairPublisher(current.input)).runtime.ready).toBe(true);
  expect(current.writes()).toHaveLength(4);
});


it("reports lagging identity readback as pending and reconciles the original create", async () => {
  const current = await scenario({ lagIdentityReads: 1 });
  await expect(installPrivatePairPublisher(current.input)).rejects.toMatchObject({ code: "operation-readback-pending", uncertain: true });
  expect(current.writes()).toHaveLength(1);
  expect((await installPrivatePairPublisher(current.input)).runtime.ready).toBe(true);
  expect(current.writes()).toHaveLength(4);
  expect(current.writes().filter(row => row.url.pathname.endsWith("/workers/workers"))).toHaveLength(1);
});


for (const [option, id, code, writeCount] of [
  ["identityResponseId", "7".repeat(32), "worker-identity", 1],
  ["deploymentResponseId", fixture.otherVersion, "deployment-identity", 3],
  ["containerResponseId", fixture.otherVersion, "application-inventory", 4],
]) it(`keeps a known ${option} mismatch refused across restart`, async () => {
  const current = await scenario({ [option]: id });
  await expect(installPrivatePairPublisher(current.input)).rejects.toMatchObject({ code });
  expect(current.writes()).toHaveLength(writeCount);
  await expect(installPrivatePairPublisher(current.input)).rejects.toMatchObject({ code });
  expect(current.writes()).toHaveLength(writeCount);
  expect(current.counters().preflights).toBe(0);
});

for (const option of ["lagDeploymentReads", "lagContainerReads"])
  it(`reconciles ${option} using the original recorded response ID`, async () => {
    const current = await scenario({ [option]: 1 });
    await expect(installPrivatePairPublisher(current.input)).rejects.toMatchObject({ code: "operation-readback-pending", uncertain: true });
    const before = current.writes().length;
    expect((await installPrivatePairPublisher(current.input)).runtime.ready).toBe(true);
    // A lagging deployment has not created its Container yet. The original
    // deployment is never repeated; only that not-yet-started stage can write.
    expect(current.writes()).toHaveLength(option === "lagDeploymentReads" ? before + 1 : before);
    expect(current.writes().filter(row => row.url.pathname.endsWith("/deployments"))).toHaveLength(1);
    const response = (await db.doc(`${ownership.publicReleasePairPath(current.input.plan.pairTemplate.pairId)}/rollouts/upload/operations/deployment/responses/provider`).get()).data();
    expect(response.response.deploymentId).toBe(fixture.deploymentId);
  });
