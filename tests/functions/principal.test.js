// The stored user document is the only source of authority (#529), so what this
// resolver reads and what it declines to read is the whole trust boundary.
// admin/tests/principal-parity.test.ts separately pins it to the browser copy.

import { describe, expect, it } from "vitest";

import principalPkg from "../../functions/lib/principal.js";

const { principalFromUserDoc } = principalPkg;

describe("principalFromUserDoc", () => {
  it("reads a top-level admin tier as an unscoped grant", () => {
    for (const role of ["admin", "super_admin"]) {
      expect(principalFromUserDoc("u1", { role })).toEqual({
        id: "u1",
        grants: [{ role }],
      });
    }
  });

  it("ignores a grant role parked in the top-level field", () => {
    // roles.js persists editor and contributor in `grants`. A top-level
    // `role: "editor"` is not a grant and confers nothing, matching isAdmin.
    for (const role of ["editor", "contributor", "", "owner"]) {
      expect(principalFromUserDoc("u1", { role })).toEqual({
        id: "u1",
        grants: [],
      });
    }
  });

  it("carries a section scope through as stored", () => {
    expect(
      principalFromUserDoc("u1", {
        grants: [{ role: "editor", sections: ["news", "arts"] }],
      }).grants,
    ).toEqual([{ role: "editor", sections: ["news", "arts"] }]);
  });

  it("narrows a malformed scope to nothing rather than widening it", () => {
    // Dropping the `sections` key here would turn a broken desk-scoped grant into
    // a site-wide one. It stays present and empty, which lib/rbac.js denies.
    for (const sections of [null, "news", 7, {}, [], [1, 2]]) {
      const [grant] = principalFromUserDoc("u1", {
        grants: [{ role: "editor", sections }],
      }).grants;
      expect(Object.hasOwn(grant, "sections"), String(sections)).toBe(true);
      expect(grant.sections).toEqual([]);
    }
  });

  it("drops a non-string entry from a section list", () => {
    expect(
      principalFromUserDoc("u1", {
        grants: [{ role: "editor", sections: ["news", 7, null, "arts"] }],
      }).grants[0].sections,
    ).toEqual(["news", "arts"]);
  });

  it("distinguishes an omitted scope, which is a site-wide grant", () => {
    const [grant] = principalFromUserDoc("u1", {
      grants: [{ role: "editor" }],
    }).grants;
    expect(Object.hasOwn(grant, "sections")).toBe(false);
  });

  it("strips every grant from a deactivated account", () => {
    expect(
      principalFromUserDoc("u1", {
        active: false,
        role: "super_admin",
        grants: [{ role: "editor" }],
      }),
    ).toEqual({ id: "u1", grants: [] });
  });

  it("returns an identity with no grants when there is no user document", () => {
    for (const doc of [null, undefined, "admin", [], 7]) {
      expect(principalFromUserDoc("u1", doc)).toEqual({
        id: "u1",
        grants: [],
      });
    }
  });

  it("skips a malformed grant entry instead of failing the whole document", () => {
    expect(
      principalFromUserDoc("u1", {
        role: "admin",
        grants: [null, "editor", [], { sections: ["news"] }, { role: "editor" }],
      }).grants,
    ).toEqual([{ role: "admin" }, { role: "editor" }]);
  });

  it("keeps an unknown grant role, which the capability table then denies", () => {
    // Filtering role strings here would put a second, silently diverging role
    // list next to ROLE_CAPABILITIES. Denial belongs in one place.
    expect(
      principalFromUserDoc("u1", { grants: [{ role: "publisher" }] }).grants,
    ).toEqual([{ role: "publisher" }]);
  });

  it("does not accept a top-level role from the grants array", () => {
    for (const role of ["admin", "super_admin"]) {
      expect(
        principalFromUserDoc("u1", { grants: [{ role }] }).grants,
        role,
      ).toEqual([]);
    }
  });
});
