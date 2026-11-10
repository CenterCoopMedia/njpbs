import { describe, it, expect } from "vitest";
import {
  ALL_CAPABILITIES,
  ROLE_CAPABILITIES,
  can,
  canEditContent,
  capabilitiesForRole,
  hasCapability,
  withRegisteredMediaSections,
  type Capability,
  type Principal,
  type Role,
} from "../../packages/content-core/src/rbac";

const ROLES: Role[] = ["super_admin", "admin", "editor", "contributor", "staff"];

describe("registered media scopes", () => {
  it("denies unresolved scoped media until a registered area is resolved", () => {
    const stored: Principal = { grants: [{ role: "editor", sections: ["news"] }] };
    const resolved = withRegisteredMediaSections(stored, new Set(["news"]));
    for (const capability of ["media.audio.read", "media.video.read", "media.video.manage", "media.upload", "media.manage"] as const) {
      expect(hasCapability(stored, capability)).toBe(false);
      expect(can(stored, capability, { section: "general" })).toBe(false);
      expect(hasCapability(resolved, capability)).toBe(true);
      expect(can(resolved, capability, { section: "general" })).toBe(true);
    }
  });

  it.each([
    ["registered", ["current-area"], true],
    ["retired", ["retired-area"], false],
    ["mixed", ["retired-area", "current-area"], true],
  ] as const)("resolves %s grants before granting site-wide media", (_name, sections, allowed) => {
    const stored: Principal = { id: "editor-1", grants: [{ role: "editor", sections }] };
    const actor = withRegisteredMediaSections(stored, new Set(["current-area"]));
    for (const capability of ["media.audio.read", "media.video.read", "media.video.manage", "media.upload", "media.manage"] as const) {
      expect(hasCapability(actor, capability)).toBe(allowed);
      expect(can(actor, capability, { section: "general" })).toBe(allowed);
    }
    expect(stored.grants[0].sections).toEqual(sections);
    expect(actor.grants[0].sections).toEqual(sections);
    expect(actor.grants[0].registeredMediaSections).toEqual(allowed ? ["current-area"] : []);
    for (const section of sections) expect(can(actor, "content.edit.any", { section })).toBe(true);
  });

  it("preserves intentional site-wide grants when the registry is empty", () => {
    const actor = withRegisteredMediaSections({ grants: [{ role: "admin" }] }, new Set());
    expect(can(actor, "media.manage")).toBe(true);
    expect(can(actor, "profiles.manage")).toBe(true);
  });
});

/** A principal holding a single unscoped grant of the given role. */
function as(role: Role, id?: string): Principal {
  return { id, grants: [{ role }] };
}

describe("ROLE_CAPABILITIES mapping (the data)", () => {
  it("resolves every role to a capability set", () => {
    for (const role of ROLES) {
      expect(Array.isArray(capabilitiesForRole(role))).toBe(true);
    }
  });

  it("holds no capability outside the declared Capability union", () => {
    const known = new Set<Capability>(ALL_CAPABILITIES);
    for (const role of ROLES) {
      for (const cap of ROLE_CAPABILITIES[role]) {
        expect(known.has(cap)).toBe(true);
      }
    }
  });

  it("lists no capability twice within a role", () => {
    for (const role of ROLES) {
      const caps = ROLE_CAPABILITIES[role];
      expect(new Set(caps).size).toBe(caps.length);
    }
  });
});

describe("super_admin is the break-glass everything tier", () => {
  it("holds every capability", () => {
    for (const cap of ALL_CAPABILITIES) {
      expect(hasCapability(as("super_admin"), cap)).toBe(true);
    }
  });
});

describe("escalation guards", () => {
  it("grants roles.grant only to super_admin", () => {
    expect(hasCapability(as("super_admin"), "roles.grant")).toBe(true);
    for (const role of ["admin", "editor", "contributor", "staff"] as Role[]) {
      expect(hasCapability(as(role), "roles.grant")).toBe(false);
    }
  });

  it("stops users.manage at admin (not editor or contributor)", () => {
    expect(hasCapability(as("admin"), "users.manage")).toBe(true);
    expect(hasCapability(as("super_admin"), "users.manage")).toBe(true);
    expect(hasCapability(as("editor"), "users.manage")).toBe(false);
    expect(hasCapability(as("contributor"), "users.manage")).toBe(false);
  });

  it("keeps content.delete out of editor and contributor", () => {
    expect(hasCapability(as("admin"), "content.delete")).toBe(true);
    expect(hasCapability(as("editor"), "content.delete")).toBe(false);
    expect(hasCapability(as("contributor"), "content.delete")).toBe(false);
  });

  it("grants audit viewing only to the two administrative roles", () => {
    expect(hasCapability(as("super_admin"), "audit.view")).toBe(true);
    expect(hasCapability(as("admin"), "audit.view")).toBe(true);
    expect(hasCapability(as("editor"), "audit.view")).toBe(false);
    expect(hasCapability(as("contributor"), "audit.view")).toBe(false);
  });
});

describe("role intents", () => {
  it("lets a contributor draft own content but not publish or manage media", () => {
    expect(hasCapability(as("contributor"), "content.create")).toBe(true);
    expect(hasCapability(as("contributor"), "content.edit.own")).toBe(true);
    expect(hasCapability(as("contributor"), "content.publish")).toBe(false);
    expect(hasCapability(as("contributor"), "content.edit.any")).toBe(false);
    expect(hasCapability(as("contributor"), "media.audio.read")).toBe(true);
    expect(hasCapability(as("contributor"), "media.manage")).toBe(false);
  });

  it("lets organization staff read the guide, media and own reports without content write authority", () => {
    expect(hasCapability(as("staff"), "guide.view")).toBe(true);
    expect(hasCapability(as("staff"), "media.audio.read")).toBe(true);
    expect(hasCapability(as("staff"), "reports.view")).toBe(true);
    for (const capability of ALL_CAPABILITIES) {
      if (capability === "guide.view" || capability === "media.audio.read" || capability === "media.video.read" || capability === "reports.view") continue;
      expect(hasCapability(as("staff"), capability)).toBe(false);
    }
  });

  it("lets an editor publish and manage media but not administer users or settings", () => {
    expect(hasCapability(as("editor"), "content.publish")).toBe(true);
    expect(hasCapability(as("editor"), "media.manage")).toBe(true);
    expect(hasCapability(as("editor"), "settings.manage")).toBe(false);
    expect(hasCapability(as("editor"), "users.view")).toBe(false);
  });
});

describe("deny by default", () => {
  it("denies a capability no grant lists", () => {
    // capability-level: no resource, still denied because the role lacks it.
    expect(can(as("contributor"), "content.publish")).toBe(false);
    expect(can(as("editor"), "roles.grant")).toBe(false);
  });

  it("denies a principal with no grants at all", () => {
    expect(can({ grants: [] }, "content.create")).toBe(false);
    expect(hasCapability({ grants: [] }, "content.create")).toBe(false);
  });

  it("denies an unknown role even if asked at runtime", () => {
    const bogus: Principal = { grants: [{ role: "root" as unknown as Role }] };
    expect(hasCapability(bogus, "content.create")).toBe(false);
    expect(can(bogus, "content.create")).toBe(false);
  });

  it("denies a role naming an inherited Object property without throwing", () => {
    // A migrated or malformed document could carry role: "constructor" / "toString" /
    // "__proto__". Indexing the capability table with one used to return a prototype
    // member and throw on .includes(); the own-property guard denies by default and
    // never throws, so a bad record cannot 500 every authorization check.
    for (const poisoned of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const role = poisoned as unknown as Role;
      const bogus: Principal = { grants: [{ role }] };
      expect(capabilitiesForRole(role)).toEqual([]);
      expect(hasCapability(bogus, "content.create")).toBe(false);
      expect(can(bogus, "content.create")).toBe(false);
    }
  });
});

describe("capability scope classification (no silent drift)", () => {
  it("confers area powers and site-wide media while withholding administration", () => {
    // The section/global split is derived from one metadata table, so a new capability
    // cannot be granted to unscoped users while silently denied to desk-scoped ones.
    // Assert it through the public API: a section-scoped super_admin holds every role
    // capability, so which capabilities it exercises partitions area, media and administrative
    // powers. No internal list is referenced.
    const scopedSuper = withRegisteredMediaSections({
      id: "s1",
      grants: [{ role: "super_admin", sections: ["news"] }],
    }, new Set(["news"]));
    const section: Capability[] = [
      "guide.view",
      "content.create",
      "content.edit.own",
      "content.edit.any",
      "content.publish",
      "content.unpublish",
      "content.delete",
      "reports.view",
      "schedule.manage",
    ];
    const media: Capability[] = [
      "media.audio.read",
      "media.video.read",
      "media.video.manage",
      "media.upload",
      "media.manage",
    ];
    const global: Capability[] = [
      "datasets.approve",
      "content.view",
      "media.image.read",
      "analytics.view",
      "profiles.manage",
      "submissions.review",
      "members.view",
      "settings.manage",
      "users.view",
      "users.manage",
      "audit.view",
      "roles.grant",
    ];
    // The three lists must partition every capability; if a capability is added and left
    // out of them, this fails, so the classification cannot drift silently.
    expect([...section, ...media, ...global].sort()).toEqual([...ALL_CAPABILITIES].sort());
    for (const c of section) expect(hasCapability(scopedSuper, c)).toBe(true);
    for (const c of media) {
      expect(hasCapability(scopedSuper, c)).toBe(true);
      expect(can(scopedSuper, c, { section: "general" })).toBe(true);
    }
    for (const c of global) expect(hasCapability(scopedSuper, c)).toBe(false);
  });
});

describe("content.edit.own ownership", () => {
  const author = as("contributor", "u1");

  it("allows editing a record the principal owns", () => {
    expect(can(author, "content.edit.own", { ownerId: "u1" })).toBe(true);
    expect(canEditContent(author, { ownerId: "u1" })).toBe(true);
  });

  it("denies editing a record owned by someone else", () => {
    expect(can(author, "content.edit.own", { ownerId: "u2" })).toBe(false);
    expect(canEditContent(author, { ownerId: "u2" })).toBe(false);
  });

  it("denies when ownership cannot be established (missing ids or resource)", () => {
    expect(can(author, "content.edit.own")).toBe(false);
    expect(can(author, "content.edit.own", {})).toBe(false);
    expect(can(as("contributor"), "content.edit.own", { ownerId: "u1" })).toBe(false);
  });

  it("lets an unscoped owner edit their record in any section", () => {
    expect(can(author, "content.edit.own", { ownerId: "u1", section: "arts" })).toBe(true);
  });
});

describe("content.edit.any", () => {
  it("lets an editor edit content they do not own", () => {
    const editor = as("editor", "e1");
    expect(can(editor, "content.edit.any", { ownerId: "someone-else" })).toBe(true);
    expect(canEditContent(editor, { ownerId: "someone-else" })).toBe(true);
  });
});

describe("section scope", () => {
  const newsEditor: Principal = { id: "e1", grants: [{ role: "editor", sections: ["news"] }] };

  it("keeps read-only audio site-wide for a valid area grant", () => {
    const newsStaff = withRegisteredMediaSections(
      { id: "s1", grants: [{ role: "staff", sections: ["news"] }] }, new Set(["news"]),
    );
    expect(can(newsStaff, "media.audio.read", { section: "news" })).toBe(true);
    expect(can(newsStaff, "media.audio.read", { section: "arts" })).toBe(true);
    expect(can(newsStaff, "media.upload", { section: "news" })).toBe(false);
    expect(can(newsStaff, "media.manage", { section: "news" })).toBe(false);
  });

  it("confines a scoped grant to its sections for a section-scoped capability", () => {
    expect(can(newsEditor, "content.publish", { section: "news" })).toBe(true);
    expect(can(newsEditor, "content.publish", { section: "arts" })).toBe(false);
  });

  it("denies a scoped grant when the resource section is unstated, including create", () => {
    // Deny by default: without a section we cannot confirm scope. This is the
    // create-without-a-section hole -- a scoped editor cannot create in any section
    // by omitting one.
    expect(can(newsEditor, "content.publish", {})).toBe(false);
    expect(can(newsEditor, "content.create")).toBe(false);
    expect(can(newsEditor, "content.create", { section: "news" })).toBe(true);
    expect(can(newsEditor, "content.create", { section: "arts" })).toBe(false);
  });

  it("does not gate a genuinely unscoped grant (no sections field) by section", () => {
    const anyEditor = as("editor", "e1"); // no sections -> intentional site-wide grant
    expect(can(anyEditor, "content.publish", { section: "arts" })).toBe(true);
  });

  it("treats an empty sections list as scoped-to-nothing, not site-wide", () => {
    // A malformed "no desks selected" serialized as [] must not widen into full-site
    // authority. It confers nothing, and hasCapability agrees.
    const emptyScope: Principal = { id: "e1", grants: [{ role: "editor", sections: [] }] };
    expect(can(emptyScope, "content.publish", { section: "arts" })).toBe(false);
    expect(can(emptyScope, "content.publish", { section: "news" })).toBe(false);
    expect(hasCapability(emptyScope, "content.publish")).toBe(false);
  });

  it("treats a null or non-array sections value as scoped-to-nothing, not site-wide", () => {
    // Only an omitted field means site-wide. A migrated document could carry
    // sections: null; a present-but-not-an-array scope must confer nothing.
    const nullScope = {
      id: "e1",
      grants: [{ role: "editor", sections: null }],
    } as unknown as Principal;
    expect(can(nullScope, "content.publish", { section: "news" })).toBe(false);
    expect(hasCapability(nullScope, "content.publish")).toBe(false);
  });

  it("confines content.edit.own to the scoped grant's sections (scope beats ownership)", () => {
    // A scoped grant applies only within its sections, even for a record you own, so a
    // record moved to another desk falls outside the grant.
    expect(can(newsEditor, "content.edit.own", { ownerId: "e1", section: "news" })).toBe(true);
    expect(can(newsEditor, "content.edit.own", { ownerId: "e1", section: "arts" })).toBe(false);
    expect(can(newsEditor, "content.edit.own", { ownerId: "e1" })).toBe(false);
  });

  it("answers the capability-level question with hasCapability, not a resource-less can()", () => {
    // "could this scoped editor ever publish?" is yes via hasCapability; the
    // resource-level can() denies without a section, by design.
    expect(hasCapability(newsEditor, "content.publish")).toBe(true);
    expect(can(newsEditor, "content.publish")).toBe(false);
  });
});

describe("mixed grants (a user with more than one assignment)", () => {
  // Site-wide admin who is also the news-desk editor. The two grants do not bleed:
  // the admin grant is unscoped, the editor grant is scoped to news.
  const adminPlusNewsEditor: Principal = {
    id: "u9",
    grants: [{ role: "admin" }, { role: "editor", sections: ["news"] }],
  };

  it("authorizes an admin capability site-wide via the unscoped admin grant", () => {
    expect(can(adminPlusNewsEditor, "content.delete", { section: "arts" })).toBe(true);
    expect(can(adminPlusNewsEditor, "settings.manage")).toBe(true);
  });

  it("still authorizes editor work in the scoped section", () => {
    expect(can(adminPlusNewsEditor, "content.publish", { section: "news" })).toBe(true);
  });

  it("denies a capability that no held role grants", () => {
    expect(can(adminPlusNewsEditor, "roles.grant")).toBe(false);
  });

  // A user who is ONLY a section editor cannot act outside the desk -- the case the
  // single-role-plus-sections shape could not represent alongside a site-wide role.
  const newsOnly: Principal = { id: "u10", grants: [{ role: "editor", sections: ["news"] }] };

  it("confines a section-only editor to the desk", () => {
    expect(can(newsOnly, "content.publish", { section: "news" })).toBe(true);
    expect(can(newsOnly, "content.publish", { section: "education" })).toBe(false);
    expect(can(newsOnly, "content.delete", { section: "news" })).toBe(false);
  });
});

describe("a scoped grant does not confer global capabilities", () => {
  // A desk-scoped admin. Scoping an administrative role to a section must not hand out
  // site-wide administration; those capabilities need an unscoped grant.
  const newsAdmin: Principal = { id: "a1", grants: [{ role: "admin", sections: ["news"] }] };

  it("confers the admin's section-scoped capabilities only within the desk", () => {
    expect(can(newsAdmin, "content.delete", { section: "news" })).toBe(true);
    expect(can(newsAdmin, "content.delete", { section: "arts" })).toBe(false);
  });

  it("does not confer global capabilities, even inside the desk", () => {
    expect(can(newsAdmin, "settings.manage")).toBe(false);
    expect(can(newsAdmin, "settings.manage", { section: "news" })).toBe(false);
    expect(can(newsAdmin, "users.manage", { section: "news" })).toBe(false);
    expect(can(newsAdmin, "members.view", { section: "news" })).toBe(false);
  });

  it("reports global capabilities as not held via hasCapability, so UI gating agrees with can()", () => {
    // hasCapability drives show/hide of controls; it must not promise a global power a
    // scoped grant will never authorize.
    expect(hasCapability(newsAdmin, "users.manage")).toBe(false);
    expect(hasCapability(newsAdmin, "settings.manage")).toBe(false);
    // but it does report the section-scopable capabilities the desk admin can use.
    expect(hasCapability(newsAdmin, "content.delete")).toBe(true);
  });
});

describe("role-template capability prerequisites (#2748)", () => {
  it.each([
    ["analytics.view", ["admin", "super_admin"]],
    ["reports.view", ["staff", "contributor", "editor", "admin", "super_admin"]],
    ["profiles.manage", ["admin", "super_admin"]],
    ["media.video.read", ["staff", "contributor", "editor", "admin", "super_admin"]],
    ["media.video.manage", ["editor", "admin", "super_admin"]],
    ["submissions.review", ["editor", "admin", "super_admin"]],
  ] as const)("preserves existing built-in access to %s", (capability, holders) => {
    for (const role of ROLES) {
      expect(hasCapability(as(role), capability)).toBe((holders as readonly Role[]).includes(role));
    }
    expect(can({ grants: [] }, capability)).toBe(false);
  });

  it("keeps site-wide reports and profiles separate from settings and accounts", () => {
    const scoped: Principal = { grants: [{ role: "admin", sections: ["watch"] }] };
    expect(hasCapability(scoped, "reports.view")).toBe(true);
    for (const capability of ["analytics.view", "profiles.manage", "submissions.review"] as const) {
      expect(can(scoped, capability, { section: "watch" })).toBe(false);
      expect(hasCapability(scoped, capability)).toBe(false);
    }
  });
});

describe("site-wide media with area-limited content (#2749)", () => {
  const watchEditor = withRegisteredMediaSections(
    { grants: [{ role: "editor", sections: ["watch"] }] }, new Set(["watch"]),
  );
  it.each(["general", "staff-profile"])("permits upload and management in %s", (category) => {
    expect(can(watchEditor, "media.upload", { section: category })).toBe(true);
    expect(can(watchEditor, "media.manage", { section: category })).toBe(true);
    expect(can(watchEditor, "media.video.manage")).toBe(true);
    expect(can(as("staff"), "media.upload", { section: category })).toBe(false);
    expect(can(as("staff"), "media.manage", { section: category })).toBe(false);
  });
  it("keeps missing and malformed area grants closed even for media", () => {
    for (const sections of [[], null, "watch", [null], [7], [""]]) {
      const principal = { grants: [{ role: "editor", sections }] } as unknown as Principal;
      expect(can(principal, "media.upload")).toBe(false);
      expect(hasCapability(principal, "media.manage")).toBe(false);
    }
  });
  it("does not infer News for a document without an area or widen content publishing", () => {
    const newsroom: Principal = { grants: [{ role: "editor", sections: ["news"] }] };
    expect(can(newsroom, "content.publish", { section: "news" })).toBe(true);
    expect(can(newsroom, "content.publish", {})).toBe(false);
    expect(can(watchEditor, "content.publish", { section: "news" })).toBe(false);
    expect(can({ id: "writer", grants: [{ role: "contributor", sections: ["news"] }] }, "content.publish", { section: "news" })).toBe(false);
  });
});
