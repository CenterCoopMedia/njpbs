// The write-path authorization decision (#529). These cases are the contract the
// save endpoint relies on, kept here rather than only in the endpoint's own suite
// because the decision is pure: it needs no emulator, no document, and no
// transaction, so a regression in it should fail fast and read plainly.

import { expect, it } from "vitest";

import contentAuthorizationPkg from "../../functions/lib/content-authorization.js";
import rbacPkg from "../../functions/lib/rbac.js";

const {
  authorizeContentRead,
  authorizeContentWrite,
} = contentAuthorizationPkg;
const { ROLE_CAPABILITIES } = rbacPkg;

/** A principal holding one site-wide grant of the given role. */
const siteWide = (role, id = "user-1") => ({ id, grants: [{ role }] });

const draft = (ownerId) => ({
  creating: false,
  publishing: false,
  storedStatus: "draft",
  nextStatus: "draft",
  resource: { ownerId },
});

// Keep unique policy rows here; endpoint suites own the repeated role matrix.
it("keeps Home, malformed input, ownership and same-status authorization invariants", async () => {
  const create = (nextStatus = "draft") => ({ creating: true, publishing: false, storedStatus: null, nextStatus, resource: {} });
  const stored = ownerId => ({ exists: true, resource: { ownerId } });
  expect(authorizeContentWrite(siteWide("contributor"), draft(null)).allowed).toBe(false);
  expect(authorizeContentRead(siteWide("contributor"), stored(null)).allowed).toBe(false);
  expect(authorizeContentWrite({ grants: [{ role: "contributor" }] }, draft(null)).allowed).toBe(false);

  expect(
    authorizeContentWrite(siteWide("editor"), create("archived")).allowed,
  ).toBe(true);
  const contributor = authorizeContentWrite(
    siteWide("contributor"),
    create("archived"),
  );
  expect(contributor.allowed).toBe(false);
  expect(contributor.reason).toContain("content.unpublish");

  // A record stored before createdBy existed has no owner, so own-content
  // authority does not reach it.
  expect(
    authorizeContentWrite(siteWide("contributor"), draft(undefined)).allowed,
  ).toBe(false);

  // The #380 lifecycle gate: draft and propose only. Submitting for review is
  // the point at which the record stops being theirs to change.
  for (const storedStatus of ["in_review", "scheduled", "published", "archived"]) {
    const decision = authorizeContentWrite(siteWide("contributor"), {
      creating: false,
      publishing: false,
      storedStatus,
      nextStatus: storedStatus,
      resource: { ownerId: "user-1" },
    });
    expect(decision.allowed, storedStatus).toBe(false);
    expect(decision.reason).toContain("draft");
  }

  // Neither side of the ownership comparison may be absent: a principal with no
  // id must not match a record with no owner.
  expect(
    authorizeContentWrite({ grants: [{ role: "contributor" }] }, draft(undefined))
      .allowed,
  ).toBe(false);

  // Republishing a live record freezes a new viewer-visible snapshot, so it is
  // a publish even though the status stays put.
  const republish = {
    creating: false,
    publishing: true,
    storedStatus: "published",
    nextStatus: "published",
    resource: { ownerId: "user-2" },
  };
  expect(authorizeContentWrite(siteWide("editor"), republish).allowed).toBe(true);
  expect(authorizeContentWrite(siteWide("contributor"), {
    ...republish, resource: { ownerId: "user-1" },
  }).allowed).toBe(false);
  // No role holds content.edit.any without content.publish, so nothing can
  // currently reach the edit layer and be refused at the publish one. Stating
  // the rule anyway keeps a later edit to the role table from quietly turning
  // "may edit a live record" into "may republish it".
  for (const role of ["super_admin", "admin", "editor"]) {
    expect(ROLE_CAPABILITIES[role], role).toContain("content.publish");
  }

  expect(
    authorizeContentWrite(siteWide("editor"), {
      creating: false,
      publishing: false,
      storedStatus: "archived",
      nextStatus: "archived",
      resource: { ownerId: "user-1" },
    }).allowed,
  ).toBe(true);

  // A metadata edit of a live record needs edit authority, not publish
  // authority: it changes the working document, not what is on the site.
  expect(
    authorizeContentWrite(siteWide("editor"), {
      creating: false,
      publishing: false,
      storedStatus: "published",
      nextStatus: "published",
      resource: { ownerId: "user-2" },
    }).allowed,
  ).toBe(true);
  expect(
    authorizeContentWrite(siteWide("editor"), {
      creating: false,
      publishing: false,
      storedStatus: "scheduled",
      nextStatus: "scheduled",
      resource: { ownerId: "user-2" },
    }).allowed,
  ).toBe(true);

  // A request that does not say which save it describes cannot be decided: the
  // transition gates would read as "no transition" and let it past.
  for (const action of [
    undefined,
    null,
    [],
    "draft",
    { creating: false, publishing: false, storedStatus: "draft" },
    { publishing: false, storedStatus: "draft", nextStatus: "published" },
    { creating: false, storedStatus: "draft", nextStatus: "published" },
  ]) {
    expect(
      authorizeContentWrite(siteWide("admin"), action).allowed,
      JSON.stringify(action) ?? String(action),
    ).toBe(false);
  }

  // lib/principal.js narrows a malformed `sections` value to an empty array and
  // keeps the field present, so the scope arrives here scoped-to-nothing rather
  // than widened into a site-wide grant. These are the shapes it can produce,
  // plus the raw ones, and every one of them has to be denied.
  for (const sections of [null, "news", [], 7]) {
    const actor = { id: "user-1", grants: [{ role: "editor", sections }] };
    expect(authorizeContentWrite(actor, draft("user-1")).allowed, String(sections)).toBe(
      false,
    );
  }

  // A record saved before createdBy existed has no owner, so own-content
  // authority cannot reach it. Deny rather than assume the reader owns it.
  expect(authorizeContentRead(siteWide("contributor"), stored(undefined)).allowed)
    .toBe(false);

  // An action missing `exists` would otherwise fall to the create branch, which
  // is the weaker of the two checks.
  for (const action of [
    undefined,
    null,
    [],
    "cmsPages",
    { resource: { ownerId: "user-1" } },
    { exists: "true", resource: { ownerId: "user-1" } },
  ]) {
    expect(
      authorizeContentRead(siteWide("admin"), action).allowed,
      JSON.stringify(action) ?? String(action),
    ).toBe(false);
  }

  for (const sections of [null, "news", [], 7]) {
    const actor = { id: "user-1", grants: [{ role: "editor", sections }] };
    expect(
      authorizeContentRead(actor, stored("user-1")).allowed,
      String(sections),
    ).toBe(false);
  }

  const { contentResource } = await import("../../functions/lib/content-authorization.js");
  const resource = contentResource({ collection: "cmsPages", documentId: "home", stored: { createdBy: "user-1", section: "news" } });
  expect(resource.section).toBe("station");
  for (const creating of [true, false]) {
    for (const publishing of [true, false]) {
      const action = { creating, publishing, storedStatus: "draft", nextStatus: publishing ? "published" : "draft", resource };
      for (const grants of [[{ role: "contributor" }], ...["news", "watch", "support"].map(section => [{ role: "editor", sections: [section] }])]) {
        expect(authorizeContentWrite({ id: "user-1", grants }, action).allowed).toBe(false);
      }
      for (const grants of [[{ role: "editor", sections: ["station"] }], [{ role: "editor" }], [{ role: "admin" }], [{ role: "super_admin" }]]) {
        expect(authorizeContentWrite({ id: "user-1", grants }, action).allowed).toBe(true);
      }
    }
  }
});
