import { describe, expect, it } from "vitest";
import { principalFromUserDoc } from "../src/lib/principal";
import { ACCESS_TIERS, TIER_ROLES, hasCapability } from "../../packages/content-core/src/rbac";

describe("principalFromUserDoc", () => {
  it("maps each valid tier on an active account to one unscoped tier grant", () => {
    for (const accessTier of ACCESS_TIERS) {
      for (const active of [undefined, true]) {
        expect(principalFromUserDoc("u1", { accessTier, active }, true)).toEqual({
          id: "u1",
          grants: [{ role: TIER_ROLES[accessTier], tier: accessTier }],
        });
      }
    }
  });

  it("gives no access without the activation receipt, a document or a valid tier", () => {
    expect(principalFromUserDoc("u1", { accessTier: "owner" }, false).grants).toEqual([]);
    expect(principalFromUserDoc("u1", null, true).grants).toEqual([]);
    expect(principalFromUserDoc("u1", {}, true).grants).toEqual([]);
    for (const accessTier of ["", "Owner", "super_admin", "editor ", 7, null]) {
      expect(principalFromUserDoc("u1", { accessTier }, true).grants).toEqual([]);
    }
  });

  it("gives no access to an inactive or malformed-active account", () => {
    for (const active of [false, "true", 1, null]) {
      expect(principalFromUserDoc("u1", { accessTier: "owner", active: active as never }, true).grants).toEqual([]);
    }
  });

  it("ignores stored role and grants fields", () => {
    const doc = { role: "super_admin", grants: [{ role: "editor" }] } as never;
    expect(principalFromUserDoc("u1", doc, true).grants).toEqual([]);
    const withTier = { accessTier: "viewer", role: "super_admin", grants: [{ role: "editor" }] } as never;
    expect(principalFromUserDoc("u1", withTier, true).grants).toEqual([{ role: "staff", tier: "viewer" }]);
  });
});

// #195: display fields carry no authorization weight.
describe("display fields carry no authorization weight", () => {
  it("does not grant a capability from a jobTitle or byline naming a privileged level", () => {
    const doc = { email: "byline@example.com", displayName: "Pat Contributor", jobTitle: "owner", byline: "admin" };
    const principal = principalFromUserDoc("titled", doc as never, true);
    expect(principal).toEqual({ id: "titled", grants: [] });
    expect(hasCapability(principal, "roles.grant")).toBe(false);
  });

  it("keeps only the id and grants on the resolved principal", () => {
    const doc = { accessTier: "editor", displayName: "Ed Editor", jobTitle: "owner", pronouns: "they/them" };
    const principal = principalFromUserDoc("noisy", doc as never, true);
    expect(principal).toEqual({ id: "noisy", grants: [{ role: "editor", tier: "editor" }] });
    expect(Object.keys(principal).sort()).toEqual(["grants", "id"]);
  });
});
