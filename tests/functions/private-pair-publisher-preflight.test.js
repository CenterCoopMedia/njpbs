import { beforeAll, beforeEach, expect, it } from "vitest";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { privatePairPublisherScenario } from "../helpers/private-pair-publisher-install.mjs";
import * as fixture from "../helpers/private-pair-publisher-provider.mjs";
import { installPrivatePairPublisherWithPreflight as installPrivatePairPublisher } from "../../scripts/lib/private-pair-publisher-preflight.mjs";
import ownership from "../../functions/lib/public-release-pair-work.js";

let db;
beforeAll(() => { db = isolatedFirestore("private-pair-publisher-preflight.test.js"); });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`,
    { method: "DELETE" }, db);
});

async function scenario(options = {}) {
  // Public account identity from the repository's pinned Wrangler configuration.
  // Every request is intercepted at the HTTP boundary; no provider is contacted.
  const current = await privatePairPublisherScenario(db, { accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  const authority = { session: 0, upload: 0, invoke: 0 };
  const fetchImpl = async (input, init) => {
    const url = new URL(input), method = init?.method ?? "GET";
    if (url.pathname.endsWith("/workers/subdomain")) return fixture.envelope({ subdomain: "fixture" });
    if (url.pathname.endsWith("/workers/subdomain/edge-preview")) {
      authority.session++;
      expect(method).toBe("GET");
      return fixture.envelope({ token: "synthetic-session-token" });
    }
    if (/\/workers\/scripts\/njpbs-private-preflight-[a-f0-9]{24}\/edge-preview$/.test(url.pathname)) {
      authority.upload++;
      expect(method).toBe("POST");
      expect(JSON.parse(init.body.get("metadata")).bindings).toEqual([
        { name: "PAIR_PREFLIGHT", type: "service", service: fixture.applicationName, entrypoint: "PairPublicationWake" },
      ]);
      if (options.loseUploadReply) throw new Error("synthetic-sensitive-boundary-text");
      return fixture.envelope({ preview_token: "synthetic-preview-token" });
    }
    if (url.hostname.endsWith(".fixture.workers.dev")) {
      authority.invoke++;
      expect(method).toBe("POST");
      expect(url.pathname).toBe("/__private_pair_preflight");
      if (options.retireDuringRpc) await db.doc(`${ownership.publicReleasePairPath(fixture.identity.pairId)}/controls/runtime`).update({ status: "retired" });
      return Response.json(options.notReady
        ? { ready: false, pairId: fixture.identity.pairId, reason: "waiting-for-executor" }
        : { ready: true, ...fixture.identity });
    }
    return current.input.fetchImpl(input, init);
  };
  return { ...current, authority, input: { ...current.input, fetchImpl, preflightOperationId: "publisher-integration-proof",
    clock: () => Date.parse("2026-10-28T17:00:00Z") } };
}

it("preserves pre-cancel and explicit authorization checks before all provider reads", async () => {
  const current = await scenario();
  await expect(installPrivatePairPublisher({ ...current.input, authorized: false })).rejects.toMatchObject({ code: "install-not-authorized" });
  await expect(installPrivatePairPublisher({ ...current.input, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "install-cancelled" });
  expect(current.requests).toHaveLength(0);
  expect(current.counters().credentialReads).toBe(0);
  expect(current.authority).toEqual({ session: 0, upload: 0, invoke: 0 });
});

it("binds the actual caller lazily to the installed UUID and reuses its original proof without new authority", async () => {
  const current = await scenario();
  const receipt = await installPrivatePairPublisher(current.input);
  expect(receipt.runtime).toEqual({ ready: true, pairId: fixture.identity.pairId,
    commitSha: fixture.identity.commitSha, journalNamespace: fixture.identity.journalNamespace });
  const attempt = (await db.collection("privatePairPreflightAttempts").doc("publisher-integration-proof").get()).data();
  expect(attempt).toMatchObject({ state: "complete", request: { workerVersion: fixture.versionId,
    workerName: fixture.applicationName, installedTargetDigest: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  expect(JSON.stringify(attempt)).not.toContain("synthetic-session-token");
  expect(JSON.stringify(attempt)).not.toContain("synthetic-preview-token");
  expect(await installPrivatePairPublisher(current.input)).toEqual(receipt);
  expect(current.authority).toEqual({ session: 1, upload: 1, invoke: 1 });
  expect(current.writes()).toHaveLength(4);
  expect((await db.doc("system/publicDeployment").get()).exists).toBe(false);
});

it("keeps a lost preview upload response uncertain without a second authority attempt", async () => {
  const current = await scenario({ loseUploadReply: true });
  await expect(installPrivatePairPublisher(current.input)).rejects.toMatchObject({ code: "preflight-request-uncertain", uncertain: true });
  await expect(installPrivatePairPublisher(current.input)).rejects.toMatchObject({ code: "preflight-attempt-uncertain", uncertain: true });
  expect(current.authority).toEqual({ session: 1, upload: 1, invoke: 0 });
  expect(current.writes()).toHaveLength(4);
});

it("preserves a definite not-ready result and its safe health reason across restart", async () => {
  const current = await scenario({ notReady: true });
  const expected = { code: "private-preflight-not-ready", uncertain: false,
    refusalHealth: { ready: false, pairId: fixture.identity.pairId, reason: "waiting-for-executor" } };
  await expect(installPrivatePairPublisher(current.input)).rejects.toMatchObject({ code: expected.code, uncertain: false });
  const stored = (await db.collection("privatePairPreflightAttempts").doc("publisher-integration-proof").get()).data();
  expect(stored).toMatchObject({ state: "failed", refusalHealth: expected.refusalHealth });
  await expect(installPrivatePairPublisher(current.input)).rejects.toMatchObject(expected);
  expect(current.authority).toEqual({ session: 1, upload: 1, invoke: 1 });
  expect(current.writes()).toHaveLength(4);
});

it("cannot report ready when the registered runtime retires during the actual RPC", async () => {
  const current = await scenario({ retireDuringRpc: true });
  await expect(installPrivatePairPublisher(current.input)).rejects.toMatchObject({ code: "preflight-target-unavailable", uncertain: false });
  const attempt = (await db.collection("privatePairPreflightAttempts").doc("publisher-integration-proof").get()).data();
  expect(attempt.state).toBe("failed");
  expect(attempt).not.toHaveProperty("result");
  expect(current.writes()).toHaveLength(4);
});
