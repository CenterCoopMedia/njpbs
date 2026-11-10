// The client-side mirrors of cmsSaveContent's record and page authorization (#845).
//
// These decide whether the workspace offers Save and the lifecycle controls at all, so a
// mirror that drops the document's editorial desk disables the exact work a section-scoped
// editor was granted: the server authorizes the read, the record opens, and every control
// on it is dead. These assertions pin both halves -- enabled inside the desk, disabled
// outside it -- for records and for canonical pages.

import { describe, expect, it } from "vitest";
import {
  readOnlyNotice,
  pageLifecycleResource,
  pageSaveDecision,
  recordLifecycleResource,
  recordSaveDecision,
} from "../src/lib/editor-save-decisions";
import type { Principal } from "../../packages/content-core/src/rbac";

const OWNER = "owner-uid";

/** A desk-scoped editor: full editing authority, confined to the desks it names. */
const scopedEditor = (sections: string[], id = "scoped-uid"): Principal => ({
  id,
  grants: [{ role: "editor", sections }],
});

/** A site-wide editor, whose behavior must not change under section enforcement. */
const siteWideEditor = (id = "sitewide-uid"): Principal => ({
  id,
  grants: [{ role: "editor" }],
});

const draftRecord = (section?: string) => ({
  status: "draft",
  createdBy: OWNER,
  ...(section === undefined ? {} : { section }),
});

const readyPage = (overrides: Record<string, unknown> = {}) => ({
  expectedAbsent: false,
  pageStatus: "draft",
  createdBy: OWNER,
  ...overrides,
});

describe("recordSaveDecision", () => {
  it("allows a scoped editor to save a record in a desk their grant names", () => {
    expect(
      recordSaveDecision(scopedEditor(["watch"]), draftRecord("watch")),
    ).toEqual({ allowed: true });
  });

  it("refuses a scoped editor a record in a desk their grant does not name", () => {
    const decision = recordSaveDecision(
      scopedEditor(["watch"]),
      draftRecord("station"),
    );
    expect(decision.allowed).toBe(false);
  });

  it("refuses a scoped editor a record carrying no desk", () => {
    // A record stored before the registry is outside every scope, not inside all of them.
    expect(recordSaveDecision(scopedEditor(["watch"]), draftRecord()).allowed).toBe(
      false,
    );
  });

  it("refuses a scoped editor their own draft in another desk", () => {
    // Ownership does not punch through the scope, exactly as on the server.
    const contributor: Principal = {
      id: OWNER,
      grants: [{ role: "contributor", sections: ["watch"] }],
    };
    expect(
      recordSaveDecision(contributor, draftRecord("station")).allowed,
    ).toBe(false);
    expect(recordSaveDecision(contributor, draftRecord("watch")).allowed).toBe(
      true,
    );
  });

  it("leaves a site-wide editor unchanged, sectioned record or not", () => {
    for (const record of [draftRecord(), draftRecord("watch"), draftRecord("station")]) {
      expect(recordSaveDecision(siteWideEditor(), record)).toEqual({
        allowed: true,
      });
    }
  });

  it("requires Edit before saving reviewed records", () => {
    for (const status of ["in_review", "approved"]) {
      const decision = recordSaveDecision(scopedEditor(["watch"]), {
        ...draftRecord("watch"),
        status,
      });
      expect(decision.allowed).toBe(false);
    }
  });
});

describe("recordLifecycleResource", () => {
  it("states the record's owner and its stored desk", () => {
    expect(recordLifecycleResource(draftRecord("watch"))).toEqual({
      ownerId: OWNER,
      section: "watch",
    });
  });

  it("states no desk for a record that carries none", () => {
    expect(recordLifecycleResource(draftRecord())).toEqual({ ownerId: OWNER });
  });
});

describe("pageSaveDecision", () => {
  it("allows a scoped editor to save a page in their own public area", () => {
    // /watch/ belongs to the watch desk in the shared public page registry.
    expect(pageSaveDecision(scopedEditor(["watch"]), "watch", readyPage())).toEqual({
      allowed: true,
    });
  });

  it("refuses a scoped editor a page in another public area", () => {
    // /support/ belongs to the support desk.
    expect(
      pageSaveDecision(scopedEditor(["watch"]), "support", readyPage()).allowed,
    ).toBe(false);
  });

  it("authorizes a never-created page against its registry desk", () => {
    // The blank editor's first save is a create, and the page's desk is known from the
    // registry before any document exists.
    expect(
      pageSaveDecision(scopedEditor(["watch"]), "watch", readyPage({ expectedAbsent: true }))
        .allowed,
    ).toBe(true);
    expect(
      pageSaveDecision(scopedEditor(["watch"]), "support", readyPage({ expectedAbsent: true }))
        .allowed,
    ).toBe(false);
  });

  it("authorizes a legacy-seeded published create against the same desk", () => {
    // Entering published from an absent target is a publish transition on the server.
    expect(
      pageSaveDecision(
        scopedEditor(["watch"]),
        "watch",
        readyPage({ expectedAbsent: true, pageStatus: "published" }),
      ).allowed,
    ).toBe(true);
    expect(
      pageSaveDecision(
        scopedEditor(["watch"]),
        "support",
        readyPage({ expectedAbsent: true, pageStatus: "published" }),
      ).allowed,
    ).toBe(false);
  });

  it("leaves a site-wide editor unchanged across every public area", () => {
    for (const pageId of ["watch", "support", "about", "privacy"]) {
      expect(pageSaveDecision(siteWideEditor(), pageId, readyPage())).toEqual({
        allowed: true,
      });
    }
  });

  it("allows an editor to save changes to a published page", () => {
    expect(
      pageSaveDecision(
        siteWideEditor(),
        "watch",
        readyPage({ pageStatus: "published" }),
      ).allowed,
    ).toBe(true);
  });

  it("requires Edit before saving a page during review", () => {
    const decision = pageSaveDecision(
      siteWideEditor(),
      "watch",
      readyPage({ pageStatus: "in_review" }),
    );
    expect(decision).toEqual({
      allowed: false,
      reason: "Select Edit before changing reviewed content.",
    });
  });
});

describe("pageLifecycleResource", () => {
  it("states the page's owner and its registry-derived desk", () => {
    expect(pageLifecycleResource("watch", readyPage())).toEqual({
      ownerId: OWNER,
      section: "watch",
    });
  });

  it("states the desk even when the page has no recorded owner", () => {
    expect(pageLifecycleResource("privacy", readyPage({ createdBy: undefined }))).toEqual(
      { section: "compliance" },
    );
  });

  it("states no desk for a page id the registry does not name", () => {
    expect(pageLifecycleResource("not-a-public-page", readyPage())).toEqual({
      ownerId: OWNER,
    });
  });
});

describe("readOnlyNotice", () => {
  it("names the restore and the status change while they are in flight", () => {
    expect(
      readOnlyNotice({ status: "draft", restoring: true, changingLifecycle: false, noun: "page" }),
    ).toEqual({
      title: "Restoring this version",
      message: "Editing will resume after the current document reloads.",
    });
    expect(
      readOnlyNotice({ status: "draft", restoring: false, changingLifecycle: true, noun: "post" })
        ?.title,
    ).toBe("Updating the workflow status");
  });

  it("names the frozen status and the action that unfreezes it", () => {
    expect(
      readOnlyNotice({ status: "published", restoring: false, changingLifecycle: false, noun: "page" }),
    ).toBeNull();
    expect(
      readOnlyNotice({ status: "approved", restoring: false, changingLifecycle: false, noun: "record" })
        ?.message,
    ).toBe(
      "Select Edit before changing approved content.",
    );
    expect(
      readOnlyNotice({ status: "scheduled", restoring: false, changingLifecycle: false, noun: "post" })
        ?.message,
    ).toMatch(/^Cancel scheduled publication before editing\./);
  });

  it("says nothing for a document that can be edited", () => {
    expect(
      readOnlyNotice({ status: "draft", restoring: false, changingLifecycle: false, noun: "page" }),
    ).toBeNull();
    expect(
      readOnlyNotice({ status: undefined, restoring: false, changingLifecycle: false, noun: "record" }),
    ).toBeNull();
  });
});

describe("Home edit permissions", () => {
  it("explains the Station requirement when a Writer could otherwise save the owned draft", () => {
    expect(pageSaveDecision({ id: OWNER, grants: [{ role: "contributor" }] }, "home", readyPage()))
      .toEqual({ allowed: false, reason: "Home requires edit access in the Station area." });
  });

  it("requires edit-any access in Station even for an owned or new Home draft", () => {
    for (const expectedAbsent of [true, false]) {
      const page = readyPage({ expectedAbsent });
      for (const principal of [
        { id: OWNER, grants: [{ role: "contributor" as const }] },
        scopedEditor(["news"]), scopedEditor(["watch"]), scopedEditor(["support"]),
      ]) expect(pageSaveDecision(principal, "home", page).allowed).toBe(false);
      for (const principal of [scopedEditor(["station"]), siteWideEditor(),
        { grants: [{ role: "admin" as const }] }, { grants: [{ role: "super_admin" as const }] },
      ]) expect(pageSaveDecision(principal, "home", page).allowed).toBe(true);
    }
  });
});
