import { beforeAll, beforeEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { releasePair } from "../helpers/private-public-release-pair.js";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import rollout from "../../functions/lib/public-release-pair-rollout.js";
import { planPublicReleasePairPublisher } from "../../scripts/plan-public-release-pair-publisher.mjs";

let db;
const pair = releasePair();
beforeAll(() => { db = isolatedFirestore("public-release-pair-rollout.test.js"); });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`,
    { method: "DELETE" }, db);
  const pairTemplate = structuredClone(pair);
  delete pairTemplate.publisher.workerVersionId;
  const accountId = "c".repeat(32);
  const plan = { schemaVersion: 2, kind: "private-pair-publisher-upload", pairTemplate, accountId,
    imageReference: `registry.cloudflare.com/${accountId}/publisher/candidate@${pair.publisher.imageDigest}`,
    bundleDigest: "d".repeat(64), configurationDigest: "e".repeat(64) };
  await rollout.reservePublicReleasePairUpload({ firestore: db, plan });
  await rollout.recordPublicReleasePairUploadReadback({ firestore: db, plan, readback: {
    planDigest: protocol.publicReleaseDigest(plan), publisherApplication: pair.publisher.application,
    workerVersionId: pair.publisher.workerVersionId, bundleDigest: plan.bundleDigest,
    configurationDigest: plan.configurationDigest, imageDigest: pair.publisher.imageDigest,
  } });
  await work.registerPublicReleasePair({ firestore: db, pair });
});
const reserve = () => rollout.reservePublicReleasePairRollout({ firestore: db, pair });

it("permits one provider attempt; ambiguous/lost responses can only reconcile by exact readback", async () => {
  const calls = await Promise.all([reserve(), reserve()]);
  expect(calls.filter(result => result.mayStartProviderWrite)).toHaveLength(1);
  await rollout.recordPublicReleasePairRolloutReadback({ firestore: db, pair });
  expect(await reserve()).toEqual({ mayStartProviderWrite: false, state: "uncertain" });
  const readback = { publisherApplication: pair.publisher.application, publisherWorkerVersionId: pair.publisher.workerVersionId,
    imageDigest: pair.publisher.imageDigest, publicService: pair.publicWorker.service, publicWorkerVersionId: pair.publicWorker.versionId,
    publisherDeploymentId: "11111111-1111-4111-8111-111111111111", publicDeploymentId: "22222222-2222-4222-8222-222222222222",
    publisherTrafficPercent: 100, publicTrafficPercent: 100 };
  await expect(rollout.recordPublicReleasePairRolloutReadback({ firestore: db, pair,
    readback: { ...readback, imageDigest: `sha256:${"0".repeat(64)}` } })).rejects.toThrow();
  expect((await reserve()).mayStartProviderWrite).toBe(false);
  await expect(rollout.recordPublicReleasePairRolloutReadback({ firestore: db, pair,
    readback: { ...readback, publisherTrafficPercent: 50 } })).rejects.toThrow();
  await rollout.recordPublicReleasePairRolloutReadback({ firestore: db, pair, readback });
  expect(await reserve()).toEqual({ mayStartProviderWrite: false, state: "verified" });
  expect((await rollout.recordPublicReleasePairRolloutReadback({ firestore: db, pair, readback })).idempotent).toBe(true);
  expect((await db.doc("system/publicDeployment").get()).exists).toBe(false);
});

it("plans distinct private, disabled applications and strips public activation authority", () => {
  const legacyConfig = JSON.parse(readFileSync(new URL("../../publisher/wrangler.json", import.meta.url), "utf8"));
  const before = structuredClone(legacyConfig);
  const production = { ...pair, environment: "production" };
  const old = { ...releasePair("b", "b".repeat(40)), environment: "production" };
  const plan = planPublicReleasePairPublisher({ pair: production, retainedPairs: [old], legacyConfig });
  expect(plan.readyForDeployment).toBe(false);
  expect(plan.applicationName).toBe(production.publisher.application);
  expect(plan.containerName).toBe(production.publisher.application);
  expect(plan.containerKey).toBe(production.pairId);
  expect(plan.journalPath).toBe(`${work.publicReleasePairPath(production.pairId)}/journals/${production.publisher.journalNamespace}`);
  expect(plan.publicRoutes).toEqual([]);
  expect(plan.workersDev).toBe(false);
  expect(plan.previewUrls).toBe(false);
  expect(plan.cronStartup).toBe(false);
  expect(plan.publicationEnabled).toBe(false);
  for (const executable of ["config", "main", "vars", "secrets", "containers", "durable_objects", "migrations", "r2_buckets"]) {
    expect(plan).not.toHaveProperty(executable);
  }
  expect(legacyConfig).toEqual(before);
  expect(() => planPublicReleasePairPublisher({ pair, retainedPairs: [], legacyConfig })).toThrow("target");
  expect(() => planPublicReleasePairPublisher({ pair: production, retainedPairs: [production], legacyConfig })).toThrow("overlap");
  expect(() => planPublicReleasePairPublisher({ pair: { ...production,
    publisher: { ...production.publisher, journalNamespace: "cloudflare-publisher" } }, retainedPairs: [], legacyConfig })).toThrow();
});

it("refuses every legacy live Worker at registration and at the provider-start gate", async () => {
  for (const service of ["njpbs-production", "template-dev-public", "njpbs-cms-publisher", "njpbs-dev-cms-publisher", "njpbs-cms-api", "njpbs-admin", "njpbs-cms-preview"]) {
    for (const field of ["publisher", "publicWorker"]) {
      const unsafe = field === "publisher" ? { ...pair, publisher: { ...pair.publisher, application: service } } :
        { ...pair, pairId: `${service}:${pair.publicWorker.incarnation}`, publicWorker: { ...pair.publicWorker, service } };
      await expect(work.registerPublicReleasePair({ firestore: db, pair: unsafe })).rejects.toThrow();
      await expect(rollout.reservePublicReleasePairRollout({ firestore: db, pair: unsafe })).rejects.toThrow();
    }
  }
  expect((await db.doc("system/publicDeployment").get()).exists).toBe(false);
});
