import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

import firebasePkg from "../../functions/lib/firebase.js";
import authPkg from "../../functions/lib/auth.js";

const { admin, db } = firebasePkg;
const {
  resetAuthTokenCache,
  requireAdmin,
  requireAuth,
  requirePrincipal,
  requireSuperAdmin,
  isSuperAdmin,
  verifyAppCheckToken,
  verifyAuthToken,
  AuthError,
} = authPkg;
// auth.js loads this through CommonJS, so the test reads that same module instance.
const { sessionWasRefused } = createRequire(import.meta.url)("../../functions/lib/session-refusal.js");

describe("auth helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetAuthTokenCache();
  });

  it("rejects a missing authorization header", async () => {
    await expect(verifyAuthToken(undefined)).rejects.toMatchObject({
      name: "AuthError",
      status: 401,
    });
    await expect(verifyAuthToken(undefined)).rejects.toBeInstanceOf(AuthError);
  });

  it("rejects a non-bearer authorization header", async () => {
    await expect(verifyAuthToken("Basic abc")).rejects.toMatchObject({
      name: "AuthError",
      status: 401,
    });
    await expect(verifyAuthToken("Basic abc")).rejects.toBeInstanceOf(AuthError);
  });

  it("rejects an empty bearer token", async () => {
    await expect(verifyAuthToken("Bearer ")).rejects.toMatchObject({
      name: "AuthError",
      status: 401,
    });
    await expect(verifyAuthToken("Bearer ")).rejects.toBeInstanceOf(AuthError);
  });

  it("rejects an invalid or expired token", async () => {
    vi.spyOn(admin.auth(), "verifyIdToken").mockRejectedValue(
      Object.assign(new Error("expired"), { code: "auth/id-token-expired" }),
    );

    await expect(verifyAuthToken("Bearer faketoken")).rejects.toMatchObject({
      name: "AuthError",
      status: 401,
    });
    await expect(verifyAuthToken("Bearer faketoken")).rejects.toBeInstanceOf(
      AuthError,
    );
  });

  it("surfaces a backend verification failure instead of masking it as 401", async () => {
    vi.spyOn(admin.auth(), "verifyIdToken").mockRejectedValue(
      Object.assign(new Error("backend down"), { code: "auth/internal-error" }),
    );

    const rejection = await verifyAuthToken("Bearer sometoken").then(
      () => null,
      (err) => err,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).not.toBeInstanceOf(AuthError);
    expect(rejection.message).toBe("backend down");
  });

  it("returns the trusted profile fields for a valid token", async () => {
    const verify = vi.spyOn(admin.auth(), "verifyIdToken").mockResolvedValue({
      uid: "u1",
      email: "u1@example.com",
      email_verified: true,
      name: "Editorial user",
    });

    await expect(verifyAuthToken("Bearer good")).resolves.toEqual({
      uid: "u1",
      email: "u1@example.com",
      emailVerified: true,
      displayName: "Editorial user",
      provider: null,
      authTime: null,
    });
    expect(verify).toHaveBeenCalledWith("good", true);
  });

  it("reuses a revoked-checked token for a few seconds", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const verify = vi.spyOn(admin.auth(), "verifyIdToken").mockResolvedValue({
      uid: "u1",
      email: "u1@example.com",
      email_verified: true,
    });
    await verifyAuthToken("Bearer good");
    now.mockReturnValue(1_004_999);
    await verifyAuthToken("Bearer good");
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith("good", true);
    now.mockReturnValue(1_005_001);
    await verifyAuthToken("Bearer good");
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it("rechecks revocation immediately when preview access bypasses the token cache", async () => {
    const verify = vi.spyOn(admin.auth(), "verifyIdToken").mockResolvedValue({ uid: "u1" });
    await verifyAuthToken("Bearer good");
    verify.mockRejectedValueOnce(Object.assign(new Error("revoked"), { code: "auth/id-token-revoked" }));
    await expect(verifyAuthToken("Bearer good", { cacheRevocation: false })).rejects.toMatchObject({ status: 401 });
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it("coalesces parallel revoked checks of the same token", async () => {
    const verify = vi.spyOn(admin.auth(), "verifyIdToken").mockResolvedValue({
      uid: "u1",
      email: "u1@example.com",
      email_verified: true,
    });
    const [first, second] = await Promise.all([
      verifyAuthToken("Bearer good"),
      verifyAuthToken("Bearer good"),
    ]);
    expect(first.uid).toBe("u1");
    expect(second.uid).toBe("u1");
    expect(verify).toHaveBeenCalledTimes(1);
  });

  // The sign-in audit row is keyed by the moment the person authenticated, not
  // the moment this token was minted, so the claim has to survive verification.
  it("carries the sign-in time when the token states one", async () => {
    const authTime = Math.floor(Date.now() / 1_000) - 60;
    vi.spyOn(admin.auth(), "verifyIdToken").mockResolvedValue({
      uid: "u1",
      email: "u1@example.com",
      email_verified: true,
      auth_time: authTime,
      firebase: { sign_in_provider: "google.com" },
    });

    await expect(verifyAuthToken("Bearer good")).resolves.toMatchObject({
      provider: "google.com",
      authTime,
    });
  });

  it("can return admission status from the same profile read as the principal", async () => {
    vi.spyOn(admin.auth(), "verifyIdToken").mockResolvedValue({ uid: "u1" });
    const get = vi.fn(async () => ({
      exists: true,
      data: () => ({ active: true, grants: [{ role: "staff" }] }),
    }));
    vi.spyOn(db, "collection").mockReturnValue({
      doc: vi.fn(() => ({ get })),
    });

    await expect(requirePrincipal(
      { headers: { authorization: "Bearer good" } },
      { includeAccountStatus: true },
    )).resolves.toMatchObject({
      uid: "u1",
      approvedActive: true,
      principal: { id: "u1", grants: [{ role: "staff" }] },
    });
    expect(get).toHaveBeenCalledOnce();
  });

  it("refuses a cached session that signed in before the stored revocation watermark", async () => {
    const authTime = Math.floor(Date.now() / 1_000) - 60;
    vi.spyOn(admin.auth(), "verifyIdToken").mockResolvedValue({ uid: "u1", email_verified: true, auth_time: authTime });
    let watermark = authTime;
    vi.spyOn(db, "collection").mockReturnValue({ doc: vi.fn(() => ({ get: async () => ({
      exists: true, data: () => ({ active: true, grants: [{ role: "staff" }], tokensValidAfter: watermark }),
    }) })) });
    // Same rule as Firestore: auth_time must be later than the watermark.
    await expect(requirePrincipal({ headers: { authorization: "Bearer good" } })).rejects.toMatchObject({ status: 401 });
    watermark = authTime - 1;
    await expect(requirePrincipal({ headers: { authorization: "Bearer good" } })).resolves.toMatchObject({ uid: "u1" });
  });

  it.each([
    ["verifyAuthToken", req => verifyAuthToken(req.headers.authorization)],
    ["requireAuth", req => requireAuth(req)],
    ["requireAdmin", req => requireAdmin(req)],
    ["requireSuperAdmin", req => requireSuperAdmin(req)],
    ["requirePrincipal", req => requirePrincipal(req)],
  ])("%s refuses a session 60 days after sign-in and accepts one at 59 days", async (name, verify) => {
    const days = n => Math.floor(Date.now() / 1_000) - n * 24 * 60 * 60;
    const token = vi.spyOn(admin.auth(), "verifyIdToken");
    const get = vi.fn(async () => ({ exists: true, data: () => ({ active: true, role: "super_admin" }) }));
    vi.spyOn(db, "collection").mockReturnValue({ doc: vi.fn(() => ({ get })) });

    token.mockResolvedValue({ uid: "u1", email_verified: true, auth_time: days(59) });
    await expect(verify({ headers: { authorization: "Bearer recent" } })).resolves.toMatchObject({ uid: "u1" });

    token.mockResolvedValue({ uid: "u1", email_verified: true, auth_time: days(60) });
    const req = { headers: { authorization: "Bearer aged" } };
    await expect(verify(req)).rejects.toMatchObject({ status: 401, code: "session_expired" });
    // A masked handler keeps the code only for a request marked as refused.
    expect(sessionWasRefused(req)).toBe(name !== "verifyAuthToken");
  });

  it("applies the watermark to direct super-admin checks", async () => {
    vi.spyOn(db, "collection").mockReturnValue({ doc: vi.fn(() => ({ get: async () => ({
      exists: true, data: () => ({ role: "super_admin", active: true, tokensValidAfter: 1_000 }),
    }) })) });
    await expect(isSuperAdmin("u1", true, 1_000)).resolves.toBe(false);
    await expect(isSuperAdmin("u1", true)).resolves.toBe(false);
    await expect(isSuperAdmin("u1", true, 1_001)).resolves.toBe(true);
  });

  it("rejects a missing production App Check token", async () => {
    const emulator = process.env.FUNCTIONS_EMULATOR;
    delete process.env.FUNCTIONS_EMULATOR;
    try {
      await expect(verifyAppCheckToken(undefined)).rejects.toMatchObject({
        name: "AuthError",
        status: 401,
      });
    } finally {
      if (emulator === undefined) delete process.env.FUNCTIONS_EMULATOR;
      else process.env.FUNCTIONS_EMULATOR = emulator;
    }
  });

  it("verifies a production App Check token with Firebase Admin", async () => {
    const emulator = process.env.FUNCTIONS_EMULATOR;
    delete process.env.FUNCTIONS_EMULATOR;
    const verifyToken = vi
      .spyOn(admin.appCheck(), "verifyToken")
      .mockResolvedValue({ appId: "admin-web-app", token: {} });
    try {
      await expect(verifyAppCheckToken("app-check-token")).resolves.toMatchObject({
        appId: "admin-web-app",
      });
      expect(verifyToken).toHaveBeenCalledWith("app-check-token");
    } finally {
      if (emulator === undefined) delete process.env.FUNCTIONS_EMULATOR;
      else process.env.FUNCTIONS_EMULATOR = emulator;
    }
  });
});
