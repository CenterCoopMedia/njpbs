"use strict";

const { userDocUsesAccessTier } = require("./lib/access-tier-activation");
const { administrativeRoleFromStoredUserDoc, administrativeRoleFromUserDoc } = require("./lib/principal");

// Staff account registration and approval. Firebase Auth proves ownership of
// the address. A request remains permissionless until the only super admin
// approves one site-wide staff, editor, or contributor grant.

const { createHash, randomUUID } = require("node:crypto");
const { cmsOnRequest } = require("./lib/cms-edge");
const { admin, db } = require("./lib/firebase");
const {
  ForbiddenError,
  sessionPredatesWatermark,
  verifyAppCheckToken,
  verifyAuthToken,
} = require("./lib/auth");
const { sessionRefusalFields } = require("./lib/session-refusal");
const {
  OUTBOX_COLLECTION,
  STAFF_EMAIL_API_TOKEN,
  deliverStaffAccessEmail,
  outboxId,
  queueStaffAccessEmail,
} = require("./staff-access-email");
const {
  queueStaffAccessNotification,
} = require("./lib/staff-access-notification");

const REQUESTS_COLLECTION = "staffAccessRequests";
const REQUEST_COUNTERS_COLLECTION = "staffAccessRequestCounters";
const NOTIFICATION_COOLDOWNS_COLLECTION = "staffAccessNotificationCooldowns";
const PASSWORD_RESETS_COLLECTION = "staffPasswordResetRequests";
const PENDING_DAYS = 30;
const TERMINAL_DAYS = 90;
const PASSWORD_RESET_COOLDOWN_MINUTES = 15;
const PASSWORD_RESET_RETENTION_DAYS = 1;
const VERIFICATION_EMAIL_COOLDOWN_MINUTES = 15;
const VERIFICATION_EMAIL_LEASE_MINUTES = 2;
const NOTIFICATION_COOLDOWN_HOURS = 24;
const NOTIFICATION_COOLDOWN_RETENTION_DAYS = 2;
const MIN_REASON_LENGTH = 5;
const MAX_REASON_LENGTH = 500;
const ALLOWED_APPROVAL_ROLES = new Set(["staff", "editor", "contributor"]);
const ALLOWED_STATES = new Set([
  "email_verification",
  "pending",
  "denied",
  "expired",
  "ready",
]);

class StaffAccessError extends Error {
  constructor(status, message, code, { expose = status < 500 } = {}) {
    super(message);
    this.name = "StaffAccessError";
    this.status = status;
    this.code = code;
    this.expose = expose;
  }
}

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeDisplayName(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized ? normalized.slice(0, 120) : null;
}

function validateReason(value) {
  if (typeof value !== "string") {
    throw new StaffAccessError(400, "Tell an administrator why you need access", "reason_required");
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (
    normalized.length < MIN_REASON_LENGTH ||
    normalized.length > MAX_REASON_LENGTH
  ) {
    throw new StaffAccessError(
      400,
      `The access reason must be ${MIN_REASON_LENGTH} to ${MAX_REASON_LENGTH} characters`,
      "reason_invalid",
    );
  }
  return normalized;
}

function assertExactKeys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StaffAccessError(400, "A JSON object is required", "body_invalid");
  }
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new StaffAccessError(
      400,
      "The request contains fields that are not allowed",
      "forged_fields",
    );
  }
}

function requestReference(uid, version) {
  const compactUid = String(uid).replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
  return `NJPBS-${compactUid.toUpperCase()}-${version}`;
}

function dateFrom(value) {
  if (typeof value?.toDate === "function") return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function plusDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function plusMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function firebaseActionErrorDetails(error) {
  const providerCode =
    typeof error?.code === "string" ? error.code.slice(0, 100) : "unknown";
  const providerMessage = [
    error?.errorInfo?.message,
    error?.message,
    error?.httpResponse?.data?.error?.message,
  ]
    .filter((value) => typeof value === "string")
    .join(" ");
  const rateLimited =
    providerCode === "auth/too-many-requests" ||
    /TOO_MANY_ATTEMPTS_TRY_LATER|TOO_MANY_REQUESTS/i.test(providerMessage);
  return {
    kind: rateLimited ? "rate_limited" : "unavailable",
    providerCode,
  };
}

function verificationActionError(kind) {
  if (kind === "rate_limited") {
    return new StaffAccessError(
      429,
      "Email verification is temporarily limited. Check your first email, wait 15 minutes, then try again.",
      "email_action_rate_limited",
    );
  }
  return new StaffAccessError(
    503,
    "The verification link could not be created. Try again later or email njpbs@montclair.edu.",
    "email_action_unavailable",
    { expose: true },
  );
}

function activeVerificationReservation(row, now) {
  const reservation = row?.verificationEmailReservation;
  if (!reservation || typeof reservation !== "object") return null;
  if (
    reservation.state === "preparing" &&
    (dateFrom(reservation.leaseUntil)?.getTime() ?? 0) > now.getTime()
  ) {
    return "preparing";
  }
  if (
    reservation.state === "rate_limited" &&
    (dateFrom(reservation.retryAfter)?.getTime() ?? 0) > now.getTime()
  ) {
    return "rate_limited";
  }
  return null;
}

function reusableVerificationMailState(row, now) {
  if (!row || typeof row !== "object") return null;
  if (row.state === "unknown") return "unknown";
  if (row.state === "pending" || row.state === "sending") return "pending";
  if (row.state !== "sent") return null;
  const sentAt = dateFrom(row.sentAt ?? row.createdAt);
  if (
    sentAt &&
    sentAt.getTime() + VERIFICATION_EMAIL_COOLDOWN_MINUTES * 60 * 1000 >
      now.getTime()
  ) {
    return "suppressed";
  }
  return null;
}

function isStalePending(row, now) {
  if (row?.state !== "pending") return false;
  const requestedAt = dateFrom(row.requestedAt ?? row.createdAt);
  return Boolean(
    requestedAt &&
    requestedAt.getTime() + PENDING_DAYS * 24 * 60 * 60 * 1000 <= now.getTime(),
  );
}

function isStaleVerification(row, now) {
  if (row?.state !== "email_verification") return false;
  const createdAt = dateFrom(row.versionCreatedAt ?? row.createdAt);
  return Boolean(
    createdAt &&
    createdAt.getTime() + PENDING_DAYS * 24 * 60 * 60 * 1000 <= now.getTime(),
  );
}

function isStaleRequest(row, now) {
  return isStalePending(row, now) || isStaleVerification(row, now);
}

function passwordResetKey(email) {
  return createHash("sha256").update(normalizeEmail(email)).digest("hex");
}

function notificationCooldownKey(email) {
  return createHash("sha256").update(normalizeEmail(email)).digest("hex");
}

function queueNotificationIfAllowed(
  transaction,
  firestore,
  cooldownRef,
  cooldown,
  request,
  now,
  queueNotificationFn,
) {
  const lastNotifiedAt = dateFrom(cooldown?.lastNotifiedAt);
  if (
    lastNotifiedAt &&
    lastNotifiedAt.getTime() + NOTIFICATION_COOLDOWN_HOURS * 60 * 60 * 1000 >
      now.getTime()
  ) {
    return false;
  }
  queueNotificationFn(transaction, firestore, request, now);
  transaction.set(cooldownRef, {
    lastNotifiedAt: now,
    updatedAt: now,
    expireAt: plusDays(now, NOTIFICATION_COOLDOWN_RETENTION_DAYS),
  });
  return true;
}

function safeRequest(row, caller = null) {
  if (!row) {
    return {
      state: "not_requested",
      requestVersion: null,
      reference: null,
      role: null,
      requestedAt: null,
      decidedAt: null,
      emailVerified: caller?.emailVerified === true,
    };
  }
  const state = ALLOWED_STATES.has(row.state) ? row.state : "not_requested";
  return {
    state,
    requestVersion:
      Number.isInteger(row.requestVersion) && row.requestVersion > 0
        ? row.requestVersion
        : null,
    reference:
      typeof row.reference === "string" ? row.reference : null,
    role: ALLOWED_APPROVAL_ROLES.has(row.approvedRole)
      ? row.approvedRole
      : null,
    requestedAt: dateFrom(row.requestedAt)?.toISOString() ?? null,
    decidedAt: dateFrom(row.decidedAt)?.toISOString() ?? null,
    emailVerified: caller?.emailVerified === true,
  };
}

function appCheckHeader(req) {
  const value = req.headers?.["x-firebase-appcheck"];
  return Array.isArray(value) ? value[0] : value;
}

function requirePost(req) {
  if (req.method !== "POST") {
    throw new StaffAccessError(405, "Method not allowed", "method_not_allowed");
  }
}

function sendHandlerError(res, error, log = console) {
  const status =
    Number.isInteger(error?.status) && error.status >= 400
      ? error.status
      : 500;
  if (status >= 500) log.error("staff access request failed", error);
  const expose = status < 500 || error?.expose === true;
  res.status(status).json({
    error: expose ? error.message : "The access request service is unavailable",
    ...(expose && typeof error?.code === "string"
      ? { code: error.code }
      : {}),
    ...sessionRefusalFields(error),
  });
}

async function authenticateRequest(req, deps) {
  const caller = await deps.verifyAuthTokenFn(req.headers.authorization);
  await deps.verifyAppCheckTokenFn(appCheckHeader(req));
  const email = normalizeEmail(caller.email);
  if (!email) {
    throw new ForbiddenError("A valid email address is required");
  }
  return { ...caller, email };
}

async function maybeDeliver(id, deps) {
  if (!id) return "not_queued";
  try {
    const result = await deps.deliverEmailFn(id, {
      firestore: deps.firestore,
    });
    return result?.state ?? "pending";
  } catch (error) {
    deps.log.error("staff access email delivery failed", {
      outboxId: id,
      error,
    });
    return "pending";
  }
}

function createStaffAccessHandlers(overrides = {}) {
  const deps = {
    firestore: overrides.firestore ?? db,
    authAdmin: overrides.authAdmin ?? admin.auth(),
    verifyAuthTokenFn: overrides.verifyAuthTokenFn ?? verifyAuthToken,
    verifyAppCheckTokenFn:
      overrides.verifyAppCheckTokenFn ?? verifyAppCheckToken,
    deliverEmailFn: overrides.deliverEmailFn ?? deliverStaffAccessEmail,
    queueNotificationFn:
      overrides.queueNotificationFn ?? queueStaffAccessNotification,
    now: overrides.now ?? (() => new Date()),
    randomUUID: overrides.randomUUID ?? randomUUID,
    adminOrigin:
      overrides.adminOrigin ??
      process.env.CMS_STAFF_EMAIL_ADMIN_ORIGIN?.trim() ??
      "https://admin.njpbs.org",
    log: overrides.log ?? console,
  };

  async function advanceVerifiedRequest(caller) {
    if (!caller.emailVerified) return null;
    const now = deps.now();
    const ref = deps.firestore.collection(REQUESTS_COLLECTION).doc(caller.uid);
    const cooldownRef = deps.firestore
      .collection(NOTIFICATION_COOLDOWNS_COLLECTION)
      .doc(notificationCooldownKey(caller.email));
    let emailId = null;
    await deps.firestore.runTransaction(async (transaction) => {
      const [snapshot, cooldownSnapshot] = await Promise.all([
        transaction.get(ref),
        transaction.get(cooldownRef),
      ]);
      if (!snapshot.exists) return;
      const row = snapshot.data();
      if (normalizeEmail(row.email) !== caller.email) {
        throw new ForbiddenError("The request email does not match this account");
      }
      if (row.state !== "email_verification") return;
      if (isStaleVerification(row, now)) {
        transaction.update(ref, {
          state: "expired",
          expiredAt: now,
          updatedAt: now,
          expireAt: plusDays(now, TERMINAL_DAYS),
        });
        return;
      }
      transaction.update(ref, {
        state: "pending",
        emailVerifiedAt: now,
        requestedAt: now,
        expireAt: null,
        updatedAt: now,
      });
      emailId = queueStaffAccessEmail(
        transaction,
        deps.firestore,
        {
          uid: caller.uid,
          requestVersion: row.requestVersion,
          eventType: "received",
          to: caller.email,
          displayName: row.displayName,
          reference: row.reference,
        },
        now,
      );
      queueNotificationIfAllowed(
        transaction,
        deps.firestore,
        cooldownRef,
        cooldownSnapshot.exists ? cooldownSnapshot.data() : null,
        {
          uid: caller.uid,
          requestVersion: row.requestVersion,
          email: caller.email,
          displayName: row.displayName,
          reason: row.reason,
          reference: row.reference,
          requestedAt: now,
        },
        now,
        deps.queueNotificationFn,
      );
    });
    return emailId;
  }

  async function expireIfNeeded(caller, row) {
    const now = deps.now();
    if (!isStaleRequest(row, now)) return row;
    const ref = deps.firestore.collection(REQUESTS_COLLECTION).doc(caller.uid);
    return deps.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return null;
      const current = snapshot.data();
      if (!isStaleRequest(current, now)) return current;
      const expired = {
        ...current,
        state: "expired",
        expiredAt: now,
        updatedAt: now,
        expireAt: plusDays(now, TERMINAL_DAYS),
      };
      transaction.update(ref, {
        state: expired.state,
        expiredAt: expired.expiredAt,
        updatedAt: expired.updatedAt,
        expireAt: expired.expireAt,
      });
      return expired;
    });
  }

  async function reserveAccessRequest(caller, rawReason, now) {
    const ref = deps.firestore.collection(REQUESTS_COLLECTION).doc(caller.uid);
    const counterRef = deps.firestore
      .collection(REQUEST_COUNTERS_COLLECTION)
      .doc(caller.uid);
    const cooldownRef = deps.firestore
      .collection(NOTIFICATION_COOLDOWNS_COLLECTION)
      .doc(notificationCooldownKey(caller.email));
    const reservationId = deps.randomUUID();

    return deps.firestore.runTransaction(async (transaction) => {
      const [snapshot, counterSnapshot, cooldownSnapshot] = await Promise.all([
        transaction.get(ref),
        transaction.get(counterRef),
        transaction.get(cooldownRef),
      ]);
      const existing = snapshot.exists ? snapshot.data() : null;
      const counter = counterSnapshot.exists ? counterSnapshot.data() : null;
      if (existing && normalizeEmail(existing.email) !== caller.email) {
        throw new ForbiddenError("The request email does not match this account");
      }
      if (existing?.state === "ready" || existing?.state === "pending") {
        return { row: existing, emailId: null, mailState: "not_queued" };
      }

      const canResubmit =
        existing?.state === "denied" ||
        existing?.state === "expired" ||
        isStaleVerification(existing, now);
      const startsNewVersion = !existing || canResubmit;
      const lastVersion = Math.max(
        Number.isInteger(counter?.lastVersion) ? counter.lastVersion : 0,
        Number.isInteger(existing?.requestVersion) ? existing.requestVersion : 0,
      );
      const version = startsNewVersion
        ? lastVersion + 1
        : existing.requestVersion;
      const state = caller.emailVerified ? "pending" : "email_verification";
      const reference = requestReference(caller.uid, version);
      const storedReason =
        !startsNewVersion && existing?.state === "email_verification"
          ? existing.reason
          : null;
      const reason = validateReason(
        typeof storedReason === "string" ? storedReason : rawReason,
      );
      const versionCreatedAt = startsNewVersion
        ? now
        : dateFrom(existing.versionCreatedAt) ?? now;
      const existingExpireAt = startsNewVersion
        ? null
        : dateFrom(existing?.expireAt);
      const row = {
        uid: caller.uid,
        email: caller.email,
        displayName: normalizeDisplayName(caller.displayName),
        provider: caller.provider ?? null,
        reason,
        state,
        requestVersion: version,
        reference,
        approvedRole: null,
        decision: null,
        createdAt: existing?.createdAt ?? now,
        versionCreatedAt,
        requestedAt: caller.emailVerified ? now : null,
        emailVerifiedAt: caller.emailVerified ? now : null,
        decidedAt: null,
        expireAt:
          state === "email_verification"
            ? existingExpireAt ?? plusDays(versionCreatedAt, PENDING_DAYS)
            : null,
        updatedAt: now,
      };

      const continuingVerification =
        !caller.emailVerified &&
        !startsNewVersion &&
        existing?.state === "email_verification";
      if (continuingVerification) {
        const verifyOutboxRef = deps.firestore
          .collection(OUTBOX_COLLECTION)
          .doc(outboxId(caller.uid, version, "verify"));
        const outboxSnapshot = await transaction.get(verifyOutboxRef);
        const reusableMailState = reusableVerificationMailState(
          outboxSnapshot.exists ? outboxSnapshot.data() : null,
          now,
        );
        if (reusableMailState) {
          return {
            row: existing,
            emailId: null,
            mailState: reusableMailState,
          };
        }
        const reservationState = activeVerificationReservation(existing, now);
        if (reservationState) {
          return {
            row: existing,
            emailId: null,
            mailState: reservationState,
          };
        }
      }

      if (!caller.emailVerified) {
        row.verificationEmailReservation = {
          id: reservationId,
          state: "preparing",
          requestedAt: now,
          leaseUntil: plusMinutes(now, VERIFICATION_EMAIL_LEASE_MINUTES),
          retryAfter: null,
        };
      }

      transaction.set(
        counterRef,
        {
          lastVersion: Math.max(lastVersion, version),
          updatedAt: now,
        },
        { merge: true },
      );
      transaction.set(ref, row);

      let emailId = null;
      if (state === "pending") {
        emailId = queueStaffAccessEmail(
          transaction,
          deps.firestore,
          {
            uid: caller.uid,
            requestVersion: version,
            eventType: "received",
            to: caller.email,
            displayName: row.displayName,
            reference,
          },
          now,
        );
        queueNotificationIfAllowed(
          transaction,
          deps.firestore,
          cooldownRef,
          cooldownSnapshot.exists ? cooldownSnapshot.data() : null,
          {
            uid: caller.uid,
            requestVersion: version,
            email: caller.email,
            displayName: row.displayName,
            reason: row.reason,
            reference,
            requestedAt: now,
          },
          now,
          deps.queueNotificationFn,
        );
      }

      return {
        row,
        emailId,
        mailState: "not_queued",
        reservationId: caller.emailVerified ? null : reservationId,
      };
    });
  }

  async function recordVerificationFailure(ref, reservationId, details) {
    const failedAt = deps.now();
    try {
      await deps.firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) return;
        const current = snapshot.data();
        if (current?.verificationEmailReservation?.id !== reservationId) return;
        transaction.update(ref, {
          verificationEmailReservation: {
            id: reservationId,
            state:
              details.kind === "rate_limited" ? "rate_limited" : "failed",
            requestedAt:
              dateFrom(current.verificationEmailReservation.requestedAt) ??
              failedAt,
            leaseUntil: null,
            retryAfter:
              details.kind === "rate_limited"
                ? plusMinutes(failedAt, VERIFICATION_EMAIL_COOLDOWN_MINUTES)
                : null,
          },
          updatedAt: failedAt,
        });
      });
    } catch {
      // The short preparation lease expires by itself, so a failed status write
      // cannot strand the account.
    }
  }

  async function queueReservedVerification(
    caller,
    reservationId,
    requestVersion,
    link,
    now,
  ) {
    const ref = deps.firestore.collection(REQUESTS_COLLECTION).doc(caller.uid);
    return deps.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const current = snapshot.exists ? snapshot.data() : null;
      if (
        current?.verificationEmailReservation?.id !== reservationId ||
        current?.requestVersion !== requestVersion ||
        current?.state !== "email_verification"
      ) {
        throw new StaffAccessError(
          409,
          "The verification request changed. Try again.",
          "request_changed",
        );
      }
      const emailId = queueStaffAccessEmail(
        transaction,
        deps.firestore,
        {
          uid: caller.uid,
          requestVersion: current.requestVersion,
          eventType: "verify",
          to: caller.email,
          displayName: current.displayName,
          verificationLink: link,
          reference: current.reference,
        },
        now,
      );
      transaction.update(ref, {
        verificationEmailReservation: {
          id: reservationId,
          state: "queued",
          requestedAt: now,
          leaseUntil: null,
          retryAfter: plusMinutes(now, VERIFICATION_EMAIL_COOLDOWN_MINUTES),
        },
        updatedAt: now,
      });
      return { row: current, emailId };
    });
  }

  async function submit(req, res) {
    try {
      requirePost(req);
      assertExactKeys(req.body ?? {}, new Set(["reason"]));
      const caller = await authenticateRequest(req, deps);
      const now = deps.now();
      const reserved = await reserveAccessRequest(caller, req.body.reason, now);
      if (reserved.mailState === "rate_limited") {
        throw verificationActionError("rate_limited");
      }

      let responseRow = reserved.row;
      let emailId = reserved.emailId;
      let mailState = reserved.mailState;
      if (reserved.reservationId) {
        let verificationLink;
        try {
          verificationLink = await deps.authAdmin.generateEmailVerificationLink(
            caller.email,
            {
              url: `${deps.adminOrigin.replace(/\/$/, "")}/?accountAction=verified`,
              handleCodeInApp: true,
            },
          );
        } catch (error) {
          const details = firebaseActionErrorDetails(error);
          deps.log.warn?.("staff email action link failed", {
            operation: "verification",
            kind: details.kind,
            providerCode: details.providerCode,
          });
          await recordVerificationFailure(
            deps.firestore.collection(REQUESTS_COLLECTION).doc(caller.uid),
            reserved.reservationId,
            details,
          );
          throw verificationActionError(details.kind);
        }

        const queued = await queueReservedVerification(
          caller,
          reserved.reservationId,
          reserved.row.requestVersion,
          verificationLink,
          now,
        );
        responseRow = queued.row;
        emailId = queued.emailId;
      }

      if (emailId) mailState = await maybeDeliver(emailId, deps);
      res.status(200).json({
        success: true,
        request: safeRequest(responseRow, caller),
        mailState,
      });
    } catch (error) {
      sendHandlerError(res, error, deps.log);
    }
  }

  async function passwordReset(req, res) {
    try {
      requirePost(req);
      assertExactKeys(req.body ?? {}, new Set(["email"]));
      await deps.verifyAppCheckTokenFn(appCheckHeader(req));
      const email = normalizeEmail(req.body.email);
      if (
        email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      ) {
        throw new StaffAccessError(
          400,
          "Enter a valid email address",
          "email_invalid",
        );
      }

      const now = deps.now();
      const resetRef = deps.firestore
        .collection(PASSWORD_RESETS_COLLECTION)
        .doc(passwordResetKey(email));
      const reserved = await deps.firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(resetRef);
        const current = snapshot.exists ? snapshot.data() : null;
        const lastRequestedAt = dateFrom(current?.lastRequestedAt);
        const cooldownMillis = PASSWORD_RESET_COOLDOWN_MINUTES * 60 * 1000;
        if (
          lastRequestedAt &&
          lastRequestedAt.getTime() + cooldownMillis > now.getTime()
        ) {
          return false;
        }
        transaction.set(
          resetRef,
          {
            lastRequestedAt: now,
            updatedAt: now,
            expireAt: plusDays(now, PASSWORD_RESET_RETENTION_DAYS),
          },
          { merge: true },
        );
        return true;
      });

      if (reserved) {
        let authUser = null;
        let passwordResetLink = null;
        try {
          authUser = await deps.authAdmin.getUserByEmail(email);
          if (authUser.disabled !== true) {
            passwordResetLink = await deps.authAdmin.generatePasswordResetLink(
              email,
              { url: deps.adminOrigin.replace(/\/$/, "") },
            );
          }
        } catch (error) {
          if (error?.code !== "auth/user-not-found") {
            const details = firebaseActionErrorDetails(error);
            deps.log.warn?.("staff email action link failed", {
              operation: "password_reset",
              kind: details.kind,
              providerCode: details.providerCode,
            });
          }
          authUser = null;
          passwordResetLink = null;
        }

        if (authUser && passwordResetLink) {
          try {
            let emailId = null;
            await deps.firestore.runTransaction(async (transaction) => {
              emailId = queueStaffAccessEmail(
                transaction,
                deps.firestore,
                {
                  uid: authUser.uid,
                  deliveryId: `reset-${now.getTime()}-${deps.randomUUID()}`,
                  eventType: "password_reset",
                  to: email,
                  displayName: authUser.displayName,
                  passwordResetLink,
                },
                now,
              );
            });
            await maybeDeliver(emailId, deps);
          } catch {
            deps.log.error("staff password reset email could not be queued");
          }
        }
      }

      // Never reveal whether the address exists, is disabled, or is cooling down.
      res.status(200).json({ success: true });
    } catch (error) {
      sendHandlerError(res, error, deps.log);
    }
  }

  async function status(req, res) {
    try {
      requirePost(req);
      assertExactKeys(req.body ?? {}, new Set());
      const caller = await authenticateRequest(req, deps);
      const receiptId = await advanceVerifiedRequest(caller);
      const ref = deps.firestore.collection(REQUESTS_COLLECTION).doc(caller.uid);
      const snapshot = await ref.get();
      let row = snapshot.exists ? snapshot.data() : null;
      if (row && normalizeEmail(row.email) !== caller.email) {
        throw new ForbiddenError("The request email does not match this account");
      }
      row = await expireIfNeeded(caller, row);
      const mailState = await maybeDeliver(receiptId, deps);
      res.status(200).json({
        success: true,
        request: safeRequest(row, caller),
        mailState,
      });
    } catch (error) {
      sendHandlerError(res, error, deps.log);
    }
  }

  async function requireSuperAdmin(req) {
    const caller = await authenticateRequest(req, deps);
    const snapshot = await deps.firestore.collection("users").doc(caller.uid).get();
    const profile = snapshot.exists ? snapshot.data() : null;
    const tiersActive = await userDocUsesAccessTier(deps.firestore, profile);
    if (administrativeRoleFromUserDoc(profile, tiersActive) !== "super_admin" ||
        (tiersActive && caller.emailVerified !== true) ||
        sessionPredatesWatermark(caller.authTime, profile)) {
      throw new ForbiddenError("Super admin access required");
    }
    return caller;
  }

  async function list(req, res) {
    try {
      requirePost(req);
      assertExactKeys(req.body ?? {}, new Set());
      await requireSuperAdmin(req);
      const now = deps.now();
      const snapshot = await deps.firestore
        .collection(REQUESTS_COLLECTION)
        .where("state", "==", "pending")
        .limit(100)
        .get();
      const staleDocuments = snapshot.docs.filter((doc) =>
        isStalePending(doc.data(), now),
      );
      await Promise.all(
        staleDocuments.map((doc) =>
          deps.firestore.runTransaction(async (transaction) => {
            const currentSnapshot = await transaction.get(doc.ref);
            if (!currentSnapshot.exists) return;
            const current = currentSnapshot.data();
            if (!isStalePending(current, now)) return;
            transaction.update(doc.ref, {
              state: "expired",
              expiredAt: now,
              updatedAt: now,
              expireAt: plusDays(now, TERMINAL_DAYS),
            });
          }),
        ),
      );
      const requests = snapshot.docs
        .map((doc) => ({ uid: doc.id, ...doc.data() }))
        .filter((row) => !isStalePending(row, now))
        .sort((left, right) => {
          const leftTime = dateFrom(left.requestedAt)?.getTime() ?? 0;
          const rightTime = dateFrom(right.requestedAt)?.getTime() ?? 0;
          return leftTime - rightTime;
        })
        .map((row) => ({
          uid: row.uid,
          email: normalizeEmail(row.email),
          displayName: normalizeDisplayName(row.displayName),
          reason: typeof row.reason === "string" ? row.reason : "",
          requestVersion: row.requestVersion,
          reference: row.reference,
          requestedAt: dateFrom(row.requestedAt)?.toISOString() ?? null,
          state: "pending",
        }));
      res.status(200).json({ success: true, requests });
    } catch (error) {
      sendHandlerError(res, error, deps.log);
    }
  }

  async function decide(req, res) {
    try {
      requirePost(req);
      assertExactKeys(
        req.body ?? {},
        new Set(["targetUid", "requestVersion", "decision", "role"]),
      );
      const caller = await requireSuperAdmin(req);
      const targetUid =
        typeof req.body.targetUid === "string" ? req.body.targetUid.trim() : "";
      const requestVersion = req.body.requestVersion;
      const decision = req.body.decision;
      const role = req.body.role;
      if (!targetUid || !Number.isInteger(requestVersion) || requestVersion < 1) {
        throw new StaffAccessError(400, "A current request is required", "request_invalid");
      }
      if (targetUid === caller.uid) {
        throw new ForbiddenError("You cannot decide your own access request");
      }
      if (decision !== "approve" && decision !== "deny") {
        throw new StaffAccessError(400, "Choose approve or reject", "decision_invalid");
      }
      if (
        (decision === "approve" && !ALLOWED_APPROVAL_ROLES.has(role)) ||
        (decision === "deny" && role !== undefined)
      ) {
        throw new StaffAccessError(
          400,
          "Approval allows only staff, editor, or contributor access",
          "role_invalid",
        );
      }

      let authUser = null;
      if (decision === "approve") {
        try {
          authUser = await deps.authAdmin.getUser(targetUid);
        } catch {
          throw new StaffAccessError(409, "The Firebase account is not available", "identity_missing");
        }
      }

      const now = deps.now();
      const requestRef = deps.firestore.collection(REQUESTS_COLLECTION).doc(targetUid);
      const callerRef = deps.firestore.collection("users").doc(caller.uid);
      const targetRef = deps.firestore.collection("users").doc(targetUid);
      const auditRef = deps.firestore
        .collection("admin_logs")
        .doc(`staff-access--${targetUid}--${requestVersion}--${decision}`);
      let responseRow = null;
      let emailId = null;
      await deps.firestore.runTransaction(async (transaction) => {
        const [requestSnapshot, callerSnapshot, targetSnapshot, auditSnapshot] =
          await Promise.all([
            transaction.get(requestRef),
            transaction.get(callerRef),
            transaction.get(targetRef),
            transaction.get(auditRef),
          ]);
        if (auditSnapshot.exists) {
          throw new StaffAccessError(409, "This request was already decided", "already_decided");
        }
        const liveCaller = callerSnapshot.exists ? callerSnapshot.data() : null;
        if (await administrativeRoleFromStoredUserDoc(deps.firestore, liveCaller, transaction) !== "super_admin") {
          throw new ForbiddenError("Super admin access required");
        }
        if (!requestSnapshot.exists) {
          throw new StaffAccessError(404, "Access request not found", "request_missing");
        }
        const row = requestSnapshot.data();
        if (
          row.state !== "pending" ||
          row.requestVersion !== requestVersion ||
          isStalePending(row, now)
        ) {
          throw new StaffAccessError(409, "The access request changed", "stale_request");
        }

        const target = targetSnapshot.exists ? targetSnapshot.data() : null;
        if (decision === "approve") {
          const authEmail = normalizeEmail(authUser?.email);
          if (
            authUser?.disabled === true ||
            authUser?.emailVerified !== true ||
            !authEmail ||
            authEmail !== normalizeEmail(row.email)
          ) {
            throw new StaffAccessError(
              409,
              "The verified Firebase identity does not match the request",
              "identity_mismatch",
            );
          }
          const hasRole = target?.role !== null && target?.role !== undefined;
          const hasGrants = Array.isArray(target?.grants)
            ? target.grants.length > 0
            : target?.grants !== null && target?.grants !== undefined;
          if (
            target?.active === false ||
            hasRole ||
            hasGrants ||
            await userDocUsesAccessTier(deps.firestore, target, transaction)
          ) {
            throw new StaffAccessError(
              409,
              "The staff account permissions changed",
              "permissions_changed",
            );
          }
          transaction.set(
            targetRef,
            {
              email: authEmail,
              displayName:
                normalizeDisplayName(authUser.displayName) ??
                normalizeDisplayName(row.displayName),
              active: true,
              tokensValidAfter: target?.tokensValidAfter ?? 0,
              role: null,
              grants: [{ role }],
              createdAt: target?.createdAt ?? now,
              updatedAt: now,
            },
            { merge: true },
          );
        }

        const nextState = decision === "approve" ? "ready" : "denied";
        const update = {
          state: nextState,
          approvedRole: decision === "approve" ? role : null,
          decision: {
            outcome: decision,
            actorUid: caller.uid,
            actorEmail: caller.email,
          },
          decidedAt: now,
          updatedAt: now,
          expireAt: plusDays(now, TERMINAL_DAYS),
        };
        transaction.update(requestRef, update);
        transaction.set(auditRef, {
          actorUid: caller.uid,
          actorEmail: caller.email,
          action: `staff_access.${decision}`,
          target: targetUid,
          before: {
            state: row.state,
            requestVersion,
          },
          after: {
            state: nextState,
            role: decision === "approve" ? role : null,
          },
          at: now,
          source: req.headers?.["x-njpbs-client-ip"] ?? null,
        });
        responseRow = { ...row, ...update };
        emailId = queueStaffAccessEmail(
          transaction,
          deps.firestore,
          {
            uid: targetUid,
            requestVersion,
            eventType: decision === "approve" ? "approved" : "denied",
            to: row.email,
            displayName: row.displayName,
            role: decision === "approve" ? role : null,
            reference: row.reference,
          },
          now,
        );
      });

      const mailState = await maybeDeliver(emailId, deps);
      res.status(200).json({
        success: true,
        request: safeRequest(responseRow),
        mailState,
      });
    } catch (error) {
      sendHandlerError(res, error, deps.log);
    }
  }

  return { submit, passwordReset, status, list, decide };
}

const handlers = createStaffAccessHandlers();
const emailOptions = { cors: true, secrets: [STAFF_EMAIL_API_TOKEN] };

const submitStaffAccessRequest = cmsOnRequest(emailOptions, handlers.submit);
const requestStaffPasswordReset = cmsOnRequest(
  emailOptions,
  handlers.passwordReset,
);
const getStaffAccessStatus = cmsOnRequest(emailOptions, handlers.status);
const listStaffAccessRequests = cmsOnRequest(
  { cors: true },
  handlers.list,
);
const decideStaffAccessRequest = cmsOnRequest(emailOptions, handlers.decide);

module.exports = {
  ALLOWED_APPROVAL_ROLES,
  MAX_REASON_LENGTH,
  MIN_REASON_LENGTH,
  NOTIFICATION_COOLDOWNS_COLLECTION,
  NOTIFICATION_COOLDOWN_HOURS,
  NOTIFICATION_COOLDOWN_RETENTION_DAYS,
  PASSWORD_RESETS_COLLECTION,
  PASSWORD_RESET_COOLDOWN_MINUTES,
  PENDING_DAYS,
  REQUEST_COUNTERS_COLLECTION,
  REQUESTS_COLLECTION,
  StaffAccessError,
  TERMINAL_DAYS,
  createStaffAccessHandlers,
  decideStaffAccessRequest,
  getStaffAccessStatus,
  isStaleRequest,
  isStalePending,
  isStaleVerification,
  listStaffAccessRequests,
  requestReference,
  requestStaffPasswordReset,
  safeRequest,
  submitStaffAccessRequest,
  validateReason,
};
