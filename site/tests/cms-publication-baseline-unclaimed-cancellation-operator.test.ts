// @vitest-environment node

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import {
  parseCancellationArguments,
  runCmsPublicationBaselineUnclaimedCancellation,
  runCmsPublicationBaselineUnclaimedCancellationCommand,
} from "../scripts/cancel-unclaimed-cms-publication-baseline";
import type {
  CmsPublicationJournalJob,
} from "../scripts/cms-publication-token-journal";

const QUEUE_ID = "Apex0902Cutover00004";
const BUILD_BATCH_ID = `cms-${QUEUE_ID}`;
const OPERATOR_COMMIT_SHA = "e".repeat(40);
const QUEUE_COMMIT_SHA = "d".repeat(40);
const SERIALIZER_ID = "node-compute-primary";
const CLAIM_TOKEN = "33333333-3333-4333-8333-333333333333";
const requireModule = createRequire(import.meta.url);
const { cmsPublicationSerializerTokenDigest } = requireModule(
  "../../functions/lib/cms-publication-serializer.js",
) as { cmsPublicationSerializerTokenDigest(token: string): string };
const CLAIM_TOKEN_DIGEST = cmsPublicationSerializerTokenDigest(CLAIM_TOKEN);

function intent() {
  return {
    operatorCommitSha: OPERATOR_COMMIT_SHA,
    queueId: QUEUE_ID,
    buildBatchId: BUILD_BATCH_ID,
    queueCommitSha: QUEUE_COMMIT_SHA,
    serializerId: SERIALIZER_ID,
  };
}

function journal(job: null | CmsPublicationJournalJob = {
  queueId: QUEUE_ID,
  buildBatchId: BUILD_BATCH_ID,
  commitSha: QUEUE_COMMIT_SHA,
  claimToken: CLAIM_TOKEN,
  createdAt: "2026-09-02T23:28:59.000Z",
}) {
  let retained = job;
  return {
    journalPath: "/var/lib/njpbs-cms-publisher/claim-journal.json",
    read: vi.fn(async () => retained),
    reserve: vi.fn(),
    clear: vi.fn(async (request) => {
      if (
        retained?.queueId !== request.queueId ||
        retained?.claimToken !== request.claimToken
      ) {
        throw new Error("conflicting clear");
      }
      retained = null;
      return { idempotent: false };
    }),
  };
}

function cancellationResult(idempotent: boolean) {
  return {
    outcome: "cancelled" as const,
    idempotent,
    receipt: {
      queueId: QUEUE_ID,
      buildBatchId: BUILD_BATCH_ID,
      queueCommitSha: QUEUE_COMMIT_SHA,
      operatorCommitSha: OPERATOR_COMMIT_SHA,
      serializerId: SERIALIZER_ID,
    },
  };
}

describe("unclaimed CMS publication baseline cancellation operator", () => {
  it("parses the clean operator source separately from the old queue source", () => {
    expect(parseCancellationArguments([
      "--apply",
      OPERATOR_COMMIT_SHA,
      QUEUE_ID,
      QUEUE_COMMIT_SHA,
      SERIALIZER_ID,
    ])).toEqual(intent());
    expect(() => parseCancellationArguments([
      "--apply",
      QUEUE_COMMIT_SHA,
      QUEUE_ID,
      QUEUE_COMMIT_SHA,
      SERIALIZER_ID,
    ])).toThrow(/input|usage/i);
  });

  it("persists before exact journal clear and verifies after the clear", async () => {
    const events: string[] = [];
    const tokenJournal = journal();
    tokenJournal.read.mockImplementation(async () => {
      events.push("journal.read");
      return tokenJournal.clear.mock.calls.length === 0
        ? {
            queueId: QUEUE_ID,
            buildBatchId: BUILD_BATCH_ID,
            commitSha: QUEUE_COMMIT_SHA,
            claimToken: CLAIM_TOKEN,
            createdAt: "2026-09-02T23:28:59.000Z",
          }
        : null;
    });
    tokenJournal.clear.mockImplementation(async (request) => {
      events.push("journal.clear");
      expect(request).toEqual({ queueId: QUEUE_ID, claimToken: CLAIM_TOKEN });
      return { idempotent: false };
    });
    const cancelQueue = vi.fn(async ({ expected }) => {
      events.push(
        expected.claimTokenDigest === null
          ? "queue.verify"
          : "queue.cancel",
      );
      if (expected.claimTokenDigest !== null) {
        expect(expected.claimTokenDigest).toBe(CLAIM_TOKEN_DIGEST);
      }
      return cancellationResult(expected.claimTokenDigest === null);
    });

    const result = await runCmsPublicationBaselineUnclaimedCancellation({
      firestore: {} as Firestore,
      journal: tokenJournal,
      intent: intent(),
      dependencies: { cancelQueue },
    });

    expect(events).toEqual([
      "journal.read",
      "queue.cancel",
      "journal.clear",
      "journal.read",
      "queue.verify",
    ]);
    expect(result).toMatchObject({
      outcome: "cancelled",
      idempotent: false,
      queueIdempotent: false,
      journalIdempotent: false,
    });
    expect(JSON.stringify(result)).not.toContain(CLAIM_TOKEN);
    expect(JSON.stringify(result)).not.toContain(CLAIM_TOKEN_DIGEST);
  });

  it("does not clear a conflicting journal or an unverified terminal result", async () => {
    const conflictingJournal = journal({
      queueId: "Other0902Cutover0000",
      buildBatchId: "cms-Other0902Cutover0000",
      commitSha: QUEUE_COMMIT_SHA,
      claimToken: CLAIM_TOKEN,
      createdAt: "2026-09-02T23:28:59.000Z",
    });
    const cancelQueue = vi.fn();
    await expect(runCmsPublicationBaselineUnclaimedCancellation({
      firestore: {} as Firestore,
      journal: conflictingJournal,
      intent: intent(),
      dependencies: { cancelQueue },
    })).rejects.toThrow("belongs to another job");
    expect(cancelQueue).not.toHaveBeenCalled();
    expect(conflictingJournal.clear).not.toHaveBeenCalled();

    const retainedJournal = journal();
    cancelQueue.mockResolvedValue({
      outcome: "cancelled",
      idempotent: false,
      receipt: { queueId: "another-queue" },
    });
    await expect(runCmsPublicationBaselineUnclaimedCancellation({
      firestore: {} as Firestore,
      journal: retainedJournal,
      intent: intent(),
      dependencies: { cancelQueue },
    })).rejects.toThrow("was not cancelled");
    expect(retainedJournal.clear).not.toHaveBeenCalled();
  });

  it("supports an exact retry after the journal is already empty", async () => {
    const tokenJournal = journal(null);
    const cancelQueue = vi.fn().mockResolvedValue(cancellationResult(true));

    await expect(runCmsPublicationBaselineUnclaimedCancellation({
      firestore: {} as Firestore,
      journal: tokenJournal,
      intent: intent(),
      dependencies: { cancelQueue },
    })).resolves.toMatchObject({
      idempotent: true,
      queueIdempotent: true,
      journalIdempotent: true,
    });
    expect(tokenJournal.clear).not.toHaveBeenCalled();
    expect(cancelQueue).toHaveBeenCalledTimes(2);
    expect(cancelQueue.mock.calls[0][0].expected.claimTokenDigest).toBeNull();
  });
});

describe("unclaimed CMS publication baseline cancellation command", () => {
  it("refuses emulator routing before lock or credential access", async () => {
    const dependencies = {
      assertLock: vi.fn(),
      readCredential: vi.fn(),
    };

    await expect(runCmsPublicationBaselineUnclaimedCancellationCommand(
      [],
      dependencies,
      { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" },
    )).rejects.toThrow(/emulator route is not allowed/i);
    expect(dependencies.assertLock).not.toHaveBeenCalled();
    expect(dependencies.readCredential).not.toHaveBeenCalled();
  });

  it("verifies the exact clean source before lock or credential access", () => {
    const source = readFileSync(
      new URL(
        "../scripts/cancel-unclaimed-cms-publication-baseline.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const sourceGuard = source.indexOf(
      "await assertCmsPublicationSourceCheckout(intent.operatorCommitSha)",
    );
    const lock = source.indexOf("dependencies.assertLock(LOCK_FD, LOCK_PATH)");
    const credential = source.indexOf(
      "dependencies.readCredential(FIREBASE_CREDENTIAL_FD)",
    );

    expect(sourceGuard).toBeGreaterThan(-1);
    expect(sourceGuard).toBeLessThan(lock);
    expect(lock).toBeLessThan(credential);
  });

  it("locks before it opens the Firebase credential and execs Node directly", () => {
    const wrapper = readFileSync(
      new URL(
        "../../scripts/cancel-unclaimed-cms-publication-baseline.sh",
        import.meta.url,
      ),
      "utf8",
    );
    expect(wrapper).toContain("--preflight");
    expect(wrapper).toContain("/usr/bin/flock --exclusive --nonblock 5");
    expect(wrapper).toContain(
      'exec 3<"$CREDENTIALS_DIRECTORY/firebase-service-account"',
    );
    expect(wrapper.indexOf("--preflight")).toBeLessThan(
      wrapper.indexOf("/usr/bin/flock"),
    );
    expect(wrapper.indexOf("/usr/bin/flock")).toBeLessThan(
      wrapper.indexOf("exec 3<"),
    );
    expect(wrapper).toContain(
      'exec /usr/bin/node --import "$tsx_import" "$operator_path" "$@"',
    );
    expect(wrapper).not.toMatch(/\bnpm\b/);
  });

});
