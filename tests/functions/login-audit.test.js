// Staff sign-in evidence (#205).
//
// A sign-in is the one privileged event with no content write to ride along
// with, so it has its own writer. These cases pin the three properties that make
// it usable as compliance evidence: one row per real sign-in rather than one per
// browser tab, a refused admission recorded as loudly as an accepted one, and a
// failed audit write that never becomes a lockout.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  REFUSED_COOLDOWNS_COLLECTION,
  SIGN_IN_ACTIONS,
  recordStaffSignIn,
  signInAuditDocumentId,
} from "../../functions/lib/login-audit";

function alreadyExists() {
  const error = new Error("entity already exists");
  error.code = 6;
  return error;
}

function firestoreHarness({ createImpl, cooldown } = {}) {
  const created = [];
  const cooldownSets = [];
  const docIds = [];
  const create = vi.fn(async (value) => {
    if (createImpl) return createImpl(value);
    created.push(value);
    return { id: "written" };
  });
  const collection = vi.fn((name) => {
    if (name === REFUSED_COOLDOWNS_COLLECTION) {
      return {
        doc: vi.fn((id) => ({
          id,
          path: `${name}/${id}`,
        })),
      };
    }
    return {
      doc: vi.fn((id) => {
        docIds.push(id);
        return { create, path: `admin_logs/${id}` };
      }),
    };
  });
  const runTransaction = vi.fn(async (fn) => {
    const transaction = {
      get: vi.fn(async () => ({
        exists: Boolean(cooldown),
        data: () => cooldown,
      })),
      create: vi.fn((_ref, data) => {
        if (createImpl) return createImpl(data);
        created.push(data);
      }),
      set: vi.fn((_ref, data) => {
        cooldownSets.push(data);
      }),
    };
    return fn(transaction);
  });
  return {
    firestore: { collection, runTransaction },
    created,
    docIds,
    cooldownSets,
    create,
  };
}

const ACTOR = Object.freeze({
  uid: "editor-1",
  email: "editor@example.org",
  provider: "google.com",
  authTime: 1_755_800_000,
});

describe("staff sign-in audit (#205)", () => {
  let harness;

  beforeEach(() => {
    harness = firestoreHarness();
  });

  it("records an admitted sign-in with the actor, target and source", async () => {
    const outcome = await recordStaffSignIn({
      firestore: harness.firestore,
      actor: ACTOR,
      admitted: true,
      source: "203.0.113.9",
    });

    expect(outcome).toMatchObject({ recorded: true });
    expect(harness.created).toHaveLength(1);
    expect(harness.created[0]).toMatchObject({
      actorUid: "editor-1",
      actorEmail: "editor@example.org",
      action: SIGN_IN_ACTIONS.accepted,
      target: "users/editor-1",
      before: null,
      source: "203.0.113.9",
    });
    expect(harness.created[0].after).toEqual({
      admitted: true,
      provider: "google.com",
      reason: null,
    });
  });

  it("records a refused admission with the reason the boundary gave", async () => {
    await recordStaffSignIn({
      firestore: harness.firestore,
      actor: ACTOR,
      admitted: false,
      reason: "approval_required",
    });

    expect(harness.created[0]).toMatchObject({
      action: SIGN_IN_ACTIONS.refused,
      target: "users/editor-1",
    });
    expect(harness.created[0].after).toEqual({
      admitted: false,
      provider: "google.com",
      reason: "approval_required",
    });
    expect(harness.cooldownSets).toHaveLength(1);
    expect(harness.cooldownSets[0].expireAt).toBeTruthy();
  });

  it("skips a second refused write for the same email or IP inside the cooldown", async () => {
    const now = new Date("2026-09-18T14:00:00.000Z");
    const cooling = firestoreHarness({
      cooldown: { lastRefusedAt: new Date("2026-09-18T13:00:00.000Z") },
    });

    const outcome = await recordStaffSignIn({
      firestore: cooling.firestore,
      actor: { ...ACTOR, uid: "fresh-uid" },
      admitted: false,
      reason: "approval_required",
      source: "203.0.113.9",
      now,
    });

    expect(outcome).toEqual({ recorded: false, reason: "cooldown" });
    expect(cooling.created).toEqual([]);
  });

  it("does not append a refused row for an unverified email/password signup", async () => {
    const outcome = await recordStaffSignIn({
      firestore: harness.firestore,
      actor: { ...ACTOR, emailVerified: false },
      admitted: false,
      reason: "unverified_email",
    });

    expect(outcome).toEqual({ recorded: false, reason: "unverified" });
    expect(harness.created).toEqual([]);
  });

  it("carries no account fields beyond the uid and address the row already names", async () => {
    await recordStaffSignIn({
      firestore: harness.firestore,
      actor: { ...ACTOR, displayName: "Editorial user", ipAddress: "10.0.0.1" },
      admitted: true,
    });

    const written = JSON.stringify(harness.created[0]);
    expect(written).not.toContain("Editorial user");
    expect(written).not.toContain("10.0.0.1");
  });

  it("keys the row to the sign-in itself, so one session cannot write many rows", async () => {
    await recordStaffSignIn({
      firestore: harness.firestore,
      actor: ACTOR,
      admitted: true,
    });

    expect(harness.docIds).toEqual([signInAuditDocumentId(ACTOR)]);
    expect(signInAuditDocumentId(ACTOR)).toBe("signin_editor-1_1755800000");
  });

  it("treats a second call for the same session as already recorded", async () => {
    const duplicate = firestoreHarness({
      createImpl: () => {
        throw alreadyExists();
      },
    });

    const outcome = await recordStaffSignIn({
      firestore: duplicate.firestore,
      actor: ACTOR,
      admitted: true,
    });

    expect(outcome).toEqual({ recorded: false, reason: "duplicate" });
  });

  it("writes an unkeyed row when the provider surfaces no sign-in time", async () => {
    await recordStaffSignIn({
      firestore: harness.firestore,
      actor: { ...ACTOR, authTime: null },
      admitted: true,
    });

    expect(harness.docIds).toEqual([undefined]);
    expect(harness.created).toHaveLength(1);
  });

  it("never turns a failed audit write into a lockout, and logs it", async () => {
    const broken = firestoreHarness({
      createImpl: () => {
        throw new Error("firestore unavailable");
      },
    });
    const log = { error: vi.fn() };

    const outcome = await recordStaffSignIn({
      firestore: broken.firestore,
      actor: ACTOR,
      admitted: true,
      log,
    });

    expect(outcome).toEqual({ recorded: false, reason: "write_failed" });
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it("records nothing for an actor with no uid", async () => {
    const outcome = await recordStaffSignIn({
      firestore: harness.firestore,
      actor: { uid: "" },
      admitted: true,
    });

    expect(outcome).toEqual({ recorded: false, reason: "no_actor" });
    expect(harness.created).toEqual([]);
  });
});
