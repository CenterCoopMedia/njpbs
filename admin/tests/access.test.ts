import { describe, expect, it } from "vitest";
import {
  ALL_CAPABILITIES,
  hasCapability,
  type Principal,
} from "../../packages/content-core/src/rbac";
import {
  canAccessAdmin,
  canSubmitProblemReport,
  canAccessMediaWorkspace,
  canBrowseContentPages,
  canUseContentStudio,
  canUseMediaLibrary,
  canUseAudioLibrary,
  canUseEditorLocks,
  canManageContentRecords,
  canManageMediaMetadata,
  canManageRoles,
  canPublishContent,
  canSaveContent,
  canViewAudit,
  canViewEditorialQueue,
  canViewPublishActivity,
  canViewQueue,
  canViewUsers,
  canUploadMedia,
  canViewReports,
  canViewAnalytics,
  canManageAuthorProfiles,
  canReviewUgcSubmissions,
  lifecycleAllows,
} from "../src/lib/access";

function hasAnyCapability(principal: Principal): boolean {
  return ALL_CAPABILITIES.some((capability) =>
    hasCapability(principal, capability),
  );
}

describe("admin access helpers", () => {
  it.each(["general", "staff-profile"])("keeps media controls site-wide in %s", (category) => {
    const editor: Principal = { grants: [{ role: "editor", sections: ["watch"], registeredMediaSections: ["watch"] }] };
    const viewer: Principal = { grants: [{ role: "staff" }] };
    expect(canUploadMedia(editor, category)).toBe(true);
    expect(canManageMediaMetadata(editor, category)).toBe(true);
    expect(canUploadMedia(viewer, category)).toBe(false);
    expect(canManageMediaMetadata(viewer, category)).toBe(false);
  });
  it("matches named reports, analytics, profile and submission permissions", () => {
    const writer: Principal = { grants: [{ role: "contributor", sections: ["watch"], registeredMediaSections: ["watch"] }] };
    const viewer: Principal = { grants: [{ role: "staff" }] };
    const manager: Principal = { grants: [{ role: "admin" }] };
    const editor: Principal = { grants: [{ role: "editor" }] };
    expect(canViewReports(writer)).toBe(true);
    expect(canViewReports(viewer)).toBe(true);
    expect(canViewAnalytics(editor)).toBe(false);
    expect(canViewAnalytics(manager)).toBe(true);
    expect(canManageAuthorProfiles(manager)).toBe(true);
    expect(canManageAuthorProfiles(editor)).toBe(false);
    expect(canReviewUgcSubmissions(editor)).toBe(true);
    expect(canReviewUgcSubmissions(writer)).toBe(false);
  });
  it("admits staff to video sources without granting image library permissions", () => {
    const staff: Principal = { id: "staff", grants: [{ role: "staff" }] };
    expect(canAccessMediaWorkspace(staff)).toBe(true);
    expect(canUseMediaLibrary(staff)).toBe(false);
    expect(canUseAudioLibrary(staff)).toBe(true);
    expect(canUseAudioLibrary({ id: "unknown", grants: [] })).toBe(false);
    expect(canUseAudioLibrary({ id: "empty-scope", grants: [{role:"staff",sections:[]}] })).toBe(false);
    expect(canAccessMediaWorkspace({ id: "unknown", grants: [] })).toBe(false);
  });
  it("offers the content studio to anyone holding an authoring grant anywhere (#845)", () => {
    // The coarse membership floor, mirroring the server: scope-aware but resource-blind.
    // A section-scoped editor reaches the studio and is then allowed or refused per
    // document against that document's own desk. Gating this on an unsectioned resource
    // was right only while no content carried a desk (#194); now it would lock the studio
    // away from exactly the editors section enforcement exists to serve.
    expect(canUseContentStudio({ id: "admin", grants: [{ role: "admin" }] })).toBe(true);
    expect(canUseContentStudio({ id: "editor", grants: [{ role: "editor" }] })).toBe(true);
    expect(canUseContentStudio({ id: "author", grants: [{ role: "contributor" }] })).toBe(true);
    expect(
      canUseContentStudio({
        id: "scoped-editor",
        grants: [{ role: "editor", sections: ["news"], registeredMediaSections: ["news"] }],
      }),
    ).toBe(true);
    expect(
      canUseContentStudio({
        id: "scoped-contributor",
        grants: [{ role: "contributor", sections: ["news"], registeredMediaSections: ["news"] }],
      }),
    ).toBe(true);
    expect(canUseContentStudio({ id: "empty", grants: [] })).toBe(false);
  });

  it("shows the page directory to principals who can edit readable records", () => {
    // The server still filters built-in and stored pages to each principal's record
    // scope. The directory can therefore show an owner the pages they may open.
    expect(canBrowseContentPages({ id: "admin", grants: [{ role: "admin" }] })).toBe(true);
    expect(canBrowseContentPages({ id: "editor", grants: [{ role: "editor" }] })).toBe(true);
    expect(
      canBrowseContentPages({ id: "author", grants: [{ role: "contributor" }] }),
    ).toBe(true);
    expect(
      canBrowseContentPages({
        id: "scoped-editor",
        grants: [{ role: "editor", sections: ["news"], registeredMediaSections: ["news"] }],
      }),
    ).toBe(true);
    expect(
      canBrowseContentPages({
        id: "scoped-contributor",
        grants: [{ role: "contributor", sections: ["news"], registeredMediaSections: ["news"] }],
      }),
    ).toBe(true);
  });

  it("offers courtesy editor locks to site-wide content writers", () => {
    expect(canUseEditorLocks({ id: "admin", grants: [{ role: "admin" }] })).toBe(true);
    expect(canUseEditorLocks({ id: "editor", grants: [{ role: "editor" }] })).toBe(true);
    expect(
      canUseEditorLocks({ id: "contributor", grants: [{ role: "contributor" }] }),
    ).toBe(true);
    expect(
      canUseEditorLocks({
        id: "scoped-editor",
        grants: [{ role: "editor", sections: ["news"], registeredMediaSections: ["news"] }],
      }),
    ).toBe(false);
    expect(canUseEditorLocks({ id: "empty", grants: [] })).toBe(false);
  });

  it("keeps destructive record management above ordinary editing", () => {
    expect(canManageContentRecords({ id: "admin", grants: [{ role: "admin" }] })).toBe(true);
    expect(canManageContentRecords({ id: "editor", grants: [{ role: "editor" }] })).toBe(false);
    expect(
      canManageContentRecords({ id: "author", grants: [{ role: "contributor" }] }),
    ).toBe(false);
  });

  it("gates media browsing and metadata management by capability", () => {
    const contributor: Principal = {
      id: "contributor",
      grants: [{ role: "contributor", sections: ["news"], registeredMediaSections: ["news"] }],
    };
    const editor: Principal = {
      id: "editor",
      grants: [{ role: "editor", sections: ["news"], registeredMediaSections: ["news"] }],
    };

    expect(canUseMediaLibrary(contributor)).toBe(false);
    expect(canManageMediaMetadata(contributor, "news")).toBe(false);
    expect(canUseMediaLibrary(editor)).toBe(true);
    expect(canManageMediaMetadata(editor, "news")).toBe(true);
    expect(canManageMediaMetadata(editor, "programs")).toBe(true);
    expect(canUseMediaLibrary({ id: "empty", grants: [] })).toBe(false);
  });

  it("allows any principal with at least one capability", () => {
    const superAdmin: Principal = {
      id: "super",
      grants: [{ role: "super_admin" }],
    };
    const contributor: Principal = {
      id: "contributor",
      grants: [{ role: "contributor", sections: ["news"], registeredMediaSections: ["news"] }],
    };
    const empty: Principal = { id: "empty", grants: [] };

    expect(canAccessAdmin(superAdmin)).toBe(true);
    expect(canAccessAdmin(contributor)).toBe(true);
    expect(canAccessAdmin(empty)).toBe(false);
  });

  it("keeps lifecycle status beside capability checks", () => {
    const principal: Principal = {
      id: "admin",
      grants: [{ role: "admin" }],
    };

    expect(lifecycleAllows(principal)).toBe(true);
    expect(canAccessAdmin(principal)).toBe(
      lifecycleAllows(principal) && hasAnyCapability(principal),
    );
  });

  it("matches tab and action gates to capabilities", () => {
    const superAdmin: Principal = {
      id: "super",
      grants: [{ role: "super_admin" }],
    };
    const admin: Principal = { id: "admin", grants: [{ role: "admin" }] };
    const editor: Principal = {
      id: "editor",
      grants: [{ role: "editor", sections: ["news"], registeredMediaSections: ["news"] }],
    };

    expect(canViewUsers(admin)).toBe(true);
    expect(canViewUsers(editor)).toBe(false);
    expect(canViewEditorialQueue(admin)).toBe(true);
    expect(canViewEditorialQueue(editor)).toBe(true);
    expect(
      canViewEditorialQueue({
        id: "contributor",
        grants: [{ role: "contributor" }],
      }),
    ).toBe(false);
    expect(canViewPublishActivity(admin)).toBe(true);
    expect(canViewPublishActivity(editor)).toBe(false);
    expect(canViewQueue(editor)).toBe(true);
    expect(canViewAudit(admin)).toBe(true);
    expect(canViewAudit(editor)).toBe(false);
    expect(canManageRoles(superAdmin)).toBe(true);
    expect(canManageRoles(admin)).toBe(false);
    expect(canManageRoles(editor)).toBe(false);
  });

  it("lets a contributor save drafts without exposing publish", () => {
    const contributor: Principal = {
      id: "contributor",
      grants: [{ role: "contributor", sections: ["news"], registeredMediaSections: ["news"] }],
    };
    expect(canSaveContent(contributor)).toBe(true);
    expect(canPublishContent(contributor)).toBe(false);
  });

  it("lets an editor both save and publish", () => {
    const editor: Principal = {
      id: "editor",
      grants: [{ role: "editor", sections: ["news"], registeredMediaSections: ["news"] }],
    };
    expect(canSaveContent(editor)).toBe(true);
    expect(canPublishContent(editor)).toBe(true);
  });

  it("denies save and publish to a principal with no capabilities", () => {
    const empty: Principal = { id: "empty", grants: [] };
    expect(canSaveContent(empty)).toBe(false);
    expect(canPublishContent(empty)).toBe(false);
  });
});

it("lets an approved empty-scope Editor file a problem without workspace or report-reading access", () => {
  const limited: Principal = { id: "limited", grants: [{ role: "editor", sections: [] }] };
  expect(canSubmitProblemReport(limited)).toBe(true);
  expect(canAccessAdmin(limited)).toBe(false);
  expect(canViewReports(limited)).toBe(false);
  expect(canSaveContent(limited)).toBe(false);
  expect(canSubmitProblemReport({ id: "pending", grants: [] })).toBe(false);
  expect(canSubmitProblemReport({ id: "unknown", grants: [{ role: "unknown" as Principal["grants"][number]["role"] }] })).toBe(false);
});
