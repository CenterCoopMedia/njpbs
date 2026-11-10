"use strict";

// Server-owned bootstrap identity settings. Routine account requests accept
// any verified email and remain privilege-free until a super admin approves them.

const { defineList } = require("firebase-functions/params");

const BOOTSTRAP_SUPER_ADMINS = defineList("BOOTSTRAP_SUPER_ADMINS");

function normalizedEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function exactEmailIsAllowed(email, allowlist) {
  const candidate = normalizedEmail(email);
  return (
    candidate.length > 0 &&
    allowlist.some((allowedEmail) => normalizedEmail(allowedEmail) === candidate)
  );
}

module.exports = {
  BOOTSTRAP_SUPER_ADMINS,
  exactEmailIsAllowed,
};
