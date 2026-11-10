"use strict";

const { ALL_CAPABILITIES, hasCapability } = require("./rbac");

// Grants come from the current stored profile, with inactive accounts stripped.
function hasPreviewAccess(principal) {
  return ALL_CAPABILITIES.some((capability) => hasCapability(principal, capability));
}

function isApprovedPreviewStaff(user, profile, principal) {
  return user.emailVerified === true && typeof user.email === "string" &&
    typeof profile?.email === "string" &&
    profile.email.trim().toLowerCase() === user.email.trim().toLowerCase() &&
    hasPreviewAccess(principal);
}

module.exports = { hasPreviewAccess, isApprovedPreviewStaff };
