// The stored user document is the only source of authority (#529), so what this
// resolver reads and what it declines to read is the whole trust boundary.
// admin/tests/principal-parity.test.ts separately pins it to the browser copy.

import { describe, expect, it } from "vitest";

import principalPkg from "../../functions/lib/principal.js";
import rbac from "../../functions/lib/rbac.js";

const { principalFromUserDoc, administrativeRoleFromUserDoc } = principalPkg;

describe("principalFromUserDoc", () => {
  it("reads each valid tier on an active account as one unscoped tier grant", () => {
    for (const accessTier of rbac.ACCESS_TIERS) {
      for (const active of [undefined, true]) {
        expect(principalFromUserDoc("u1", { accessTier, active }, true)).toEqual({
          id: "u1",
          grants: [{ role: rbac.TIER_ROLES[accessTier], tier: accessTier }],
        });
      }
    }
  });

  it("names the administrative role only for the admin and owner tiers", () => {
    expect(administrativeRoleFromUserDoc({ accessTier: "owner" }, true)).toBe("super_admin");
    expect(administrativeRoleFromUserDoc({ accessTier: "admin" }, true)).toBe("admin");
    for (const accessTier of ["viewer", "contributor", "editor", "publisher"]) {
      expect(administrativeRoleFromUserDoc({ accessTier }, true), accessTier).toBeNull();
    }
  });

  it("gives no access before the activation receipt exists", () => {
    expect(principalFromUserDoc("u1", { accessTier: "owner" }, false).grants).toEqual([]);
    expect(administrativeRoleFromUserDoc({ accessTier: "owner" }, false)).toBeNull();
  });

  it("strips every grant from a deactivated or malformed-active account", () => {
    for (const active of [false, "true", 1, null]) {
      expect(principalFromUserDoc("u1", { active, accessTier: "owner" }, true)).toEqual({ id: "u1", grants: [] });
    }
  });

  it("gives no access for an invalid tier", () => {
    for (const accessTier of ["", "Owner", "super_admin", "constructor", 7, null]) {
      expect(principalFromUserDoc("u1", { accessTier }, true).grants, String(accessTier)).toEqual([]);
    }
  });

  it("returns an identity with no grants when there is no user document", () => {
    for (const doc of [null, undefined, "admin", [], 7]) {
      expect(principalFromUserDoc("u1", doc, true)).toEqual({ id: "u1", grants: [] });
    }
  });

  it("ignores stored role and grants fields", () => {
    for (const doc of [
      { role: "super_admin" },
      { role: "admin", grants: [{ role: "editor" }] },
      { grants: [{ role: "editor", sections: ["news"] }] },
      { grants: [{ role: "staff", tier: "owner" }] },
    ]) {
      expect(principalFromUserDoc("u1", doc, true).grants).toEqual([]);
      expect(administrativeRoleFromUserDoc(doc, true)).toBeNull();
    }
    expect(principalFromUserDoc("u1", { accessTier: "viewer", role: "super_admin" }, true).grants)
      .toEqual([{ role: "staff", tier: "viewer" }]);
  });
});
