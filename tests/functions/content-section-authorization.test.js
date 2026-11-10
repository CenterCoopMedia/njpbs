// Section-scoped content authorization (#845). #619 gave a record a `section` and gave a
// grant a list of them; this is the contract that makes the two meet at every content
// boundary. Kept pure -- no emulator, no document, no transaction -- because the decision
// itself is pure, and a regression in it should fail fast and read plainly. The endpoint
// suites (get-content, list-content, save, revisions, restore-revision) then check that
// each boundary actually asks these questions about the right document.

import { describe, expect, it } from "vitest";

import contentAuthorizationPkg from "../../functions/lib/content-authorization.js";
import listContentPkg from "../../functions/list-content.js";
import publicPageContractPkg from "../../functions/lib/public-page-contract.js";

const {
  authorizeContentRead,
  authorizeContentWrite,
  contentResourceSection,
  contentResource,
  mayReadSomeContentRecord,
} = contentAuthorizationPkg;
const { visibleContentSummaries } = listContentPkg;
const { contentSectionForPage } = publicPageContractPkg;

/** A principal holding one site-wide grant of the given role. */
const siteWide = (role, id = "user-1") => ({ id, grants: [{ role }] });
/** A principal holding one desk-scoped grant of the given role. */
const scoped = (role, sections, id = "user-1") => ({
  id,
  grants: [{ role, sections }],
});

const read = (section, ownerId = "somebody-else") => ({
  exists: true,
  resource: { ownerId, ...(section === undefined ? {} : { section }) },
});

const edit = (section, ownerId = "somebody-else") => ({
  creating: false,
  publishing: false,
  storedStatus: "draft",
  nextStatus: "draft",
  resource: { ownerId, ...(section === undefined ? {} : { section }) },
});

// A public page id whose desk the registry owns, discovered rather than hard-coded so this
// suite cannot drift from the registry it is asserting about.
const registryPage = (() => {
  for (const id of ["watch", "support", "about", "home", "schedule", "contact"]) {
    const section = contentSectionForPage(id);
    if (typeof section === "string" && section !== "") return { id, section };
  }
  throw new Error("No canonical page carries a registry section");
})();

describe("contentResourceSection", () => {
  it("answers a canonical page from the public page registry, not the document", () => {
    // The page's desk is server-owned and recomputed on every save, so a stored value that
    // disagrees is stale by definition. Reading it instead would let a page that moved
    // areas stay authorized against the desk it left.
    expect(
      contentResourceSection({
        collection: "cmsPages",
        documentId: registryPage.id,
        stored: { section: "a-stale-desk" },
      }),
    ).toBe(registryPage.section);
  });

  it("falls back to a page's stored desk once it leaves the registry", () => {
    // Keeps a retired page reachable by the desk it actually carries, rather than becoming
    // unsectioned -- and therefore unreachable to every scoped grant -- between one save
    // and the next.
    expect(
      contentResourceSection({
        collection: "cmsPages",
        documentId: "a-page-id-no-registry-entry-names",
        stored: { section: "watch" },
      }),
    ).toBe("watch");
  });

  it("answers a stored record with its own desk", () => {
    expect(
      contentResourceSection({
        collection: "cmsPosts",
        documentId: "a-1",
        stored: { section: "watch" },
      }),
    ).toBe("watch");
  });

  it("answers a record create with the desk it asks to be created into", () => {
    // There is no stored document yet, so the ask is what the create is authorized
    // against. The save transaction still validates it against the live registry.
    expect(
      contentResourceSection({
        collection: "cmsPosts",
        stored: null,
        requestedSection: "watch",
      }),
    ).toBe("watch");
  });

  it("states no desk for a record stored before the registry existed", () => {
    expect(
      contentResourceSection({ collection: "cmsPosts", stored: {} }),
    ).toBeUndefined();
  });

  it("states no desk for a malformed stored value rather than matching it loosely", () => {
    // Anything a registry id could never be. `undefined` is the closed answer here: rbac
    // denies every scoped grant on a resource with no stated section, so a garbage value
    // can never be compared against a grant and accidentally match.
    for (const value of [7, null, {}, [], "", "  ", " watch", "watch "]) {
      expect(
        contentResourceSection({ collection: "cmsPosts", stored: { section: value } }),
        JSON.stringify(value),
      ).toBeUndefined();
    }
  });

  it("ignores a requested section once the document exists", () => {
    // A record's desk is fixed by its create. A later save may state one -- the save
    // boundary rejects a disagreement with a 400 -- but it can never be what the decision
    // is made against, or a scoped editor could authorize their own edit by asking.
    expect(
      contentResourceSection({
        collection: "cmsPosts",
        stored: { section: "station" },
        requestedSection: "watch",
      }),
    ).toBe("station");
  });
});

describe("a section-scoped grant against a sectioned record", () => {
  const watchEditor = scoped("editor", ["watch"]);

  it("may read and edit a record in its own desk", () => {
    expect(authorizeContentRead(watchEditor, read("watch")).allowed).toBe(true);
    expect(authorizeContentWrite(watchEditor, edit("watch")).allowed).toBe(true);
  });

  it("may not read or edit a record in another desk", () => {
    expect(authorizeContentRead(watchEditor, read("station")).allowed).toBe(false);
    expect(authorizeContentWrite(watchEditor, edit("station")).allowed).toBe(false);
  });

  it("may not read or edit a record carrying no desk", () => {
    // Deny-by-default is the whole point: an unsectioned record is not "everyone's", it is
    // outside every scope until a backfill puts it in one.
    expect(authorizeContentRead(watchEditor, read(undefined)).allowed).toBe(false);
    expect(authorizeContentWrite(watchEditor, edit(undefined)).allowed).toBe(false);
  });

  it("may not reach its own draft in another desk", () => {
    // Ownership does not punch through the scope. A record the person wrote and then moved
    // out of their desk (or wrote before their grant narrowed) is still out of scope.
    expect(
      authorizeContentRead(watchEditor, read("station", "user-1")).allowed,
    ).toBe(false);
    expect(
      authorizeContentWrite(watchEditor, edit("station", "user-1")).allowed,
    ).toBe(false);
  });

  it("honors every desk a multi-desk grant names", () => {
    const both = scoped("editor", ["watch", "station"]);
    expect(authorizeContentRead(both, read("watch")).allowed).toBe(true);
    expect(authorizeContentRead(both, read("station")).allowed).toBe(true);
    expect(authorizeContentRead(both, read("compliance")).allowed).toBe(false);
  });
});

describe("a site-wide grant is unchanged by section enforcement", () => {
  it("reads and edits a record in any desk, and one with none", () => {
    for (const role of ["super_admin", "admin", "editor"]) {
      const actor = siteWide(role);
      for (const section of ["watch", "station", undefined]) {
        expect(
          authorizeContentRead(actor, read(section)).allowed,
          `${role}:${section}`,
        ).toBe(true);
        expect(
          authorizeContentWrite(actor, edit(section)).allowed,
          `${role}:${section}`,
        ).toBe(true);
      }
    }
  });
});

describe("mayReadSomeContentRecord (the list boundary's coarse precheck)", () => {
  it("admits a site-wide grant", () => {
    for (const role of ["super_admin", "admin", "editor"]) {
      expect(mayReadSomeContentRecord(siteWide(role)), role).toBe(true);
    }
  });

  it("admits a contributor, who can be shown their own drafts", () => {
    expect(mayReadSomeContentRecord(siteWide("contributor"))).toBe(true);
  });

  it("admits a section-scoped grant, which the per-row filter then narrows", () => {
    // The regression this exists to prevent: the old precheck asked whether the caller
    // could read an *unsectioned* record, which 403s the whole endpoint for exactly the
    // scoped editors section enforcement is meant to serve.
    expect(mayReadSomeContentRecord(scoped("editor", ["watch"]))).toBe(true);
    expect(mayReadSomeContentRecord(scoped("contributor", ["watch"]))).toBe(true);
  });

  it("refuses a principal with no grants", () => {
    expect(mayReadSomeContentRecord({ id: "user-1", grants: [] })).toBe(false);
    expect(mayReadSomeContentRecord({})).toBe(false);
  });

  it("refuses a malformed grant, which confers nothing", () => {
    // `sections` present but unusable is a broken grant, not a site-wide one.
    for (const sections of [null, "watch", [], 7]) {
      expect(
        mayReadSomeContentRecord(scoped("editor", sections)),
        String(sections),
      ).toBe(false);
    }
  });

  it("cannot admit anyone the per-record read would refuse everywhere", () => {
    // It only ever asks `authorizeContentRead`, so it cannot widen past the row filter.
    const actor = scoped("editor", ["watch"]);
    expect(mayReadSomeContentRecord(actor)).toBe(
      authorizeContentRead(actor, read("watch", actor.id)).allowed,
    );
  });
});

describe("list rows are filtered by each record's own desk", () => {
  const stored = [
    { id: "w-1", kind: "article", title: "Tonight", createdBy: "editor-9", section: "watch" },
    { id: "s-1", kind: "article", title: "Tower", createdBy: "editor-9", section: "station" },
    { id: "u-1", kind: "article", title: "Legacy", createdBy: "editor-9" },
    { id: "o-1", kind: "article", title: "Mine", createdBy: "user-1", section: "station" },
  ];

  it("shows a scoped editor only the rows in the desks their grant names", () => {
    const visible = visibleContentSummaries(scoped("editor", ["watch"]), stored);
    expect(visible.map((row) => row.id)).toEqual(["w-1"]);
  });

  it("shows a site-wide editor every row, sectioned or not", () => {
    const visible = visibleContentSummaries(siteWide("editor"), stored);
    expect(visible.map((row) => row.id)).toEqual(["w-1", "s-1", "u-1", "o-1"]);
  });

  it("never returns the desk as a response field", () => {
    // `section` is read for the decision only, exactly like createdBy. Leaking it would
    // change the list contract and hand a caller the shape of the desks they cannot see.
    const visible = visibleContentSummaries(siteWide("editor"), stored);
    for (const row of visible) {
      expect(row).not.toHaveProperty("section");
      expect(row).not.toHaveProperty("createdBy");
    }
  });

  it("keeps a scoped contributor to their own work inside their desk", () => {
    const visible = visibleContentSummaries(
      scoped("contributor", ["station"], "user-1"),
      stored,
    );
    expect(visible.map((row) => row.id)).toEqual(["o-1"]);
  });
});


describe("unassigned post drafts", () => {
  const draft = { type: "post", status: "draft", createdBy: "user-1", unassignedDraft: true };
  it("admits only the scoped owner and keeps the state draft-only", () => {
    const resource = contentResource({ collection: "cmsPosts", stored: draft });
    const action = { ...edit(undefined), resource };
    expect(authorizeContentRead(scoped("editor", ["watch"]), { exists: true, resource }).allowed).toBe(true);
    expect(authorizeContentWrite(scoped("editor", ["watch"]), action).allowed).toBe(true);
    expect(authorizeContentWrite(scoped("editor", ["watch"], "other"), action).allowed).toBe(false);
    expect(authorizeContentWrite(scoped("editor", []), action).allowed).toBe(false);
    expect(authorizeContentWrite(scoped("editor", ["watch"]), { ...action, publishing: true }).allowed).toBe(false);
    expect(authorizeContentWrite(siteWide("admin"), { ...action, nextStatus: "in_review" }).allowed).toBe(false);
  });
  it("does not turn legacy, assigned, or published records into owner-only drafts", () => {
    for (const stored of [
      { ...draft, unassignedDraft: undefined }, { ...draft, section: "support" },
      { ...draft, status: "published" }, { ...draft, published: {} },
      { ...draft, type: "program" }, { ...draft, deleted: true },
    ]) {
      const resource = contentResource({ collection: "cmsPosts", stored });
      expect(resource.unassignedDraft).toBeUndefined();
      expect(authorizeContentRead(scoped("editor", ["watch"]), { exists: true, resource }).allowed).toBe(false);
    }
    expect(contentResource({ collection: "cmsPages", stored: draft }).unassignedDraft).toBeUndefined();
  });
  it("lists an unassigned draft only for its owner and omits the authorization marker", () => {
    const summary = { id: "draft-1", kind: "post", status: "draft", title: "Untitled post", createdBy: "user-1", unassignedDraft: true };
    expect(visibleContentSummaries(scoped("editor", ["watch"]), [summary])).toEqual([
      { id: "draft-1", kind: "post", status: "draft", title: "Untitled post" },
    ]);
    expect(visibleContentSummaries(scoped("editor", ["watch"], "other"), [summary])).toEqual([]);
  });
});
