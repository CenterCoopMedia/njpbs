import { beforeEach, describe, expect, it } from "vitest";
import {
  ADMIN_DESTINATION_KEY,
  canOpenAdminPath,
  destinationToRestore,
  forgetDestination,
  readRememberedDestination,
  rememberDestination,
} from "../src/lib/route-memory";
import type { Principal } from "../../packages/content-core/src/rbac";

// The route memory is the durable half of "a refresh keeps the destination" (#1031). The router
// honors window.location on its own, so this only matters when the address itself is lost before
// the app boots. Everything here is pure or storage-bound so the decision can be tested without a
// browser, and authorization is never read from storage: canOpenAdminPath re-derives it from the
// principal resolved by this load.

const superAdmin = {
  id: "fixture-editor",
  grants: [{ role: "super_admin" }],
} as unknown as Principal;

const siteWideEditor = {
  id: "blake",
  grants: [{ role: "editor" }],
} as unknown as Principal;

const sectionContributor = {
  id: "sam",
  grants: [{ role: "contributor", sections: ["news"] }],
} as unknown as Principal;

const guideStaff = {
  id: "new-staff",
  grants: [{ role: "staff" }],
} as unknown as Principal;

const noAdminAccess = {
  id: "disabled",
  grants: [],
} as unknown as Principal;

describe("canOpenAdminPath", () => {
  it("restores public editor links only for currently admitted staff", () => {
    for (const principal of [superAdmin, siteWideEditor, sectionContributor, guideStaff]) {
      expect(canOpenAdminPath(principal, "/open")).toBe(true);
      expect(canOpenAdminPath(principal, "/open/")).toBe(true);
    }
    expect(canOpenAdminPath(noAdminAccess, "/open")).toBe(false);
    expect(canOpenAdminPath(siteWideEditor, "/open/extra")).toBe(false);
  });
  it("restores reports only for holders of reports.view", () => {
    for (const path of ["/reports", "/reports/report-1"]) {
      expect(canOpenAdminPath(sectionContributor, path)).toBe(true);
      expect(canOpenAdminPath(superAdmin, path)).toBe(true);
      expect(canOpenAdminPath(guideStaff, path)).toBe(true);
      expect(canOpenAdminPath(noAdminAccess, path)).toBe(false);
    }
  });
  it("restores the politics resource only for currently admitted staff", () => {
    for (const principal of [superAdmin, siteWideEditor, sectionContributor, guideStaff]) {
      expect(canOpenAdminPath(principal, "/resources/nj-politics")).toBe(true);
      expect(canOpenAdminPath(principal, "/resources/nj-politics/")).toBe(true);
    }
    expect(canOpenAdminPath(noAdminAccess, "/resources/nj-politics")).toBe(false);
    expect(canOpenAdminPath(guideStaff, "/resources/unknown")).toBe(false);
    expect(canOpenAdminPath(guideStaff, "/resources/nj-politics/extra")).toBe(false);
  });

  it("admits the default destination and the personal account routes for anyone admitted", () => {
    for (const principal of [superAdmin, siteWideEditor, sectionContributor]) {
      expect(canOpenAdminPath(principal, "/")).toBe(true);
      expect(canOpenAdminPath(principal, "/account/settings")).toBe(true);
      expect(canOpenAdminPath(principal, "/account/profile")).toBe(true);
      expect(canOpenAdminPath(principal, "/schedule")).toBe(true);
    }
  });

  it("gates each capability-scoped destination the same way its route does", () => {
    expect(canOpenAdminPath(superAdmin, "/staff-access")).toBe(true);
    expect(canOpenAdminPath(superAdmin, "/activity")).toBe(true);
    expect(canOpenAdminPath(superAdmin, "/publish-queue")).toBe(true);
    expect(canOpenAdminPath(superAdmin, "/admin/settings")).toBe(true);
    expect(canOpenAdminPath(superAdmin, "/admin/settings/costs")).toBe(true);
    expect(canOpenAdminPath({ id: "admin", grants: [{ role: "admin" }] }, "/admin/settings/costs")).toBe(true);
    expect(canOpenAdminPath(superAdmin, "/staff-profiles")).toBe(true);

    expect(canOpenAdminPath(siteWideEditor, "/staff-access")).toBe(false);
    expect(canOpenAdminPath(siteWideEditor, "/admin/settings")).toBe(false);
    expect(canOpenAdminPath(siteWideEditor, "/admin/settings/costs")).toBe(false);
    expect(canOpenAdminPath(noAdminAccess, "/admin/settings/costs")).toBe(false);
    expect(canOpenAdminPath(siteWideEditor, "/staff-profiles")).toBe(false);
  });

  it("remembers only valid media destinations for accounts with workspace access", () => {
    for (const path of [
      "/media",
      "/media/images",
      "/media/videos",
      "/media/videos/archive-originals",
      "/media/favorites",
      "/media/collections",
      `/media/collections/${"a".repeat(64)}`,
      "/media/voiceovers",
    ]) {
      expect(canOpenAdminPath(siteWideEditor, path)).toBe(true);
      expect(canOpenAdminPath(guideStaff, path)).toBe(true);
      expect(canOpenAdminPath(noAdminAccess, path)).toBe(false);
    }
    expect(canOpenAdminPath(siteWideEditor, "/media/videos/archive/extra")).toBe(false);
    expect(canOpenAdminPath(siteWideEditor, "/media/unknown")).toBe(false);
  });

  it("admits only staff resources for the guide-only staff role", () => {
    expect(canOpenAdminPath(guideStaff, "/schedule")).toBe(true);
    expect(canOpenAdminPath(guideStaff, "/content")).toBe(false);
    expect(canOpenAdminPath(guideStaff, "/activity")).toBe(false);
  });

  it("admits an editor route only when the principal can open that surface", () => {
    expect(canOpenAdminPath(superAdmin, "/content")).toBe(true);
    expect(canOpenAdminPath(superAdmin, "/content/pages/home/edit")).toBe(true);
    expect(canOpenAdminPath(superAdmin, "/content/post/abc123/edit")).toBe(true);
    expect(canOpenAdminPath(superAdmin, "/content/post/+")).toBe(true);

    // The directory admits contributors; server reads restrict it to their own pages.
    expect(canOpenAdminPath(sectionContributor, "/content")).toBe(true);
    expect(canOpenAdminPath(sectionContributor, "/content/library")).toBe(true);
    expect(canOpenAdminPath(sectionContributor, "/content/post/abc123/edit")).toBe(true);
  });

  it("restores template destinations only for content principals", () => {
    for (const path of ["/post-templates", "/post-templates/template-one"]) {
      expect(canOpenAdminPath(superAdmin, path)).toBe(true);
      expect(canOpenAdminPath(sectionContributor, path)).toBe(true);
      expect(canOpenAdminPath(guideStaff, path)).toBe(false);
    }
    expect(canOpenAdminPath(superAdmin, "/post-templates/template-one/extra")).toBe(false);
  });

  it("refuses a malformed or unknown path rather than guessing", () => {
    expect(canOpenAdminPath(superAdmin, "/content/not-a-type/edit")).toBe(false);
    expect(canOpenAdminPath(superAdmin, "/nothing-here")).toBe(false);
    expect(canOpenAdminPath(superAdmin, "")).toBe(false);
  });
});

describe("destinationToRestore", () => {
  it("restores a remembered destination when the load landed on the default route", () => {
    expect(destinationToRestore("/", "/staff-access")).toBe("/staff-access");
    expect(destinationToRestore("/", "/content/post/abc/edit")).toBe(
      "/content/post/abc/edit",
    );
    expect(destinationToRestore("/", "/content/library?status=draft")).toBe(
      "/content/library?status=draft",
    );
  });

  it("leaves a surviving address alone, so a real deep link is never overridden", () => {
    expect(destinationToRestore("/activity", "/staff-access")).toBeNull();
    expect(destinationToRestore("/?welcome=1", "/staff-access")).toBeNull();
  });

  it("does nothing when the remembered destination is the default one or absent", () => {
    expect(destinationToRestore("/", "/")).toBeNull();
    expect(destinationToRestore("/", null)).toBeNull();
  });

  it("refuses a remembered value that is not an in-app path", () => {
    expect(destinationToRestore("/", "//evil.example.com")).toBeNull();
    expect(destinationToRestore("/", "https://evil.example.com/x")).toBeNull();
    expect(destinationToRestore("/", "/\\evil.example.com")).toBeNull();
    expect(destinationToRestore("/", "staff-access")).toBeNull();
  });
});

describe("destination storage", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("round-trips the destination and forgets it on request", () => {
    rememberDestination(sessionStorage, "fixture-editor", "/staff-access");
    expect(readRememberedDestination(sessionStorage, "fixture-editor")).toBe("/staff-access");
    forgetDestination(sessionStorage);
    expect(readRememberedDestination(sessionStorage, "fixture-editor")).toBeNull();
  });

  it("answers nothing for a different account, so one tab cannot hand a route to the next person", () => {
    rememberDestination(sessionStorage, "fixture-editor", "/staff-access");
    expect(readRememberedDestination(sessionStorage, "blake")).toBeNull();
    // And the stale entry is not left lying around for a later coincidental uid match.
    expect(readRememberedDestination(sessionStorage, "fixture-editor")).toBeNull();
  });

  it("treats a stored value that is not an in-app path as absent", () => {
    sessionStorage.setItem(
      ADMIN_DESTINATION_KEY,
      JSON.stringify({ uid: "fixture-editor", path: "https://evil.example.com/x" }),
    );
    expect(readRememberedDestination(sessionStorage, "fixture-editor")).toBeNull();
  });

  it("treats an unreadable or legacy stored value as absent", () => {
    sessionStorage.setItem(ADMIN_DESTINATION_KEY, "/staff-access");
    expect(readRememberedDestination(sessionStorage, "fixture-editor")).toBeNull();
    sessionStorage.setItem(ADMIN_DESTINATION_KEY, "{not json");
    expect(readRememberedDestination(sessionStorage, "fixture-editor")).toBeNull();
  });

  it("survives a storage that throws, so a private window still boots", () => {
    const hostile = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
      removeItem() {
        throw new Error("denied");
      },
    } as unknown as Storage;
    expect(readRememberedDestination(hostile, "fixture-editor")).toBeNull();
    expect(() => rememberDestination(hostile, "fixture-editor", "/activity")).not.toThrow();
    expect(() => forgetDestination(hostile)).not.toThrow();
    expect(readRememberedDestination(null, "fixture-editor")).toBeNull();
  });
});
