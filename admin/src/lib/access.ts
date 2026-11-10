import {
  ALL_CAPABILITIES,
  ROLE_CAPABILITIES,
  can,
  hasCapability,
  type Principal,
} from "../../../packages/content-core/src/rbac";

// #380 placeholder: draft/lifecycle status gating is not modeled yet. It composes
// beside the capability check, never inside rbac. Always passes for now.
export function lifecycleAllows(_principal: Principal): boolean {
  return true;
}

// A principal may use the admin app if the lifecycle check passes AND they hold at
// least one capability (any staff role does). The two checks are AND-composed side
// by side; the capability check is never folded into lifecycleAllows.
export function canAccessAdmin(principal: Principal): boolean {
  const hasAnyCapability = ALL_CAPABILITIES.some((capability) =>
    hasCapability(principal, capability),
  );
  return lifecycleAllows(principal) && hasAnyCapability;
}

export function canViewUsers(principal: Principal): boolean {
  return hasCapability(principal, "users.view");
}

export function canViewGuide(principal: Principal): boolean {
  return hasCapability(principal, "guide.view");
}

export function isGuideOnly(principal: Principal): boolean {
  // Media browsing and own reports preserve the staff shell without authoring or profile controls.
  return (
    canViewGuide(principal) &&
    !ALL_CAPABILITIES.some(
      (capability) =>
        capability !== "guide.view" && capability !== "media.audio.read" && capability !== "media.video.read" && capability !== "reports.view" && hasCapability(principal, capability),
    )
  );
}

// Managing another author's profile uses its own site-wide capability. Self-service
// profile editing remains a separate account boundary.
export function canManageAuthorProfiles(principal: Principal): boolean {
  return hasCapability(principal, "profiles.manage");
}

export function canManageRoles(principal: Principal): boolean {
  return hasCapability(principal, "roles.grant");
}

// Review work follows the same scoped edit-any capability the server uses for
// queue rows and decisions. A section-scoped editor reaches the destination and
// sees only the requests in their desks.
export function canViewEditorialQueue(principal: Principal): boolean {
  return hasCapability(principal, "content.view") || hasCapability(principal, "content.edit.any");
}

// Deployment recovery exposes infrastructure state and remains administrator-only.
export function canViewPublishActivity(principal: Principal): boolean {
  return hasCapability(principal, "settings.manage");
}

// Compatibility alias for call sites outside the route shell. New code should
// name the editorial queue or publish activity boundary explicitly.
export function canViewQueue(principal: Principal): boolean {
  return canViewEditorialQueue(principal);
}

export function canManageSettings(principal: Principal): boolean {
  return hasCapability(principal, "settings.manage");
}

export function canViewAudit(principal: Principal): boolean {
  return hasCapability(principal, "audit.view");
}

// The workspace admits staff; individual sources remain server-authorized.
export function canAccessMediaWorkspace(principal: Principal): boolean {
  return canAccessAdmin(principal);
}

export function canUseMediaLibrary(principal: Principal): boolean {
  return (
    hasCapability(principal, "media.image.read") ||
    hasCapability(principal, "media.upload") ||
    hasCapability(principal, "media.manage")
  );
}

export function canUseAudioLibrary(principal: Principal): boolean {
  return canUseMediaLibrary(principal) || hasCapability(principal, "media.audio.read");
}

export function canUploadMedia(
  principal: Principal,
  _category?: string,
): boolean {
  return can(principal, "media.upload");
}

export function canManageMediaMetadata(
  principal: Principal,
  _category: string,
): boolean {
  return can(principal, "media.manage");
}

export function canReviewUgcSubmissions(principal: Principal): boolean {
  return can(principal, "submissions.review");
}

// Courtesy editor locks use a direct client Firestore boundary. Match that narrow presence
// path to the resolved site-wide content-create decision used by the unsectioned editor. A
// section-scoped grant has no section to prove here and must not widen into a global lease.
export function canUseEditorLocks(principal: Principal): boolean {
  return can(principal, "content.create", {});
}

// Whether the CMS documents can be reached at all. This mirrors the server's coarse
// membership check, not a record decision: scope-aware but resource-blind, so a
// section-scoped grant reaches the studio and is then allowed or refused per document
// against that document's own desk (#845).
//
// It used to ask `can(principal, "content.create", {})` -- an unsectioned resource -- which
// was the same question only while no content carried a desk (#194). Now that it does,
// asking it would lock the content studio away from exactly the scoped editors section
// enforcement exists to serve: their records would be reachable by the server and
// unreachable in the app. Every admitted authoring role holds content.create, so it stays
// the honest entry floor while ownership, desk, and lifecycle remain record-level server
// decisions.
export function canUseContentStudio(principal: Principal): boolean {
  return hasCapability(principal, "content.view") || hasCapability(principal, "content.create");
}

// The server lists only readable pages; the directory also filters built-in
// entries by the user's section grants.
export function canBrowseContentPages(principal: Principal): boolean {
  return hasCapability(principal, "content.view") || hasCapability(principal, "content.edit.any") || hasCapability(principal, "content.edit.own");
}

// Bulk archive requires content.delete on both client and server.
// Publisher, Admin and Owner have it; Editor and Contributor cannot use these controls.
// Assignment also requires users.manage and an administrator server session.
export function canManageContentRecords(principal: Principal): boolean {
  return can(principal, "content.delete", {});
}

// Whether a principal may save content in the editor. This is the author floor: a
// contributor holds it, and record ownership remains a server-side decision.
export function canSaveContent(principal: Principal): boolean {
  return hasCapability(principal, "content.create");
}

// The server also checks this capability against the addressed content's section.
export function canPublishContent(principal: Principal): boolean {
  return hasCapability(principal, "content.publish");
}

// Analytics is a site-wide administrative report. Scoped grants do not admit it.
export function canViewAnalytics(principal: Principal): boolean {
  return can(principal, "analytics.view");
}

// Reports retain their per-person ownership rules on the server; area grants can
// open the destination because a person's problem reports have no content area.
export function canViewReports(principal: Principal): boolean {
  return hasCapability(principal, "reports.view");
}

// Filing a problem follows the intake's approved staff role check. Reading
// reports still requires reports.view, and an empty area grants no workspace access.
export function canSubmitProblemReport(principal: Principal): boolean {
  return (principal.grants ?? []).some((grant) =>
    Object.hasOwn(ROLE_CAPABILITIES, grant.role),
  );
}
