import { afterEach, describe, expect, it, vi } from "vitest";
import { createRegisterStaffProfileHandler } from "../../functions/staff-profile";
import authPkg from "../../functions/lib/auth.js";
import firebasePkg from "../../functions/lib/firebase.js";

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function request(overrides = {}) {
  return {
    method: "POST",
    headers: { authorization: "Bearer token" },
    body: {},
    ...overrides,
  };
}

function firestoreWithProfile(profile) {
  const get = vi.fn(async () => ({
    exists: profile !== undefined,
    data: () => profile,
  }));
  const doc = vi.fn(() => ({ get }));
  const collection = vi.fn(() => ({ doc }));
  return { firestore: { collection }, collection, doc, get };
}

function verifiedCaller(overrides = {}) {
  return {
    uid: "staff-1",
    email: "person@example.org",
    emailVerified: true,
    ...overrides,
  };
}

describe("registerStaffProfile", () => {
  it("accepts an existing approved profile without changing its authority", async () => {
    const harness = firestoreWithProfile({
      email: "person@example.org",
      active: true,
      role: null,
      grants: [{ role: "editor" }],
    });
    const recordStaffSignInFn = vi.fn(async () => ({ recorded: true }));
    const handler = createRegisterStaffProfileHandler({
      firestore: harness.firestore,
      verifyAuthTokenFn: vi.fn(async () => verifiedCaller()),
      recordStaffSignInFn,
    });
    const res = responseRecorder();

    await handler(request(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, uid: "staff-1", created: false });
    expect(harness.collection).toHaveBeenCalledTimes(1);
    expect(harness.collection).toHaveBeenCalledWith("users");
    expect(harness.doc).toHaveBeenCalledWith("staff-1");
    expect(recordStaffSignInFn).toHaveBeenCalledWith(
      expect.objectContaining({ admitted: true }),
    );
  });

  it("tells the edge when the sign-in row could not be written", async () => {
    const harness = firestoreWithProfile({
      email: "person@example.org",
      active: true,
      role: null,
      grants: [{ role: "editor" }],
    });
    const recordStaffSignInFn = vi.fn(async () => ({ recorded: false, reason: "write_failed" }));
    const handler = createRegisterStaffProfileHandler({
      firestore: harness.firestore,
      verifyAuthTokenFn: vi.fn(async () => verifiedCaller()),
      recordStaffSignInFn,
    });
    const res = responseRecorder();

    await handler(request(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, uid: "staff-1", created: false, auditPending: true });
  });

  it("requires an approved profile and cannot provision from retired onboarding data", async () => {
    const harness = firestoreWithProfile(undefined);
    const recordStaffSignInFn = vi.fn(async () => ({ recorded: true }));
    const handler = createRegisterStaffProfileHandler({
      firestore: harness.firestore,
      verifyAuthTokenFn: vi.fn(async () => verifiedCaller()),
      recordStaffSignInFn,
    });
    const res = responseRecorder();

    await handler(request(), res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      error: "Account approval required",
      code: "approval_required",
    });
    expect(harness.collection).toHaveBeenCalledTimes(1);
    expect(recordStaffSignInFn).toHaveBeenCalledWith(
      expect.objectContaining({ admitted: false, reason: "approval_required" }),
    );
  });

  it.each([
    [
      { email: "person@example.org", active: false },
      "Staff account is inactive",
      "inactive_account",
    ],
    [
      { email: "other@example.org", active: true },
      "The approved account email changed",
      "email_changed",
    ],
    [
      // The caller fixture has no auth_time, so any stored watermark rejects it.
      { email: "person@example.org", active: true, tokensValidAfter: 1_000 },
      "This session was revoked. Sign in again",
      "session_revoked",
    ],
  ])("rejects an unusable approved profile", async (profile, message, reason) => {
    const harness = firestoreWithProfile(profile);
    const recordStaffSignInFn = vi.fn(async () => ({ recorded: true }));
    const handler = createRegisterStaffProfileHandler({
      firestore: harness.firestore,
      verifyAuthTokenFn: vi.fn(async () => verifiedCaller()),
      recordStaffSignInFn,
    });
    const res = responseRecorder();

    await handler(request(), res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: message, code: reason });
    expect(recordStaffSignInFn).toHaveBeenCalledWith(
      expect.objectContaining({ admitted: false, reason }),
    );
  });

  it("rejects an unverified identity before it reads the staff profile", async () => {
    const harness = firestoreWithProfile({ email: "person@example.org", active: true });
    const handler = createRegisterStaffProfileHandler({
      firestore: harness.firestore,
      verifyAuthTokenFn: vi.fn(async () => verifiedCaller({ emailVerified: false })),
    });
    const res = responseRecorder();

    await handler(request(), res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      error: "A verified email account is required",
      code: "unverified_email",
    });
    expect(harness.collection).not.toHaveBeenCalled();
  });

  it("refuses methods other than POST", async () => {
    const handler = createRegisterStaffProfileHandler();
    const res = responseRecorder();

    await handler(request({ method: "GET" }), res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: "Method not allowed" });
  });

  it("keeps unexpected profile read failures private", async () => {
    const log = { error: vi.fn() };
    const firestore = {
      collection: () => ({ doc: () => ({ get: vi.fn(async () => { throw new Error("database detail"); }) }) }),
    };
    const handler = createRegisterStaffProfileHandler({
      firestore,
      verifyAuthTokenFn: vi.fn(async () => verifiedCaller()),
      log,
    });
    const res = responseRecorder();

    await handler(request(), res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Unable to register staff profile" });
    expect(log.error).toHaveBeenCalledWith("registerStaffProfile failed", expect.any(Error));
  });

  // Only the Admin SDK is fake, so the real verifier's typed refusal reaches this serializer.
  describe("a refused token", () => {
    afterEach(() => { vi.restoreAllMocks(); authPkg.resetAuthTokenCache(); });

    it.each([
      ["auth/id-token-expired", { code: "session_expired", reason: "token_expired" }],
      ["auth/id-token-revoked", { code: "session_expired" }],
    ])("keeps only the trusted refusal fields for %s", async (code, expected) => {
      vi.spyOn(firebasePkg.admin.auth(), "verifyIdToken").mockRejectedValue(
        Object.assign(new Error("Synthetic refusal"), { code }),
      );
      const res = responseRecorder();

      await createRegisterStaffProfileHandler({ firestore: firestoreWithProfile().firestore })(request(), res);

      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ error: "Invalid or expired authentication token", ...expected });
    });
  });
});
