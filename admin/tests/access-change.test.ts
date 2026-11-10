import { describe, expect, it } from "vitest";
import {
  assessSelfLockout,
  describeAccessChange,
  isNoopAccessChange,
  CAPABILITY_LABELS,
} from "../src/lib/access-change";
import { ALL_CAPABILITIES } from "../../packages/content-core/src/rbac";

describe("CAPABILITY_LABELS", () => {
  it("labels every capability so the impact list can never omit one", () => {
    for (const capability of ALL_CAPABILITIES) {
      expect(CAPABILITY_LABELS[capability]).toBeTruthy();
    }
  });
});

describe("describeAccessChange", () => {
  it("renders the full super admin capability list, including granting roles", () => {
    const impact = describeAccessChange({ action: "grant", role: "super_admin" });

    expect(impact.action).toBe("grant");
    expect(impact.role).toBe("super_admin");
    expect(impact.scope).toBe("site-wide");
    expect(impact.sections).toEqual([]);
    expect(impact.headline).toBe("Grant Site owner");
    expect(impact.capabilities).toContain("grant and revoke staff roles");
    expect(impact.capabilities).toContain("manage site settings");
    // Every capability the model knows about is conferred site-wide.
    expect(impact.capabilities).toHaveLength(ALL_CAPABILITIES.length);
  });

  it("renders admin as a concrete list that stops short of granting roles", () => {
    const impact = describeAccessChange({ action: "grant", role: "admin" });

    expect(impact.headline).toBe("Grant Manager");
    expect(impact.capabilities).toContain("manage staff profiles");
    expect(impact.capabilities).toContain("manage site settings");
    // The escalation guard: admin never confers roles.grant.
    expect(impact.capabilities).not.toContain("grant and revoke staff roles");
  });

  it("scopes an editor grant to only the section-level capabilities", () => {
    const impact = describeAccessChange({
      action: "grant",
      role: "editor",
      sections: ["news", "schedule"],
    });

    expect(impact.scope).toBe("sections");
    expect(impact.sections).toEqual(["news", "schedule"]);
    expect(impact.headline).toBe("Grant Editor in news, schedule");
    expect(impact.capabilities).toContain("publish content");
    // A scoped grant never confers a site-wide administrative capability.
    expect(impact.capabilities).not.toContain("manage site settings");
    expect(impact.capabilities).not.toContain("manage staff profiles");
  });

  it("frames a revoke as the capabilities the change takes away", () => {
    const impact = describeAccessChange({ action: "revoke", role: "admin" });

    expect(impact.action).toBe("revoke");
    expect(impact.headline).toBe("Revoke Manager");
    expect(impact.summary).toContain("Removes the Manager role");
    expect(impact.capabilities).toContain("manage staff profiles");
  });

  it("describes a full role revoke as a site-wide removal", () => {
    const impact = describeAccessChange({ action: "revoke", role: "editor" });

    expect(impact.scope).toBe("site-wide");
    expect(impact.headline).toBe("Revoke Editor");
    expect(impact.capabilities).toContain("publish content");
  });

  it("carries no removals and no replacement for an ordinary grant", () => {
    const impact = describeAccessChange({ action: "grant", role: "admin" });

    expect(impact.replacesRole).toBe(false);
    expect(impact.removedCapabilities).toEqual([]);
  });
});

describe("describeAccessChange top-level replacement", () => {
  it("names the replacement and lists a removed capability when granting admin over a super admin", () => {
    const impact = describeAccessChange(
      { action: "grant", role: "admin" },
      "super_admin",
    );

    expect(impact.replacesRole).toBe(true);
    expect(impact.summary).toContain("Replaces the Site owner role with Manager");
    // super admin holds roles.grant; admin does not, so the demotion removes it.
    // The label is whatever hasCapability actually yields for the two principals.
    expect(impact.removedCapabilities).toContain("grant and revoke staff roles");
    // The requested role confers nothing the target did not already hold.
    expect(impact.capabilities).not.toContain("grant and revoke staff roles");
  });

  it("treats granting super admin over an admin as a pure gain with no removal section", () => {
    const impact = describeAccessChange(
      { action: "grant", role: "super_admin" },
      "admin",
    );

    expect(impact.replacesRole).toBe(false);
    expect(impact.removedCapabilities).toEqual([]);
    expect(impact.summary).not.toContain("Replaces");
    // The full-list phrasing is kept, including the capability the change adds.
    expect(impact.capabilities).toContain("grant and revoke staff roles");
  });

  it("leaves a scoped grant on a user with a top-level role unchanged", () => {
    const impact = describeAccessChange(
      { action: "grant", role: "editor", sections: ["news"] },
      "admin",
    );

    expect(impact.replacesRole).toBe(false);
    expect(impact.removedCapabilities).toEqual([]);
    expect(impact.scope).toBe("sections");
    expect(impact.summary).not.toContain("Replaces");
    expect(impact.capabilities).toContain("publish content");
    // A scoped grant never reports a global administrative capability.
    expect(impact.capabilities).not.toContain("manage site settings");
  });

  it("treats granting admin to an account with no top-level role as a pure gain", () => {
    const impact = describeAccessChange({ action: "grant", role: "admin" }, null);

    expect(impact.replacesRole).toBe(false);
    expect(impact.removedCapabilities).toEqual([]);
    expect(impact.capabilities).toContain("manage staff profiles");
  });

  it("does not report a replacement when the requested top-level role matches the current one", () => {
    const impact = describeAccessChange(
      { action: "grant", role: "admin" },
      "admin",
    );

    expect(impact.replacesRole).toBe(false);
    expect(impact.removedCapabilities).toEqual([]);
  });
});

describe("assessSelfLockout", () => {
  const other = {
    actingUserId: "me",
    targetUserId: "someone-else",
    superAdminCount: 1,
  };

  it("allows any change to another account", () => {
    expect(
      assessSelfLockout({
        ...other,
        change: { action: "revoke", role: "super_admin" },
      }).severity,
    ).toBe("ok");
    expect(
      assessSelfLockout({
        ...other,
        change: { action: "grant", role: "admin" },
      }).severity,
    ).toBe("ok");
  });

  it("allows the change when the acting user is unknown (no self to protect)", () => {
    expect(
      assessSelfLockout({
        actingUserId: undefined,
        targetUserId: "me",
        superAdminCount: 1,
        change: { action: "revoke", role: "super_admin" },
      }).severity,
    ).toBe("ok");
  });

  it("blocks revoking your own super admin and names the recovery path when you are the last one", () => {
    const verdict = assessSelfLockout({
      actingUserId: "me",
      targetUserId: "me",
      superAdminCount: 1,
      change: { action: "revoke", role: "super_admin" },
    });

    expect(verdict.severity).toBe("blocked");
    if (verdict.severity === "blocked") {
      expect(verdict.reason).toContain("only Site owner");
      expect(verdict.reason).toContain("another");
    }
  });

  it("still blocks revoking your own super admin when other super admins remain", () => {
    const verdict = assessSelfLockout({
      actingUserId: "me",
      targetUserId: "me",
      superAdminCount: 2,
      change: { action: "revoke", role: "super_admin" },
    });

    expect(verdict.severity).toBe("blocked");
    if (verdict.severity === "blocked") {
      // Not the last-one message: another Site owner can restore access.
      expect(verdict.reason).not.toContain("only Site owner");
      expect(verdict.reason).toContain("another Site owner");
    }
  });

  it("blocks revoking any of your own roles, matching the server", () => {
    const verdict = assessSelfLockout({
      actingUserId: "me",
      targetUserId: "me",
      superAdminCount: 3,
      change: { action: "revoke", role: "editor", sections: ["news"] },
    });

    expect(verdict.severity).toBe("blocked");
  });

  it("blocks granting yourself a top-level role, matching the server", () => {
    expect(
      assessSelfLockout({
        actingUserId: "me",
        targetUserId: "me",
        superAdminCount: 2,
        change: { action: "grant", role: "admin" },
      }).severity,
    ).toBe("blocked");
    expect(
      assessSelfLockout({
        actingUserId: "me",
        targetUserId: "me",
        superAdminCount: 2,
        change: { action: "grant", role: "super_admin" },
      }).severity,
    ).toBe("blocked");
  });

  it("allows granting yourself a scoped role, which the server permits", () => {
    expect(
      assessSelfLockout({
        actingUserId: "me",
        targetUserId: "me",
        superAdminCount: 1,
        change: { action: "grant", role: "editor", sections: ["news"] },
      }).severity,
    ).toBe("ok");
  });

  it("blocks self-demotion via a grant that would replace your own super admin role", () => {
    // Granting yourself admin while you hold super admin is a demotion that overwrites
    // your top-level role. The server refuses it ("Cannot change your own top-level
    // role"), and the same top-level-role guard catches the grant-replacement route on
    // the client, so a last super admin cannot demote themselves out of role management.
    const verdict = assessSelfLockout({
      actingUserId: "me",
      targetUserId: "me",
      superAdminCount: 1,
      change: { action: "grant", role: "admin" },
    });

    expect(verdict.severity).toBe("blocked");
    if (verdict.severity === "blocked") {
      expect(verdict.reason).toContain("your own top-level role");
    }
  });
});

// Every case here is a confirmation opened against a row that has since gone stale, which
// is the only way the client and the server disagree about what a change would do.
describe("isNoopAccessChange", () => {
  it("treats a re-grant of the role already held as a no-op", () => {
    expect(isNoopAccessChange({ action: "grant", role: "admin" }, "admin")).toBe(true);
  });

  it("treats a revoke of a top-level role the target does not hold as a no-op", () => {
    // The open confirmation says "Revoke Manager" but another Site owner has since
    // promoted them, so functions/roles.js answers 409 "Target does not hold the
    // specified top-level role" rather than clearing the role they do hold.
    expect(isNoopAccessChange({ action: "revoke", role: "admin" }, "super_admin")).toBe(
      true,
    );
    // Same shape, no top-level role at all.
    expect(isNoopAccessChange({ action: "revoke", role: "admin" }, null)).toBe(true);
  });

  it("keeps a revoke of the top-level role actually held", () => {
    expect(isNoopAccessChange({ action: "revoke", role: "admin" }, "admin")).toBe(false);
  });

  it("treats a full-role revoke with no matching grants as a no-op", () => {
    // Revoking editor from someone who only holds contributor filters an array with
    // nothing to filter: the server answers 200 having changed nothing.
    expect(
      isNoopAccessChange({ action: "revoke", role: "editor" }, null, [
        { role: "contributor", sections: ["news"] },
      ]),
    ).toBe(true);
  });

  it("keeps a full-role revoke that has grants to remove", () => {
    expect(
      isNoopAccessChange({ action: "revoke", role: "editor" }, null, [
        { role: "editor", sections: ["news"] },
      ]),
    ).toBe(false);
  });

  it("does not call a scoped revoke a no-op, since the server answers it explicitly", () => {
    expect(
      isNoopAccessChange({ action: "revoke", role: "editor", sections: ["news"] }, null, []),
    ).toBe(false);
  });
});

describe("describeAccessChange scope for full-role revokes", () => {
  it("describes a full-role revoke by the sections the target actually holds", () => {
    // No areas on the change is how the server is asked to remove every grant for the
    // role, not a claim of site-wide reach. Saying "across the whole site" here would
    // promise more than functions/roles.js does to someone who only holds editor in news.
    const impact = describeAccessChange({ action: "revoke", role: "editor" }, null, [
      { role: "editor", sections: ["news"] },
      { role: "contributor", sections: ["sports"] },
    ]);

    expect(impact.scope).toBe("sections");
    expect(impact.sections).toEqual(["news"]);
    expect(impact.summary).toContain("in news");
    expect(impact.summary).not.toContain("across the whole site");
    expect(impact.headline).toBe("Revoke Editor in news");
  });

  it("unions the sections across several grants of the same role", () => {
    const impact = describeAccessChange({ action: "revoke", role: "editor" }, null, [
      { role: "editor", sections: ["news"] },
      { role: "editor", sections: ["sports", "news"] },
    ]);

    expect(impact.sections).toEqual(["news", "sports"]);
  });

  it("still says site-wide when the target holds an unscoped grant for the role", () => {
    const impact = describeAccessChange({ action: "revoke", role: "editor" }, null, [
      { role: "editor" },
      { role: "editor", sections: ["news"] },
    ]);

    expect(impact.scope).toBe("site-wide");
    expect(impact.summary).toContain("across the whole site");
  });

  it("falls back to site-wide phrasing when no grants are supplied", () => {
    // The presentational component and the design gallery render without a grants list,
    // so the absence of grants must not be read as "holds nothing".
    const impact = describeAccessChange({ action: "revoke", role: "editor" });

    expect(impact.scope).toBe("site-wide");
    expect(impact.summary).toContain("across the whole site");
  });
});
