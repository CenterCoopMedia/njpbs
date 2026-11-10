// @vitest-environment node

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import {
  parseCancellationArguments,
  runCmsPublicationBaselineClaimedCancellation,
  runCmsPublicationBaselineClaimedCancellationCommand,
} from "../scripts/cancel-claimed-cms-publication-baseline";
import type {
  CmsPublicationJournalJob,
} from "../scripts/cms-publication-token-journal";

const QUEUE_ID = "Apex0903Cutover00001";
const BUILD_BATCH_ID = `cms-${QUEUE_ID}`;
const GENERATION = 37;
const OPERATOR_COMMIT_SHA = "f".repeat(40);
const QUEUE_COMMIT_SHA = "e".repeat(40);
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
    generation: GENERATION,
    queueCommitSha: QUEUE_COMMIT_SHA,
    serializerId: SERIALIZER_ID,
  };
}

function journal(job: null | CmsPublicationJournalJob = {
  queueId: QUEUE_ID,
  buildBatchId: BUILD_BATCH_ID,
  commitSha: QUEUE_COMMIT_SHA,
  claimToken: CLAIM_TOKEN,
  createdAt: "2026-09-03T15:00:00.000Z",
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
      generation: GENERATION,
      queueCommitSha: QUEUE_COMMIT_SHA,
      operatorCommitSha: OPERATOR_COMMIT_SHA,
      serializerId: SERIALIZER_ID,
    },
  };
}

describe("claimed CMS publication baseline cancellation operator", () => {
  it("parses the exact generation and separate old and replacement sources", () => {
    expect(parseCancellationArguments([
      "--apply",
      OPERATOR_COMMIT_SHA,
      QUEUE_ID,
      String(GENERATION),
      QUEUE_COMMIT_SHA,
      SERIALIZER_ID,
    ])).toEqual(intent());
    expect(() => parseCancellationArguments([
      "--apply",
      QUEUE_COMMIT_SHA,
      QUEUE_ID,
      String(GENERATION),
      QUEUE_COMMIT_SHA,
      SERIALIZER_ID,
    ])).toThrow(/usage/i);
    expect(() => parseCancellationArguments([
      "--apply",
      OPERATOR_COMMIT_SHA,
      QUEUE_ID,
      "037",
      QUEUE_COMMIT_SHA,
      SERIALIZER_ID,
    ])).toThrow(/usage/i);
  });

  it("commits before exact journal clear and verifies the terminal receipt", async () => {
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
            createdAt: "2026-09-03T15:00:00.000Z",
          }
        : null;
    });
    tokenJournal.clear.mockImplementation(async (request) => {
      events.push("journal.clear");
      expect(request).toEqual({ queueId: QUEUE_ID, claimToken: CLAIM_TOKEN });
      return { idempotent: false };
    });
    const cancelQueue = vi.fn(async ({ expected }) => {
      events.push(expected.claimTokenDigest === null ? "queue.verify" : "queue.cancel");
      if (expected.claimTokenDigest !== null) {
        expect(expected.claimTokenDigest).toBe(CLAIM_TOKEN_DIGEST);
      }
      return cancellationResult(expected.claimTokenDigest === null);
    });

    await expect(runCmsPublicationBaselineClaimedCancellation({
      firestore: {} as Firestore,
      journal: tokenJournal,
      intent: intent(),
      dependencies: { cancelQueue },
    })).resolves.toMatchObject({
      idempotent: false,
      queueIdempotent: false,
      journalIdempotent: false,
    });
    expect(events).toEqual([
      "journal.read",
      "queue.cancel",
      "journal.clear",
      "journal.read",
      "queue.verify",
    ]);
  });

  it("retains the journal on a database or journal-clear failure", async () => {
    const databaseFailureJournal = journal();
    await expect(runCmsPublicationBaselineClaimedCancellation({
      firestore: {} as Firestore,
      journal: databaseFailureJournal,
      intent: intent(),
      dependencies: {
        cancelQueue: vi.fn(async () => {
          throw new Error("database unavailable");
        }),
      },
    })).rejects.toThrow("database unavailable");
    expect(databaseFailureJournal.clear).not.toHaveBeenCalled();
    await expect(databaseFailureJournal.read()).resolves.toMatchObject({
      queueId: QUEUE_ID,
    });

    const clearFailureJournal = journal();
    clearFailureJournal.clear.mockRejectedValueOnce(new Error("disk full"));
    const cancelQueue = vi.fn().mockResolvedValue(cancellationResult(false));
    await expect(runCmsPublicationBaselineClaimedCancellation({
      firestore: {} as Firestore,
      journal: clearFailureJournal,
      intent: intent(),
      dependencies: { cancelQueue },
    })).rejects.toThrow("disk full");
    await expect(clearFailureJournal.read()).resolves.toMatchObject({
      queueId: QUEUE_ID,
    });
  });

  it("clears a retained terminal job and supports an empty-journal retry", async () => {
    const terminalJournal = journal();
    const cancelQueue = vi.fn().mockResolvedValue(cancellationResult(true));
    await expect(runCmsPublicationBaselineClaimedCancellation({
      firestore: {} as Firestore,
      journal: terminalJournal,
      intent: intent(),
      dependencies: { cancelQueue },
    })).resolves.toMatchObject({
      queueIdempotent: true,
      journalIdempotent: false,
    });
    expect(terminalJournal.clear).toHaveBeenCalledOnce();

    const emptyJournal = journal(null);
    await expect(runCmsPublicationBaselineClaimedCancellation({
      firestore: {} as Firestore,
      journal: emptyJournal,
      intent: intent(),
      dependencies: { cancelQueue },
    })).resolves.toMatchObject({ idempotent: true });
    expect(emptyJournal.clear).not.toHaveBeenCalled();
  });

  it("refuses a conflicting journal before the database call", async () => {
    const tokenJournal = journal({
      queueId: "Other0903Cutover0000",
      buildBatchId: "cms-Other0903Cutover0000",
      commitSha: QUEUE_COMMIT_SHA,
      claimToken: CLAIM_TOKEN,
      createdAt: "2026-09-03T15:00:00.000Z",
    });
    const cancelQueue = vi.fn();
    await expect(runCmsPublicationBaselineClaimedCancellation({
      firestore: {} as Firestore,
      journal: tokenJournal,
      intent: intent(),
      dependencies: { cancelQueue },
    })).rejects.toThrow("belongs to another job");
    expect(cancelQueue).not.toHaveBeenCalled();
  });
});

describe("claimed CMS publication baseline cancellation command", () => {
  it("refuses emulator routing before lock or credential access", async () => {
    const dependencies = {
      assertLock: vi.fn(),
      readCredential: vi.fn(),
    };
    await expect(runCmsPublicationBaselineClaimedCancellationCommand(
      [],
      dependencies,
      { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" },
    )).rejects.toThrow(/emulator route is not allowed/i);
    expect(dependencies.assertLock).not.toHaveBeenCalled();
    expect(dependencies.readCredential).not.toHaveBeenCalled();
  });

  it("checks exact source and ancestry before lock and credential access", () => {
    const source = readFileSync(
      new URL(
        "../scripts/cancel-claimed-cms-publication-baseline.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const checkout = source.indexOf(
      "await assertCmsPublicationSourceCheckout(intent.operatorCommitSha)",
    );
    const ancestry = source.indexOf("await assertCmsPublicationSourceAncestor(");
    const lock = source.indexOf("dependencies.assertLock(LOCK_FD, LOCK_PATH)");
    const credential = source.indexOf(
      "dependencies.readCredential(FIREBASE_CREDENTIAL_FD)",
    );

    expect(checkout).toBeGreaterThan(-1);
    expect(checkout).toBeLessThan(ancestry);
    expect(ancestry).toBeLessThan(lock);
    expect(lock).toBeLessThan(credential);
  });

  it("takes FD5 before Firebase FD3 and directly execs Node", () => {
    const wrapper = readFileSync(
      new URL(
        "../../scripts/cancel-claimed-cms-publication-baseline.sh",
        import.meta.url,
      ),
      "utf8",
    );
    expect(wrapper).toContain("--preflight");
    expect(wrapper).toContain("/usr/bin/flock --exclusive --nonblock 5");
    expect(wrapper).toContain(
      'exec 3<"$CREDENTIALS_DIRECTORY/firebase-service-account"',
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
