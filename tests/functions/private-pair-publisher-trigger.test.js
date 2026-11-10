import { beforeAll, beforeEach, expect, it } from "vitest";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { privatePairPublisherScenario } from "../helpers/private-pair-publisher-install.mjs";
import { installPrivatePairPublisher } from "../../scripts/lib/private-pair-publisher-install.mjs";
import { inspectPrivatePairPublisherTarget } from "../../scripts/lib/private-pair-publisher-target.mjs";
import ownership from "../../functions/lib/public-release-pair-work.js";
import { createPrivatePairPublisherProvider } from "../../scripts/lib/private-pair-publisher-provider.mjs";
import { versionId } from "../helpers/private-pair-publisher-provider.mjs";

let db;
beforeAll(() => { db = isolatedFirestore("private-pair-publisher-trigger.test.js"); });
beforeEach(async () => clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db));
const scenario = options => privatePairPublisherScenario(db, { continuationEnabled: true, ...options });
const triggerWrites = current => current.writes().filter(r => r.url.pathname.endsWith("/schedules"));
const operation = current => db.doc(`${ownership.publicReleasePairPath(current.input.plan.pairTemplate.pairId)}/rollouts/upload/operations/trigger`);

it("refuses unprepared trigger dispatch before credentials or HTTP", async () => {
  const current = await scenario(), api = createPrivatePairPublisherProvider(current.input);
  await expect(api.installOriginalTrigger({ versionId: undefined })).rejects.toThrow();
  await expect(api.installOriginalTrigger({ versionId })).rejects.toMatchObject({ code: "trigger-preparation-required" });
  expect(current.counters().credentialReads).toBe(0); expect(current.requests).toHaveLength(0);
});

it("installs the sealed one-minute missed-wake trigger once and verifies the original attempt on restart", async () => {
  const current = await scenario(), result = await installPrivatePairPublisher(current.input);
  expect(result.trigger).toMatchObject({ workerVersionId: result.pair.publisher.workerVersionId, schedules: [{ cron: "* * * * *" }] });
  expect(current.writes()).toHaveLength(5); expect(triggerWrites(current)).toHaveLength(1);
  expect((await operation(current).get()).data()).toMatchObject({ operation: "trigger", state: "verified" });
  expect((await inspectPrivatePairPublisherTarget(current.input)).evidence.trigger).toEqual(result.trigger);
  expect(await installPrivatePairPublisher(current.input)).toEqual(result);
  expect(triggerWrites(current)).toHaveLength(1);
  expect((await db.doc("system/publicDeployment").get()).exists).toBe(false);
  expect((await db.doc("system/publicReleaseSelector").get()).exists).toBe(false);
});

it("settles a lost PUT reply by exact GET without another mutation", async () => {
  const current = await scenario({ loseTriggerResponse: true });
  expect((await installPrivatePairPublisher(current.input)).trigger).toBeTruthy();
  expect((await operation(current).get()).data().state).toBe("verified");
  expect((await operation(current).collection("responses").doc("provider").get()).exists).toBe(false);
  await installPrivatePairPublisher(current.input);
  expect(triggerWrites(current)).toHaveLength(1);
});

it("retains an absent uncertain trigger without reissuing PUT or entering runtime preflight", async () => {
  const current = await scenario({ failTrigger: true });
  for (let i = 0; i < 2; i++) await expect(installPrivatePairPublisher(current.input)).rejects.toMatchObject({ code: "operation-readback-pending", uncertain: true });
  expect(triggerWrites(current)).toHaveLength(1); expect(current.counters().preflights).toBe(0);
  expect((await operation(current).get()).data().state).toBe("uncertain");
});

it("refuses changed, absent or unproven trigger state in the actual installed-target guard", async () => {
  const options = {}, current = await scenario(options);
  await installPrivatePairPublisher(current.input);
  current.state.trigger = false;
  await expect(inspectPrivatePairPublisherTarget(current.input)).rejects.toThrow();
  current.state.trigger = true;
  await operation(current).delete();
  await expect(inspectPrivatePairPublisherTarget(current.input)).rejects.toThrow();
  expect(triggerWrites(current)).toHaveLength(1);
});

it("refuses an unexpected schedule without overwriting it or invoking preflight", async () => {
  const current = await scenario({ triggerCron: "*/5 * * * *" }); current.state.trigger = true;
  await expect(installPrivatePairPublisher(current.input)).rejects.toMatchObject({ code: "trigger-readback" });
  await expect(installPrivatePairPublisher(current.input)).rejects.toMatchObject({ code: "trigger-readback" });
  expect(triggerWrites(current)).toHaveLength(0); expect(current.counters().preflights).toBe(0);
});

it("preserves all four legacy install effects when continuation mode is absent", async () => {
  const current = await scenario({ continuationEnabled: false }), result = await installPrivatePairPublisher(current.input);
  expect(current.writes()).toHaveLength(4); expect(result).not.toHaveProperty("trigger");
  expect(current.requests.some(r => r.url.pathname.endsWith("/schedules"))).toBe(false);
  expect((await operation(current).get()).exists).toBe(false);
  expect((await inspectPrivatePairPublisherTarget(current.input)).evidence).not.toHaveProperty("trigger");
});

it("leaves the original trigger grant available after a transient preparation GET failure", async () => {
  const current = await scenario({ failTriggerPreparationReads: 1 });
  await expect(installPrivatePairPublisher(current.input)).rejects.toMatchObject({ code: "request-failed", uncertain: false });
  expect((await operation(current).get()).exists).toBe(false);
  expect(triggerWrites(current)).toHaveLength(0); expect(current.writes()).toHaveLength(4);
  expect(current.counters().preflights).toBe(0);
  expect((await installPrivatePairPublisher(current.input)).trigger).toBeTruthy();
  expect(triggerWrites(current)).toHaveLength(1); expect(current.writes()).toHaveLength(5);
});
