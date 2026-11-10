import { describe, expect, it } from "vitest";
import { principalFromUserDoc } from "../src/lib/principal";
import { can, hasCapability } from "../../packages/content-core/src/rbac";

describe("principalFromUserDoc", () => {
  it("maps a super admin document to an unscoped grant", () => {
    expect(
      principalFromUserDoc("u1", {
        email: "super@example.com",
        role: "super_admin",
        grants: [],
      }),
    ).toEqual({
      id: "u1",
      grants: [{ role: "super_admin" }],
    });
  });

  it("keeps a top-level admin grant beside scoped grants", () => {
    expect(
      principalFromUserDoc("u2", {
        email: "admin@example.com",
        role: "admin",
        grants: [{ role: "editor", sections: ["news"] }],
      }),
    ).toEqual({
      id: "u2",
      grants: [
        { role: "admin" },
        { role: "editor", sections: ["news"] },
      ],
    });
  });

  it("returns zero grants for a missing document or empty profile", () => {
    expect(principalFromUserDoc("missing", null)).toEqual({
      id: "missing",
      grants: [],
    });
    expect(
      principalFromUserDoc("empty", {
        email: "empty@example.com",
        role: null,
        grants: [],
      }),
    ).toEqual({
      id: "empty",
      grants: [],
    });
  });

  it("treats malformed grants as empty", () => {
    expect(
      principalFromUserDoc("bad", {
        email: "bad@example.com",
        role: null,
        grants: "editor",
      }),
    ).toEqual({
      id: "bad",
      grants: [],
    });
  });

  it("drops malformed entries before capability checks", () => {
    const principal = principalFromUserDoc("mixed", {
      email: "mixed@example.com",
      role: null,
      grants: [null, { role: "editor", sections: ["news"] }],
    });

    expect(() => hasCapability(principal, "content.publish")).not.toThrow();
    expect(hasCapability(principal, "content.publish")).toBe(true);
    expect(principal).toEqual({
      id: "mixed",
      grants: [{ role: "editor", sections: ["news"] }],
    });
  });

  it("preserves omitted sections as a site-wide grant", () => {
    const principal = principalFromUserDoc("sitewide", {
      email: "sitewide@example.com",
      role: null,
      grants: [{ role: "editor" }],
    });

    expect(principal).toEqual({
      id: "sitewide",
      grants: [{ role: "editor" }],
    });
    expect(Object.hasOwn(principal.grants[0], "sections")).toBe(false);
    expect(hasCapability(principal, "content.publish")).toBe(true);
    expect(can(principal, "content.publish", { section: "news" })).toBe(true);
  });

  it("keeps null sections scoped to nothing", () => {
    const principal = principalFromUserDoc("null-sections", {
      email: "null-sections@example.com",
      role: null,
      grants: [{ role: "editor", sections: null }],
    });

    expect(principal).toEqual({
      id: "null-sections",
      grants: [{ role: "editor", sections: [] }],
    });
    expect(hasCapability(principal, "content.publish")).toBe(false);
    expect(can(principal, "content.publish", { section: "news" })).toBe(false);
  });

  it("drops grants without string roles and coerces malformed sections", () => {
    expect(
      principalFromUserDoc("coerced", {
        email: "coerced@example.com",
        role: null,
        grants: [
          { role: 7, sections: ["news"] },
          { role: "contributor", sections: "news" },
          { role: "editor", sections: ["news", 7, "arts"] },
        ],
      }),
    ).toEqual({
      id: "coerced",
      grants: [
        { role: "contributor", sections: [] },
        { role: "editor", sections: ["news", "arts"] },
      ],
    });
  });
});

// #195: the display jobTitle (and any other profile display field) carries no
// authorization weight. Authorization derives only from the auth-bearing role and
// grants fields; a display string can neither grant a capability nor alter an
// existing grant. These assemble the document as a variable so an extra jobTitle or
// byline field models the dynamically shaped Firestore document the resolver receives.
describe("display fields carry no authorization weight", () => {
  it("does not grant a capability from a jobTitle or byline naming a privileged role", () => {
    const withPrivilegedTitle = {
      email: "byline@example.com",
      role: null,
      grants: [],
      displayName: "Pat Contributor",
      jobTitle: "super_admin",
      byline: "Managing editor",
    };

    const principal = principalFromUserDoc("titled", withPrivilegedTitle);

    expect(principal).toEqual({ id: "titled", grants: [] });
    expect(hasCapability(principal, "users.manage")).toBe(false);
    expect(hasCapability(principal, "roles.grant")).toBe(false);
    expect(can(principal, "content.publish", { section: "news" })).toBe(false);
  });

  it("does not let a jobTitle downgrade or override the auth-bearing role", () => {
    const adminWithLesserTitle = {
      email: "admin2@example.com",
      role: "admin" as const,
      grants: [],
      jobTitle: "contributor",
    };

    const principal = principalFromUserDoc("admin2", adminWithLesserTitle);

    // The admin tier from `role` stands; the "contributor" jobTitle changes nothing.
    expect(principal).toEqual({ id: "admin2", grants: [{ role: "admin" }] });
    expect(hasCapability(principal, "users.manage")).toBe(true);
  });

  it("ignores arbitrary display fields entirely, keeping only role and grants", () => {
    const noisyDoc = {
      email: "noisy@example.com",
      role: null,
      grants: [{ role: "editor", sections: ["news"] }],
      displayName: "Ed Editor",
      jobTitle: "Newsroom lead",
      byline: "By Ed Editor",
      pronouns: "they/them",
    };

    const principal = principalFromUserDoc("noisy", noisyDoc);

    expect(principal).toEqual({
      id: "noisy",
      grants: [{ role: "editor", sections: ["news"] }],
    });
    // None of the display keys leak onto the resolved principal.
    expect(Object.keys(principal).sort()).toEqual(["grants", "id"]);
  });
});
