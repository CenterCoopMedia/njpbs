"use strict";

// CommonJS mirror of site/src/lib/mvault-entitlement.ts. Keep policy changes in
// the TypeScript source and this deployable module together; the Functions
// parity test runs both implementations against the same fixtures.

function isOn(status) {
  return typeof status === "string" && status.trim().toLowerCase() === "on";
}

function hasOffer(offer) {
  return typeof offer === "string" && offer.trim().length > 0;
}

function validDate(s) {
  if (typeof s !== "string") return null;
  const trimmed = s.trim();
  const m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const t = Date.parse(trimmed);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() + 1 !== month ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return trimmed;
}

function easternDate(now) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function evaluateEntitlement(m, now) {
  if (!Number.isFinite(now)) return { entitled: false, state: "malformed" };

  if (m.provisional === true) return { entitled: false, state: "inactive" };
  if (!isOn(m.status) || !hasOffer(m.offer)) {
    return { entitled: false, state: "inactive" };
  }

  switch (m.timing) {
    case "within_start_expire_dates":
      return { entitled: true, state: "active" };
    case "within_grace_period":
      return { entitled: true, state: "grace" };
    case "expired":
      return { entitled: false, state: "expired" };
    case "before_start":
      return { entitled: false, state: "inactive" };
  }

  const expire = validDate(m.expireDate);
  if (expire === null) return { entitled: false, state: "malformed" };
  const todayET = easternDate(now);

  if (m.startDate !== undefined) {
    const start = validDate(m.startDate);
    if (start === null) return { entitled: false, state: "malformed" };
    if (todayET < start) return { entitled: false, state: "inactive" };
  }

  if (todayET <= expire) return { entitled: true, state: "active" };
  const grace = validDate(m.graceThrough);
  if (grace !== null && todayET <= grace) {
    return { entitled: true, state: "grace" };
  }
  return { entitled: false, state: "expired" };
}

function normEmail(email) {
  if (typeof email !== "string") return null;
  const t = email.trim().toLowerCase();
  return t === "" ? null : t;
}

function identityMismatch(signInEmail, membershipContactEmail) {
  const a = normEmail(signInEmail);
  const b = normEmail(membershipContactEmail);
  if (a === null || b === null) return false;
  return a !== b;
}

function passportResetOffered(
  entitlement,
  signInEmail,
  membershipContactEmail,
) {
  return (
    !entitlement.entitled &&
    identityMismatch(signInEmail, membershipContactEmail)
  );
}

module.exports = {
  evaluateEntitlement,
  identityMismatch,
  passportResetOffered,
};
