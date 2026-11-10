// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertProductionFirestoreRouting,
  CmsPublicationBaselineOperatorError,
  parseApplyArguments,
  projectOperatorResult,
} from "../scripts/enqueue-cms-publication-baseline";

const QUEUE_ID = "11111111111111111111";
const COMMIT_SHA = "a".repeat(40);

describe("CMS publication baseline operator", () => {
  it("requires an explicit exact queue and source identity", () => {
    expect(parseApplyArguments(["--apply", QUEUE_ID, COMMIT_SHA])).toEqual({
      queueId: QUEUE_ID,
      commitSha: COMMIT_SHA,
    });
    for (const value of [
      [],
      ["--apply", "short", COMMIT_SHA],
      ["--apply", QUEUE_ID, "short"],
      [QUEUE_ID, COMMIT_SHA],
      ["--apply", QUEUE_ID, COMMIT_SHA, "extra"],
    ]) {
      expect(() => parseApplyArguments(value)).toThrow(
        CmsPublicationBaselineOperatorError,
      );
    }
  });

  it("requires one explicit static return ID and preserves ordinary and recovery argument guards", () => {
    expect(parseApplyArguments(["--apply", QUEUE_ID, COMMIT_SHA, "--return-post-to-static", "pilot-post"])).toEqual({
      queueId: QUEUE_ID, commitSha: COMMIT_SHA, returnPostId: "pilot-post",
    });
    for (const id of ["", "bad/id", "x".repeat(129)]) {
      expect(() => parseApplyArguments(["--apply", QUEUE_ID, COMMIT_SHA, "--return-post-to-static", id])).toThrow();
    }
    expect(() => parseApplyArguments(["--apply", QUEUE_ID, COMMIT_SHA, "--return-post-to-static"])).toThrow();
    expect(() => parseApplyArguments(["--apply", QUEUE_ID, COMMIT_SHA, "--unknown", "pilot-post"])).toThrow();
    expect(() => parseApplyArguments(["--apply-recovery", QUEUE_ID, COMMIT_SHA, "47", "54", "deployment-47", "b".repeat(40),
      "--return-post-to-static", "pilot-post"])).toThrow();
  });

  it("projects only the queue receipt", () => {
    expect(
      projectOperatorResult({
        success: true,
        queueId: QUEUE_ID,
        status: "pending",
        transport: "serializer",
        idempotent: false,
      }),
    ).toEqual({
      queueId: QUEUE_ID,
      status: "pending",
      transport: "serializer",
      idempotent: false,
    });
  });

  it("requires an explicit recovery mode and exact diverged predecessor", () => {
    const args = [
      "--apply-recovery",
      QUEUE_ID,
      COMMIT_SHA,
      "47",
      "54",
      "deployment-47",
      "b".repeat(40),
    ];
    expect(parseApplyArguments(args)).toEqual({
      queueId: QUEUE_ID,
      commitSha: COMMIT_SHA,
      expected: {
        activeGeneration: 47,
        lastReservedGeneration: 54,
        activeDeploymentId: "deployment-47",
        activeCommitSha: "b".repeat(40),
      },
    });
    for (const generation of [
      "0",
      "47",
      "-1",
      "1.5",
      "5e1",
      "9007199254740991",
    ]) {
      expect(() =>
        parseApplyArguments(
          args.map((value, i) => (i === 4 ? generation : value)),
        ),
      ).toThrow();
    }
    expect(() => parseApplyArguments(args.slice(0, 6))).toThrow();
  });

  it("refuses emulator routing and reads the credential only from fd 3", () => {
    expect(() =>
      assertProductionFirestoreRouting({
        FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
      }),
    ).toThrow("emulator route is not allowed");
    expect(() => assertProductionFirestoreRouting({})).not.toThrow();

    const source = readFileSync(
      new URL(
        "../scripts/enqueue-cms-publication-baseline.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(source).toContain("readFileSync(FIREBASE_CREDENTIAL_FD");
    expect(source).not.toContain("GOOGLE_APPLICATION_CREDENTIALS");
    expect(source).toContain("assertCmsPublicationSourceCheckout(commitSha)");
  });
});
