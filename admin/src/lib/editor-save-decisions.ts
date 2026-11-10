// The workspace's client-side mirrors of cmsSaveContent's record and page authorization.
//
// They decide whether the editor presents Save and the lifecycle controls as available, so
// they have to ask the same question the server will: the capability, against the same
// resource. The resource is the part that used to drift. A mirror built from `ownerId`
// alone answers "site-wide or owner?" and silently denies every desk-scoped grant, which
// leaves a section-scoped editor holding a record the server authorized them to open with
// every control on it disabled (#845).
//
// Extracted from EditorWorkspace so both halves of that contract -- enabled inside the
// desk, disabled outside it -- can be asserted directly rather than through a mounted
// editor.

import { can, type Principal, type Resource } from "../../../packages/content-core/src/rbac";
import { contentSectionForPublicPage } from "../../../packages/content-core/src/content-sections";

export type SaveDecision = { allowed: true } | { allowed: false; reason: string };

/** The lifecycle status a record must be in for own-content authority to cover it. */
const OWN_EDIT_STATUS = "draft";

function ownerOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function frozenReason(status: unknown): string | null {
  if (status === "in_review") return "Select Edit before changing reviewed content.";
  if (status === "approved") return "Select Edit before changing approved content.";
  if (status === "scheduled") return "Cancel scheduled publication before editing.";
  return null;
}

export interface ReadOnlyNotice {
  title: string;
  message: string;
}

/**
 * What the editor says over an inert canvas, and why. The canvas used to state one reason for
 * every read-only cause, "Restoring this version", which was false for an approved, scheduled,
 * or published document that had simply been opened. Each cause now names itself and the
 * action that unfreezes it, in the same words the Update button's own reason uses. A document
 * that is not read-only gets null, so a caller can pass the result straight through.
 */
export function readOnlyNotice(input: {
  status: unknown;
  restoring: boolean;
  changingLifecycle: boolean;
  noun: "page" | "record" | "post";
}): ReadOnlyNotice | null {
  if (input.restoring) {
    return {
      title: "Restoring this version",
      message: "Editing will resume after the current document reloads.",
    };
  }
  if (input.changingLifecycle) {
    return {
      title: "Updating the workflow status",
      message: "Editing will resume once the status change lands.",
    };
  }
  const reason = frozenReason(input.status);
  if (!reason) return null;
  return {
    title: `This ${input.noun} is ${String(input.status)}`,
    message: reason,
  };
}

/**
 * The resource a stored record's authorization is decided against: its owner and its own
 * editorial desk. A record's desk is fixed by the write that created it, so the stored
 * value is the answer; a record that carries none states none, which denies every scoped
 * grant rather than being widened to site-wide.
 */
export function recordLifecycleResource(record: Record<string, unknown>): Resource {
  const ownerId = ownerOf(record.createdBy);
  const section =
    typeof record.section === "string" && record.section.length > 0
      ? record.section
      : undefined;
  return {
    ...(ownerId === undefined ? {} : { ownerId }),
    ...(section === undefined ? {} : { section }),
    ...(record.type === "post" && record.status === "draft" &&
      record.unassignedDraft === true && record.section === undefined &&
      record.published === undefined && record.deleted !== true
      ? { unassignedDraft: true } : {}),
  };
}

/** The shape of a hydrated canonical page this module needs. */
export interface PageAuthorizationFields {
  expectedAbsent: boolean;
  pageStatus?: unknown;
  createdBy?: unknown;
  editingSection?: unknown;
}

/**
 * The resource a canonical page's authorization is decided against: its owner and the desk
 * the public page registry gives it. A page's desk is its server-owned public area, which
 * the save path recomputes from the same registry on every write, so it is known here
 * before any document exists -- that is what lets a scoped editor create a page in their
 * own area from a blank editor.
 */
export function pageLifecycleResource(
  pageId: string,
  page: PageAuthorizationFields,
): Resource {
  const ownerId = ownerOf(page.createdBy);
  const section = contentSectionForPublicPage(pageId) ?? ownerOf(page.editingSection) ?? null;
  return {
    ...(ownerId === undefined ? {} : { ownerId }),
    ...(section === null ? {} : { section }),
  };
}

/**
 * Mirror cmsSaveContent's record-level authorization before presenting Save as available.
 * Site-wide edit-any authority may edit any lifecycle state; a desk-scoped grant carries
 * the same authority inside the desks it names. Own-content authority additionally requires
 * trusted ownership and covers only the owner's draft; missing ownership or lifecycle data
 * denies rather than widening a contributor into edit-any access.
 */
export function recordSaveDecision(
  principal: Principal,
  record: Record<string, unknown>,
): SaveDecision {
  const frozen = frozenReason(record.status);
  if (frozen !== null) return { allowed: false, reason: frozen };

  const resource = recordLifecycleResource(record);

  if (can(principal, "content.edit.any", resource)) return { allowed: true };

  if (resource.ownerId === undefined || typeof record.status !== "string") {
    return {
      allowed: false,
      reason:
        "This record's ownership or workflow status is unavailable, so it cannot be saved.",
    };
  }
  if (!can(principal, "content.edit.own", resource)) {
    return { allowed: false, reason: "Your role cannot save this record." };
  }
  if (record.status !== OWN_EDIT_STATUS) {
    return {
      allowed: false,
      reason: "Submitted records are read-only for Writers.",
    };
  }
  return { allowed: true };
}

/**
 * Mirror cmsSaveContent's page authorization against the lifecycle fields returned by the
 * authenticated read. A never-created canonical page is a create and remains writable to an
 * allowed contributor. Once it exists, edit-own covers only the trusted owner's draft;
 * missing ownership or status denies, while edit-any remains lifecycle-independent like the
 * server. Every check is made against the page's registry desk, so a scoped editor keeps
 * the pages in their own public area and only those.
 */
export function pageSaveDecision(
  principal: Principal,
  pageId: string,
  page: PageAuthorizationFields,
): SaveDecision {
  const resource = pageLifecycleResource(pageId, page);
  const homeDecision: SaveDecision = pageId === "home" && !can(principal, "content.edit.any", resource)
    ? { allowed: false, reason: "Home requires edit access in the Station area." }
    : { allowed: true };

  if (page.expectedAbsent) {
    if (!can(principal, "content.create", resource)) {
      return { allowed: false, reason: "Your role cannot create this page." };
    }
    // A legacy-seeded create adopts the source lifecycle on the server. Entering published or
    // scheduled from an absent target is therefore a publish transition, while entering archived
    // is an archive transition, even though the visible editor is creating a new canonical
    // document. Mirror those capability checks here, against the same desk, so an editor is
    // not offered a save the server must refuse.
    if (
      (page.pageStatus === "published" || page.pageStatus === "scheduled") &&
      !can(principal, "content.publish", resource)
    ) {
      return {
        allowed: false,
        reason:
          "Publish access is required to create this page from its legacy content.",
      };
    }
    if (page.pageStatus === "archived" && !can(principal, "content.unpublish", resource)) {
      return {
        allowed: false,
        reason:
          "Unpublish access is required to create this archived page from its legacy content.",
      };
    }
    return homeDecision;
  }

  const frozen = frozenReason(page.pageStatus);
  if (frozen !== null) return { allowed: false, reason: frozen };

  if (can(principal, "content.edit.any", resource)) return { allowed: true };

  if (resource.ownerId === undefined || typeof page.pageStatus !== "string") {
    return {
      allowed: false,
      reason:
        "This page's ownership or workflow status is unavailable, so it cannot be saved.",
    };
  }
  if (!can(principal, "content.edit.own", resource)) {
    return { allowed: false, reason: "Your role cannot save this page." };
  }
  if (page.pageStatus !== OWN_EDIT_STATUS) {
    return {
      allowed: false,
      reason: "Submitted pages are read-only for Writers.",
    };
  }
  return homeDecision;
}
