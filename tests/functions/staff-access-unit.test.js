import { afterEach, describe, expect, it, vi } from "vitest";
import staffAccess from "../../functions/staff-access.js";
import authPkg from "../../functions/lib/auth.js";
import firebasePkg from "../../functions/lib/firebase.js";

const {
  PASSWORD_RESETS_COLLECTION,
  REQUESTS_COLLECTION,
  createStaffAccessHandlers,
} = staffAccess;
const NOW = new Date("2026-09-17T15:22:00.000Z");

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

function request(body) {
  return {
    method: "POST",
    body,
    headers: {
      authorization: "Bearer token",
      "x-firebase-appcheck": "app-check-token",
    },
  };
}

function firestoreHarness() {
  const rows = new Map();

  function snapshot(path) {
    const value = rows.get(path);
    return {
      exists: value !== undefined,
      data: () => value,
    };
  }

  function makeRef(collectionName, id) {
    const path = `${collectionName}/${id}`;
    return {
      id,
      path,
      get: vi.fn(async () => snapshot(path)),
    };
  }

  const collection = vi.fn((collectionName) => ({
    doc: vi.fn((id) => makeRef(collectionName, id)),
  }));
  const runTransaction = vi.fn(async (callback) => {
    const writes = [];
    const transaction = {
      get: vi.fn(async (ref) => snapshot(ref.path)),
      set: vi.fn((ref, data, options) => {
        writes.push({ type: "set", ref, data, options });
      }),
      update: vi.fn((ref, data) => {
        writes.push({ type: "update", ref, data });
      }),
    };
    const result = await callback(transaction);
    for (const write of writes) {
      const current = rows.get(write.ref.path) ?? {};
      rows.set(
        write.ref.path,
        write.type === "update" || write.options?.merge
          ? { ...current, ...write.data }
          : write.data,
      );
    }
    return result;
  });

  return {
    firestore: { collection, runTransaction },
    rows,
  };
}

function handlerHarness(overrides = {}) {
  const store = firestoreHarness();
  let now = new Date(NOW);
  let uuid = 0;
  const authAdmin = {
    generateEmailVerificationLink: vi.fn(async () =>
      "https://admin.njpbs.org/?mode=verifyEmail&oobCode=verify",
    ),
    generatePasswordResetLink: vi.fn(async () =>
      "https://admin.njpbs.org/?mode=resetPassword&oobCode=reset",
    ),
    getUserByEmail: vi.fn(async () => ({
      uid: "requester-1",
      email: "person@example.org",
      disabled: false,
      displayName: "Person",
    })),
    ...overrides.authAdmin,
  };
  const log = {
    error: vi.fn(),
    warn: vi.fn(),
  };
  const handlers = createStaffAccessHandlers({
    firestore: store.firestore,
    authAdmin,
    verifyAuthTokenFn: vi.fn(async () => ({
      uid: "requester-1",
      email: "person@example.org",
      emailVerified: false,
      displayName: "Person",
      provider: "password",
    })),
    verifyAppCheckTokenFn: vi.fn(async () => undefined),
    deliverEmailFn: vi.fn(async () => ({ state: "sent" })),
    queueNotificationFn: vi.fn(),
    now: () => new Date(now),
    randomUUID: () => `uuid-${++uuid}`,
    log,
  });

  return {
    ...store,
    authAdmin,
    handlers,
    log,
    setNow(value) {
      now = new Date(value);
    },
  };
}

describe("staff access email action limits", () => {
  it("uses the submitted reason for a new verification request version", async () => {
    const harness = handlerHarness();
    const requestPath = `${REQUESTS_COLLECTION}/requester-1`;
    harness.rows.set(requestPath, {
      uid: "requester-1",
      email: "person@example.org",
      displayName: "Person",
      provider: "password",
      reason: "The old request reason.",
      state: "email_verification",
      requestVersion: 1,
      reference: "requester-1-v1",
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      versionCreatedAt: new Date("2026-08-01T00:00:00.000Z"),
      expireAt: new Date("2026-08-31T00:00:00.000Z"),
    });

    const response = responseRecorder();
    await harness.handlers.submit(
      request({ reason: "I now edit the program schedule." }),
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(harness.rows.get(requestPath)).toMatchObject({
      reason: "I now edit the program schedule.",
      requestVersion: 2,
      state: "email_verification",
      expireAt: new Date("2026-10-17T15:22:00.000Z"),
    });
  });

  it("does not replace a pending verification outbox row", async () => {
    const harness = handlerHarness();
    const first = responseRecorder();
    await harness.handlers.submit(
      request({ reason: "I edit program pages." }),
      first,
    );
    expect(first.statusCode).toBe(200);

    const outboxPath = "staffAccessEmailOutbox/requester-1--1--verify";
    const firstOutbox = harness.rows.get(outboxPath);
    const pendingOutbox = { ...firstOutbox, state: "pending" };
    harness.rows.set(outboxPath, pendingOutbox);

    const repeated = responseRecorder();
    await harness.handlers.submit(request({ reason: "" }), repeated);

    expect(repeated.statusCode).toBe(200);
    expect(repeated.body).toMatchObject({ mailState: "pending" });
    expect(harness.authAdmin.generateEmailVerificationLink).toHaveBeenCalledTimes(1);
    expect(harness.rows.get(outboxPath)).toEqual(pendingOutbox);
    expect(
      harness.rows.get(`${REQUESTS_COLLECTION}/requester-1`).reason,
    ).toBe("I edit program pages.");
  });

  it("uses sentAt for the resend cooldown and reports a suppressed send", async () => {
    const harness = handlerHarness();
    const first = responseRecorder();
    await harness.handlers.submit(
      request({ reason: "I edit program pages." }),
      first,
    );

    const outboxPath = "staffAccessEmailOutbox/requester-1--1--verify";
    const firstOutbox = harness.rows.get(outboxPath);
    const sentOutbox = {
      ...firstOutbox,
      state: "sent",
      createdAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      sentAt: NOW,
    };
    harness.rows.set(outboxPath, sentOutbox);

    const repeated = responseRecorder();
    await harness.handlers.submit(request({ reason: "" }), repeated);
    expect(repeated.body).toMatchObject({ mailState: "suppressed" });
    expect(harness.rows.get(outboxPath)).toEqual(sentOutbox);
    expect(harness.authAdmin.generateEmailVerificationLink).toHaveBeenCalledTimes(1);

    harness.setNow(new Date(NOW.getTime() + 16 * 60 * 1000));
    const afterCooldown = responseRecorder();
    await harness.handlers.submit(request({ reason: "" }), afterCooldown);
    expect(afterCooldown.statusCode).toBe(200);
    expect(harness.authAdmin.generateEmailVerificationLink).toHaveBeenCalledTimes(2);
  });

  it("uses createdAt for the cooldown on a legacy sent row", async () => {
    const harness = handlerHarness();
    const first = responseRecorder();
    await harness.handlers.submit(
      request({ reason: "I edit program pages." }),
      first,
    );

    const outboxPath = "staffAccessEmailOutbox/requester-1--1--verify";
    const firstOutbox = harness.rows.get(outboxPath);
    harness.rows.set(outboxPath, { ...firstOutbox, state: "sent", sentAt: null });

    const repeated = responseRecorder();
    await harness.handlers.submit(request({ reason: "" }), repeated);
    expect(repeated.body).toMatchObject({ mailState: "suppressed" });
    expect(harness.authAdmin.generateEmailVerificationLink).toHaveBeenCalledTimes(1);
  });

  it("reports an in-progress link preparation without starting another one", async () => {
    let resolveLink = () => {};
    const link = new Promise((resolve) => {
      resolveLink = () => resolve(
        "https://admin.njpbs.org/?mode=verifyEmail&oobCode=first",
      );
    });
    const harness = handlerHarness({
      authAdmin: {
        generateEmailVerificationLink: vi.fn(() => link),
      },
    });
    const first = responseRecorder();
    const firstRequest = harness.handlers.submit(
      request({ reason: "I edit program pages." }),
      first,
    );
    await vi.waitFor(() => {
      expect(harness.authAdmin.generateEmailVerificationLink).toHaveBeenCalledTimes(1);
    });

    const concurrent = responseRecorder();
    await harness.handlers.submit(request({ reason: "" }), concurrent);
    expect(concurrent).toMatchObject({
      statusCode: 200,
      body: { mailState: "preparing" },
    });
    expect(harness.authAdmin.generateEmailVerificationLink).toHaveBeenCalledTimes(1);

    resolveLink();
    await firstRequest;
    expect(first.statusCode).toBe(200);
  });

  it("keeps a throttled verification request recoverable after the cooldown", async () => {
    const throttled = Object.assign(new Error("An internal error has occurred."), {
      code: "auth/internal-error",
      httpResponse: {
        status: 400,
        data: { error: { message: "TOO_MANY_ATTEMPTS_TRY_LATER" } },
      },
    });
    const harness = handlerHarness({
      authAdmin: {
        generateEmailVerificationLink: vi
          .fn()
          .mockRejectedValueOnce(throttled)
          .mockResolvedValueOnce(
            "https://admin.njpbs.org/?mode=verifyEmail&oobCode=recovered",
          ),
      },
    });

    const first = responseRecorder();
    await harness.handlers.submit(
      request({ reason: "I edit program pages." }),
      first,
    );
    expect(first.statusCode).toBe(429);
    expect(first.body).toMatchObject({ code: "email_action_rate_limited" });
    expect(
      harness.rows.get(`${REQUESTS_COLLECTION}/requester-1`),
    ).toMatchObject({
      reason: "I edit program pages.",
      state: "email_verification",
      verificationEmailReservation: { state: "rate_limited" },
    });

    const immediateRetry = responseRecorder();
    await harness.handlers.submit(request({ reason: "" }), immediateRetry);
    expect(immediateRetry.statusCode).toBe(429);
    expect(harness.authAdmin.generateEmailVerificationLink).toHaveBeenCalledTimes(1);

    harness.setNow(new Date(NOW.getTime() + 16 * 60 * 1000));
    const recovered = responseRecorder();
    await harness.handlers.submit(request({ reason: "" }), recovered);

    expect(recovered.statusCode).toBe(200);
    expect(recovered.body).toMatchObject({
      request: { state: "email_verification", requestVersion: 1 },
      mailState: "sent",
    });
    expect(harness.authAdmin.generateEmailVerificationLink).toHaveBeenCalledTimes(2);
    expect(
      harness.rows.get("staffAccessEmailOutbox/requester-1--1--verify"),
    ).toMatchObject({
      state: "pending",
      verificationLink:
        "https://admin.njpbs.org/?mode=verifyEmail&oobCode=recovered",
    });
  });

  it("does not queue a verification email after the request advances", async () => {
    let resolveLink = () => {};
    const pendingLink = new Promise((resolve) => {
      resolveLink = () => resolve(
        "https://admin.njpbs.org/?mode=verifyEmail&oobCode=stale",
      );
    });
    const harness = handlerHarness({
      authAdmin: {
        generateEmailVerificationLink: vi.fn(() => pendingLink),
      },
    });
    const response = responseRecorder();
    const submission = harness.handlers.submit(
      request({ reason: "I edit program pages." }),
      response,
    );
    await vi.waitFor(() => {
      expect(harness.authAdmin.generateEmailVerificationLink).toHaveBeenCalled();
    });

    const requestPath = `${REQUESTS_COLLECTION}/requester-1`;
    harness.rows.set(requestPath, {
      ...harness.rows.get(requestPath),
      state: "pending",
      requestedAt: NOW,
    });
    resolveLink();
    await submission;

    expect(response).toMatchObject({
      statusCode: 409,
      body: { code: "request_changed" },
    });
    expect(
      harness.rows.has("staffAccessEmailOutbox/requester-1--1--verify"),
    ).toBe(false);
  });

  it("applies the password reset cooldown before another provider action", async () => {
    const throttled = Object.assign(new Error("TOO_MANY_ATTEMPTS_TRY_LATER"), {
      code: "auth/internal-error",
    });
    const harness = handlerHarness({
      authAdmin: {
        generatePasswordResetLink: vi
          .fn()
          .mockRejectedValueOnce(throttled)
          .mockResolvedValueOnce(
            "https://admin.njpbs.org/?mode=resetPassword&oobCode=recovered",
          ),
      },
    });

    const first = responseRecorder();
    await harness.handlers.passwordReset(
      request({ email: "person@example.org" }),
      first,
    );
    const immediateRetry = responseRecorder();
    await harness.handlers.passwordReset(
      request({ email: "person@example.org" }),
      immediateRetry,
    );

    expect(first).toMatchObject({ statusCode: 200, body: { success: true } });
    expect(immediateRetry).toMatchObject({
      statusCode: 200,
      body: { success: true },
    });
    expect(harness.authAdmin.getUserByEmail).toHaveBeenCalledTimes(1);
    expect(harness.authAdmin.generatePasswordResetLink).toHaveBeenCalledTimes(1);
    expect(
      [...harness.rows.keys()].some((key) =>
        key.startsWith(`${PASSWORD_RESETS_COLLECTION}/`),
      ),
    ).toBe(true);
    expect(
      [...harness.rows.keys()].some((key) =>
        key.startsWith("staffAccessEmailOutbox/"),
      ),
    ).toBe(false);

    harness.setNow(new Date(NOW.getTime() + 16 * 60 * 1000));
    const recovered = responseRecorder();
    await harness.handlers.passwordReset(
      request({ email: "person@example.org" }),
      recovered,
    );

    expect(recovered).toMatchObject({ statusCode: 200, body: { success: true } });
    expect(harness.authAdmin.generatePasswordResetLink).toHaveBeenCalledTimes(2);
    expect(
      [...harness.rows.values()].some(
        (row) => row.eventType === "password_reset",
      ),
    ).toBe(true);
  });
});

// Only the Admin SDK is fake, so the real verifier's typed refusal reaches this serializer.
describe("staff access token refusal", () => {
  afterEach(() => { vi.restoreAllMocks(); authPkg.resetAuthTokenCache(); });

  it.each([
    ["auth/id-token-expired", { code: "session_expired", reason: "token_expired" }],
    ["auth/id-token-revoked", { code: "session_expired" }],
  ])("keeps only the trusted refusal fields for %s", async (code, expected) => {
    vi.spyOn(firebasePkg.admin.auth(), "verifyIdToken").mockRejectedValue(
      Object.assign(new Error("Synthetic refusal"), { code }),
    );
    const { firestore, authAdmin } = handlerHarness();
    const handlers = createStaffAccessHandlers({ firestore, authAdmin });
    const response = responseRecorder();

    await handlers.submit(request({ reason: "" }), response);

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({ error: "Invalid or expired authentication token", ...expected });
  });
});
