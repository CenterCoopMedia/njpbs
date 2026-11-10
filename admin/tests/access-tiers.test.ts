import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { eligibleNavDestinations } from "../src/lib/nav-destinations";
import { principalFromUserDoc, type CmsUserDoc } from "../src/lib/principal";
import {
  ACCESS_TIERS, TIER_CAPABILITIES, can, hasCapability, type AccessTier,
} from "../../packages/content-core/src/rbac";

const require = createRequire(import.meta.url);
const server = require("../../functions/lib/principal.js");
const rbac = require("../../functions/lib/rbac.js");
const content = require("../../functions/lib/content-authorization.js");
const actor = (accessTier: AccessTier) => principalFromUserDoc("writer", { accessTier }, true);

describe("the six whole-site access levels (#2747, October 13)", () => {
  it("ignores a planted tier until server-only activation evidence is supplied", () => {
    const plantedOwner = { accessTier: "owner", grants: [{ role: "staff" }] } as CmsUserDoc;
    const plantedDemotion = { accessTier: "viewer", role: "super_admin" } as CmsUserDoc;
    for (const doc of [plantedOwner, plantedDemotion]) {
      const legacy = { ...doc };
      delete legacy.accessTier;
      expect(principalFromUserDoc("fixture", doc)).toEqual(principalFromUserDoc("fixture", legacy));
      expect(server.principalFromUserDoc("fixture", doc)).toEqual(server.principalFromUserDoc("fixture", legacy));
    }
    expect(hasCapability(principalFromUserDoc("fixture", plantedOwner), "roles.grant")).toBe(false);
    expect(hasCapability(principalFromUserDoc("fixture", plantedDemotion), "roles.grant")).toBe(true);
  });

  it("uses the confirmed order and includes every lower level", () => {
    expect(ACCESS_TIERS).toEqual(["viewer", "contributor", "editor", "publisher", "admin", "owner"]);
    for (let index = 1; index < ACCESS_TIERS.length; index++) {
      for (const capability of TIER_CAPABILITIES[ACCESS_TIERS[index - 1]]) {
        expect(hasCapability(actor(ACCESS_TIERS[index]), capability)).toBe(true);
      }
    }
  });

  it("lets a Viewer read another person's content without a write, preview-save or lock grant", () => {
    const viewer = actor("viewer");
    expect(content.authorizeContentRead(viewer, { exists: true, resource: { ownerId: "other", section: "news" } }).allowed).toBe(true);
    expect(content.mayReachContentWrite(viewer)).toBe(false);
    expect(content.authorizeContentWrite(viewer, { creating: false, publishing: false,
      storedStatus: "draft", nextStatus: "draft", resource: { ownerId: "other", section: "news" } }).allowed).toBe(false);
    for (const capability of ["content.create", "content.publish", "content.delete", "media.upload", "media.manage", "users.manage", "roles.grant"] as const) {
      expect(hasCapability(viewer, capability)).toBe(false);
    }
  });

  it("gives Contributors whole-site own drafts and media upload and management", () => {
    const contributor = actor("contributor");
    for (const section of ["watch", "news", "station"]) {
      expect(can(contributor, "content.edit.own", { ownerId: "writer", section })).toBe(true);
      expect(can(contributor, "content.edit.own", { ownerId: "other", section })).toBe(false);
    }
    for (const capability of ["media.upload", "media.manage", "media.video.manage"] as const) {
      expect(can(contributor, capability)).toBe(true);
    }
    expect(can(contributor, "content.edit.any", { ownerId: "other" })).toBe(false);
    expect(can(contributor, "content.publish")).toBe(false);
  });

  it("separates editing from publication and publication from administration", () => {
    expect(can(actor("editor"), "content.edit.any", { ownerId: "other", section: "support" })).toBe(true);
    for (const capability of ["content.publish", "content.unpublish", "content.delete"] as const) {
      expect(can(actor("editor"), capability)).toBe(false);
      expect(can(actor("publisher"), capability)).toBe(true);
    }
    for (const capability of ["settings.manage", "schedule.manage", "users.manage", "audit.view"] as const) {
      expect(can(actor("publisher"), capability)).toBe(false);
      expect(can(actor("admin"), capability)).toBe(true);
    }
    expect(can(actor("admin"), "roles.grant")).toBe(false);
    expect(can(actor("owner"), "roles.grant")).toBe(true);
  });

  it("lets Viewer browse content without an Add new post navigation action", () => {
    const viewerPosts = eligibleNavDestinations(actor("viewer")).find((destination) => destination.id === "posts");
    expect(viewerPosts?.subitems?.map((item) => item.id)).toEqual(["all-posts"]);
    expect(eligibleNavDestinations(actor("contributor")).find((destination) => destination.id === "posts")?.subitems?.map((item) => item.id)).toContain("add-post");
  });

  it("uses one authoritative tier instead of combining it with old grants", () => {
    const doc = { accessTier: "viewer", role: "super_admin", grants: [{ role: "editor" }] };
    const viewer = principalFromUserDoc("writer", doc as CmsUserDoc, true);
    expect(viewer).toEqual({ id: "writer", grants: [{ role: "staff", tier: "viewer" }] });
    expect(server.administrativeRoleFromUserDoc(doc, true)).toBeNull();
    expect(server.administrativeRoleFromUserDoc({ accessTier: "owner" }, true)).toBe("super_admin");
    expect(server.administrativeRoleFromUserDoc({ accessTier: "admin" }, true)).toBe("admin");
  });

  it("denies present invalid tiers and inactive tier accounts instead of falling back", () => {
    for (const accessTier of [null, undefined, [], {}, "Owner", "editor ", "constructor", "__proto__"]) {
      const doc = { accessTier, role: "super_admin", grants: [{ role: "editor" }] } as CmsUserDoc;
      expect(principalFromUserDoc("writer", doc, true).grants).toEqual([]);
      expect(server.principalFromUserDoc("writer", doc, true).grants).toEqual([]);
      expect(server.administrativeRoleFromUserDoc(doc, true)).toBeNull();
    }
    expect(principalFromUserDoc("writer", { accessTier: "owner", active: false }, true).grants).toEqual([]);
    expect(server.principalFromUserDoc("writer", { accessTier: "owner", active: false }, true).grants).toEqual([]);
  });

  it("does not accept a tier smuggled into a legacy grant or a scoped modern grant", () => {
    const legacy = principalFromUserDoc("writer", { grants: [{ role: "staff", tier: "owner" }] }, true);
    expect(hasCapability(legacy, "roles.grant")).toBe(false);
    const malformed = { grants: [{ role: "super_admin" as const, tier: "owner" as const, sections: [] }] };
    expect(hasCapability(malformed, "roles.grant")).toBe(false);
    expect(rbac.hasCapability(malformed, "roles.grant")).toBe(false);
  });

  it("keeps old Editor publication and area limits until a deliberate tier replacement", () => {
    const old = principalFromUserDoc("writer", { grants: [{ role: "editor", sections: ["watch"] }] }, true);
    expect(can(old, "content.publish", { section: "watch" })).toBe(true);
    expect(can(old, "content.publish", { section: "support" })).toBe(false);
    expect(can(old, "content.delete", { section: "watch" })).toBe(false);
    expect(server.principalFromUserDoc("writer", { grants: [{ role: "editor", sections: ["watch"] }] }, true)).toEqual(old);
  });

  it("agrees between every browser and server tier decision", () => {
    expect(rbac.ACCESS_TIERS).toEqual(ACCESS_TIERS);
    expect(rbac.TIER_CAPABILITIES).toEqual(TIER_CAPABILITIES);
    for (const accessTier of ACCESS_TIERS) {
      const browser = actor(accessTier);
      const resolved = server.principalFromUserDoc("writer", { accessTier }, true);
      expect(resolved).toEqual(browser);
      for (const capability of rbac.ALL_CAPABILITIES) {
        expect(rbac.can(resolved, capability, { ownerId: "other", section: "watch" }))
          .toBe(can(browser, capability, { ownerId: "other", section: "watch" }));
      }
    }
  });
});
