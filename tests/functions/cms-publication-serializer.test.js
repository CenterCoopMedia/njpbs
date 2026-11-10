import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import adminPkg from "../helpers/firebase-admin.js";
import serializerModule from
  "../../functions/lib/cms-publication-serializer.js";

const admin = adminPkg;
const {
  claimCmsPublishQueue,
} = serializerModule;

const PROJECT = process.env.GCLOUD_PROJECT ?? "demo-njpbs";
const QUEUE_ID = "11111111111111111111";
const BUILD_BATCH_ID = "cms-11111111111111111111";
const COMMIT_SHA = "a".repeat(40);
const SERIALIZER_ID = "node-compute-primary";
const CLAIM_TOKEN = "22222222-2222-4222-8222-222222222222";
const OTHER_TOKEN = "33333333-3333-4333-8333-333333333333";

let db;

function queueRef(queueId = QUEUE_ID) {
  return db.collection("cmsPublishQueue").doc(queueId);
}

function runtimeRef() {
  return db.collection("system").doc("cmsPublicationRuntime");
}

async function seedRuntime(overrides = {}) {
  await runtimeRef().set({
    schemaVersion: 1,
    phase: "ready",
    commitSha: COMMIT_SHA,
    serializerId: SERIALIZER_ID,
    ...overrides,
  });
}

async function seedQueue(overrides = {}) {
  await queueRef().set({
    status: "pending",
    transport: "serializer",
    triggeredAt: admin.firestore.Timestamp.fromMillis(1_787_000_000_000),
    completedAt: null,
    error: null,
    changes: [],
    ...overrides,
  });
}

function claim(overrides = {}) {
  return claimCmsPublishQueue({
    firestore: db,
    queueId: QUEUE_ID,
    buildBatchId: BUILD_BATCH_ID,
    commitSha: COMMIT_SHA,
    serializerId: SERIALIZER_ID,
    claimToken: CLAIM_TOKEN,
    ...overrides,
  });
}

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("cms-publication-serializer.test.js");
});

beforeEach(async () => {
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
});

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app.delete()));
});

describe("CMS publication serializer claim", () => {
  it("claims one pending queue without storing the claim token", async () => {
    await seedQueue();

    const result = await claim();
    const queue = (await queueRef().get()).data();

    expect(result).toMatchObject({
      outcome: "claimed",
      idempotent: false,
      receipt: {
        schemaVersion: 1,
        serializerId: SERIALIZER_ID,
        buildBatchId: BUILD_BATCH_ID,
        commitSha: COMMIT_SHA,
        tokenDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(result.receipt.claimedAt).toBeDefined();
    expect(queue).toMatchObject({
      status: "publishing",
      serializerClaim: result.receipt,
    });
    expect(JSON.stringify(queue)).not.toContain(CLAIM_TOKEN);
  });

  it("returns the same claim for an exact token retry without writing", async () => {
    await seedQueue();
    const first = await claim();
    const retry = await claim();

    expect(retry).toEqual({ ...first, idempotent: true });
    expect((await queueRef().get()).data().serializerClaim.claimedAt.toMillis())
      .toBe(first.receipt.claimedAt.toMillis());
  });

  it.each(["paused", "starting"])(
    "lets the selected owner claim admitted pending work while %s",
    async (phase) => {
      await Promise.all([seedQueue(), seedRuntime({ phase })]);

      await expect(claim()).resolves.toMatchObject({
        outcome: "claimed",
        idempotent: false,
        receipt: { commitSha: COMMIT_SHA, serializerId: SERIALIZER_ID },
      });
      expect((await queueRef().get()).data()).toMatchObject({
        status: "publishing",
      });
    },
  );

  it.each([
    ["source", { commitSha: "b".repeat(40) }],
    ["owner", { serializerId: "cloud-publication-other" }],
  ])("refuses a %s not selected by runtime control", async (_label, change) => {
    await Promise.all([seedQueue(), seedRuntime()]);

    await expect(claim(change)).rejects.toThrow(
      "Another CMS publication serializer owns this runtime",
    );
    expect((await queueRef().get()).data()).toMatchObject({ status: "pending" });
  });

  it("fails closed for a malformed present runtime control", async () => {
    await Promise.all([
      seedQueue(),
      runtimeRef().set({ schemaVersion: 1, phase: "ready" }),
    ]);

    await expect(claim()).rejects.toThrow("runtime control is invalid");
    expect((await queueRef().get()).data()).toMatchObject({ status: "pending" });
  });

  it.each([
    ["another token", { claimToken: OTHER_TOKEN }],
    ["another owner", { serializerId: "node-offsite-fallback" }],
    ["another batch", { buildBatchId: "cms-other-batch" }],
    ["another commit", { commitSha: "b".repeat(40) }],
  ])("keeps an existing claim busy for %s", async (_label, overrides) => {
    await seedQueue();
    const first = await claim();

    await expect(claim(overrides)).resolves.toEqual({
      outcome: "busy",
      idempotent: false,
    });
    expect((await queueRef().get()).data().serializerClaim).toEqual(
      first.receipt,
    );
  });

  it.each(["success", "failed", "cancelled"])(
    "does not claim a terminal %s queue",
    async (status) => {
      await seedQueue({ status });

      await expect(claim()).resolves.toEqual({
        outcome: "terminal",
        idempotent: true,
        status,
      });
      expect((await queueRef().get()).data()).not.toHaveProperty(
        "serializerClaim",
      );
    },
  );

  it("refuses a publishing queue that has no serializer claim", async () => {
    await seedQueue({ status: "publishing" });

    await expect(claim()).resolves.toEqual({
      outcome: "busy",
      idempotent: false,
    });
    expect((await queueRef().get()).data()).not.toHaveProperty(
      "serializerClaim",
    );
  });

  it.each(["github", "post-no-build-v1"])("refuses a queue owned by %s", async (transport) => {
    await seedQueue({ transport });

    await expect(claim()).rejects.toThrow(
      /not owned by the CMS publication serializer/,
    );
    expect((await queueRef().get()).data()).toMatchObject({
      status: "pending",
      transport,
    });
  });

  it("refuses a commit-bound queue from another source checkout", async () => {
    await seedQueue({ commitSha: "b".repeat(40) });

    await expect(claim()).rejects.toThrow("source commit conflicts");
    expect((await queueRef().get()).data()).toMatchObject({
      status: "pending",
      commitSha: "b".repeat(40),
    });
  });
});

it("does not permit the cloud runtime to consume a legacy serializer queue", async () => {
  await seedQueue();
  await expect(claim({ runtime: { owner: "cloudflare", release: COMMIT_SHA } }))
    .rejects.toThrow("Cloud cannot consume legacy serializer work");
  expect((await queueRef().get()).data().status).toBe("pending");
  await expect(claim()).resolves.toMatchObject({ outcome: "claimed" });
});
