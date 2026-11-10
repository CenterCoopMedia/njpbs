import { describe, expect, it, vi } from "vitest";
import staff from "../../functions/deactivate-staff.js";

const { createDeactivateStaffHandler } = staff;

function request(overrides = {}) {
  return {
    method: "POST",
    headers: { authorization: "Bearer token" },
    body: { targetUid: "target-1" },
    ip: "203.0.113.19",
    ...overrides,
  };
}

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    headersSent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      this.headersSent = true;
      return this;
    },
  };
}

function harness({ updateFailure, revokeFailure, getFailure, watermarkFailure } = {}) {
  const user = { active: false, offboarding: { id: "operation-1", step: "public_profile" } };
  const update = vi.fn(async (change) => {
    if (watermarkFailure && "tokensValidAfter" in change) throw watermarkFailure;
    Object.assign(user, change);
  });
  // Auth sync reads the stored account state; this account stays inactive.
  const get = vi.fn(async () => ({ exists: true, data: () => user }));
  const doc = vi.fn(() => ({ update, get }));
  const collection = vi.fn(() => ({ doc }));
  const authClient = {
    updateUser: vi.fn(async () => {
      if (updateFailure) throw updateFailure;
    }),
    revokeRefreshTokens: vi.fn(async () => {
      if (revokeFailure) throw revokeFailure;
    }),
    getUser: vi.fn(async () => {
      if (getFailure) throw getFailure;
      return { tokensValidAfterTime: "2026-08-04T06:00:00.000Z" };
    }),
  };
  return {
    authClient,
    // The watermark write is a read-then-write transaction over the same doc.
    firestore: { collection, runTransaction: async (fn) => {
      const writes = [];
      const result = await fn({ get: (ref) => ref.get(), update: (ref, data) => { writes.push([ref, data]); } });
      for (const [ref, data] of writes) await ref.update(data);
      return result;
    } },
    update,
    user,
  };
}

function handlerFor(harness, overrides = {}) {
  return createDeactivateStaffHandler({
    firestore: harness.firestore,
    authClient: harness.authClient,
    requireSuperAdminFn: vi.fn(async () => ({
      uid: "actor-1",
      email: "actor@example.com",
    })),
    deactivateProfileFn: vi.fn(async () => ({ alreadyInactive: false, offboardingId: "operation-1" })),
    withdrawAuthorProfileFn: vi.fn(async () => ({
      profile: null,
      withdrawn: false,
    })),
    log: { error: vi.fn() },
    ...overrides,
  });
}

describe("deactivateStaff Auth reconciliation", () => {
  it("mirrors the revoked-after watermark in token auth_time seconds", async () => {
    const state = harness();
    const handler = handlerFor(state);
    const res = responseRecorder();

    await handler(request(), res);

    expect(res.statusCode).toBe(200);
    expect(state.user.offboarding.step).toBe("complete");
    expect(state.authClient.updateUser).toHaveBeenCalledWith("target-1", {
      disabled: true,
    });
    expect(state.authClient.revokeRefreshTokens).toHaveBeenCalledWith("target-1");
    expect(state.update).toHaveBeenCalledWith(
      expect.objectContaining({
        tokensValidAfter: Date.parse("2026-08-04T06:00:00.000Z") / 1_000,
      }),
    );
  });

  it.each([
    ["disable", { updateFailure: new Error("disable unavailable") }],
    ["revoke", { revokeFailure: new Error("revoke unavailable") }],
    ["watermark", { watermarkFailure: new Error("firestore unavailable") }],
  ])("returns 503 after a partial %s failure so the action can be retried", async (_label, options) => {
    const state = harness(options);
    const handler = handlerFor(state);
    const res = responseRecorder();

    await handler(request(), res);

    expect(res.statusCode).toBe(503);
    expect(state.user.offboarding.step).toBe("sign_in_and_sessions");
    expect(res.body).toMatchObject({
      error: "CMS access is disabled, but session revocation must be retried",
      uid: "target-1",
      cmsAccessDisabled: true,
    });
  });

  it("treats a missing Auth user as terminal success", async () => {
    const missing = Object.assign(new Error("missing"), {
      code: "auth/user-not-found",
    });
    const state = harness({ updateFailure: missing });
    const handler = handlerFor(state);
    const res = responseRecorder();

    await handler(request(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      uid: "target-1",
      authUserMissing: true,
    });
    expect(state.authClient.revokeRefreshTokens).not.toHaveBeenCalled();
  });

  it("withdraws the public author profile as part of deactivation", async () => {
    const state = harness();
    const withdrawAuthorProfileFn = vi.fn(async () => ({
      profile: { authorId: "au_" + "0".repeat(32) },
      withdrawn: true,
    }));
    const handler = handlerFor(state, { withdrawAuthorProfileFn });
    const res = responseRecorder();

    await handler(request(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, publicProfileWithdrawn: true });
    expect(withdrawAuthorProfileFn).toHaveBeenCalledWith(
      expect.objectContaining({
        uid: "target-1",
        actorUid: "actor-1",
        actorEmail: "actor@example.com",
      }),
    );
  });

  it("returns 503 and leaves sessions alone when the profile withdrawal fails", async () => {
    // A public author page left standing is the visible half of a deactivation,
    // so it must not be reported as a clean success.
    const state = harness();
    const log = { error: vi.fn() };
    const handler = handlerFor(state, {
      withdrawAuthorProfileFn: vi.fn(async () => {
        throw new Error("firestore unavailable");
      }),
      log,
    });
    const res = responseRecorder();

    await handler(request(), res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({
      error:
        "CMS access is disabled, but the public author profile must be withdrawn on retry",
      uid: "target-1",
      cmsAccessDisabled: true,
    });
    expect(state.authClient.updateUser).not.toHaveBeenCalled();
    expect(state.user.offboarding.step).toBe("public_profile");
  });

  it("does not expose an unexpected backend error to the client", async () => {
    const state = harness();
    const backendError = new Error("firestore socket details");
    const log = { error: vi.fn() };
    const handler = handlerFor(state, {
      deactivateProfileFn: vi.fn(async () => {
        throw backendError;
      }),
      log,
    });
    const res = responseRecorder();

    await handler(request(), res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Failed to deactivate staff account" });
    expect(log.error).toHaveBeenCalledWith("deactivateStaff failed", backendError);
  });
});
