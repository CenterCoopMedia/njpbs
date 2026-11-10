import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import adminPkg from "../helpers/firebase-admin.js";
import {
  abandonReceipt,
  completeReceipt,
  RECEIPT_COLLECTION,
  startReceipt,
} from "../../scripts/lib/cms-component-receipt.mjs";
import { baselineMutation } from "../../scripts/lib/cms-release-plan.mjs";

const admin = adminPkg;
const PROJECT = "demo-njpbs";
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const SOURCE = "a".repeat(40);
const TRUSTED = "b".repeat(40);
const FINGERPRINT = "c".repeat(64);

let db;

function input(overrides = {}) {
  return {
    component: "functions",
    sourceSha: SOURCE,
    trustedWorkflowSha: TRUSTED,
    runId: "35606622319",
    runAttempt: 1,
    inputFingerprint: FINGERPRINT,
    ...overrides,
  };
}

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("cms-component-receipt.test.js");
});

beforeEach(async () => {
  await clearEmulatorFirestore(`http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, {
    method: "DELETE",
  }, db);
});

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app.delete()));
});

describe("cms component receipt store", () => {
  it("marks a mutation in progress without replacing the last complete receipt", async () => {
    await startReceipt(db, input());
    await completeReceipt(db, {
      component: "functions",
      sourceSha: SOURCE,
      runId: "35606622319",
      runAttempt: 1,
      providerIdentities: { region: "us-central1", functionNames: ["health"] },
    });
    const next = await startReceipt(db, input({
      sourceSha: "d".repeat(40),
      runId: "35606622320",
      inputFingerprint: "e".repeat(64),
    }));
    expect(next.receipt.state).toBe("in_progress");
    expect(next.receipt.lastComplete.sourceSha).toBe(SOURCE);
    expect(next.receipt.mutation.sourceSha).toBe("d".repeat(40));
  });

  it("is idempotent for the same in-progress attempt", async () => {
    const first = await startReceipt(db, input());
    const second = await startReceipt(db, input());
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect((await db.collection(RECEIPT_COLLECTION).get()).size).toBe(1);
  });

  it("refuses to complete a receipt that is not this mutation", async () => {
    await startReceipt(db, input());
    await expect(completeReceipt(db, {
      component: "functions",
      sourceSha: SOURCE,
      runId: "1",
      runAttempt: 1,
      providerIdentities: { region: "us-central1" },
    })).rejects.toThrow(/does not match/i);
  });

  describe("abandon", () => {
    async function withPriorCompletion() {
      await startReceipt(db, input());
      await completeReceipt(db, {
        component: "functions",
        sourceSha: SOURCE,
        runId: "35606622319",
        runAttempt: 1,
        providerIdentities: { region: "us-central1", functionNames: ["health"] },
      });
      // A later run fails before its deploy step ever mutates Functions.
      return startReceipt(db, input({
        sourceSha: "d".repeat(40),
        runId: "35606622320",
        runAttempt: 1,
        inputFingerprint: "e".repeat(64),
      }));
    }

    it("restores the last complete mutation for the matching run and attempt, unblocking planning", async () => {
      await withPriorCompletion();
      const result = await abandonReceipt(db, {
        component: "functions",
        runId: "35606622320",
        runAttempt: 1,
      });
      expect(result.receipt.state).toBe("complete");
      expect(result.receipt.mutation.sourceSha).toBe(SOURCE);
      expect(result.receipt.abandoned).toMatchObject({ runId: "35606622320", runAttempt: 1 });

      const stored = await db.collection(RECEIPT_COLLECTION).doc("functions").get();
      expect(baselineMutation(stored.data(), { runId: "35606622320", runAttempt: 1 }).mutation.sourceSha).toBe(SOURCE);
    });

    it("refuses for another run id", async () => {
      await withPriorCompletion();
      await expect(abandonReceipt(db, {
        component: "functions",
        runId: "99999999999",
        runAttempt: 1,
      })).rejects.toThrow(/does not match/i);
      const stored = await db.collection(RECEIPT_COLLECTION).doc("functions").get();
      expect(stored.data().state).toBe("in_progress");
    });

    it("refuses for another run attempt", async () => {
      await withPriorCompletion();
      await expect(abandonReceipt(db, {
        component: "functions",
        runId: "35606622320",
        runAttempt: 2,
      })).rejects.toThrow(/does not match/i);
      const stored = await db.collection(RECEIPT_COLLECTION).doc("functions").get();
      expect(stored.data().state).toBe("in_progress");
    });

    it("refuses a complete receipt", async () => {
      await startReceipt(db, input());
      await completeReceipt(db, {
        component: "functions",
        sourceSha: SOURCE,
        runId: "35606622319",
        runAttempt: 1,
        providerIdentities: { region: "us-central1" },
      });
      await expect(abandonReceipt(db, {
        component: "functions",
        runId: "35606622319",
        runAttempt: 1,
      })).rejects.toThrow(/does not match/i);
      const stored = await db.collection(RECEIPT_COLLECTION).doc("functions").get();
      expect(stored.data().state).toBe("complete");
    });

    it("refuses when there is no prior completed mutation to restore", async () => {
      await startReceipt(db, input());
      await expect(abandonReceipt(db, {
        component: "functions",
        runId: "35606622319",
        runAttempt: 1,
      })).rejects.toThrow(/no prior completed mutation/i);
      const stored = await db.collection(RECEIPT_COLLECTION).doc("functions").get();
      expect(stored.data().state).toBe("in_progress");
    });

    it("makes a second abandon a no-op refusal", async () => {
      await withPriorCompletion();
      await abandonReceipt(db, {
        component: "functions",
        runId: "35606622320",
        runAttempt: 1,
      });
      await expect(abandonReceipt(db, {
        component: "functions",
        runId: "35606622320",
        runAttempt: 1,
      })).rejects.toThrow(/does not match/i);
      const stored = await db.collection(RECEIPT_COLLECTION).doc("functions").get();
      expect(stored.data().state).toBe("complete");
      expect(stored.data().abandoned.runId).toBe("35606622320");
    });
  });
});
