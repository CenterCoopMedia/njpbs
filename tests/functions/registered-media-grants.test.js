import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import firebase from "../../functions/lib/firebase.js";
import auth from "../../functions/lib/auth.js";
import rbac from "../../functions/lib/rbac.js";
import mediaSources from "../../functions/lib/media-sources.js";

const { admin, db } = firebase;
const capabilities = ["media.audio.read", "media.video.read", "media.video.manage", "media.upload", "media.manage"];
const source = { id: "video-library", access: "active_staff", writable: true };
const uid = "scoped-editor";

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Use the Firestore emulator");
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" });
  // An arbitrary live registry ID proves that authorization does not use the seed list.
  await db.doc("sections/current-area").set({ label: "Current area" });
  vi.spyOn(admin.auth(), "verifyIdToken").mockResolvedValue({ uid, email: `${uid}@example.org`, email_verified: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  auth.resetAuthTokenCache();
});

async function resolvedActor(sections) {
  // A stored claim of registry membership cannot replace the server's live read.
  await db.doc(`users/${uid}`).set({ active: true, grants: [{ role: "editor", sections, registeredMediaSections: ["current-area"] }] });
  return auth.requirePrincipal({ headers: { authorization: "Bearer scoped-test" } }, { includeAccountStatus: true });
}

describe("live area grants for site-wide media", () => {
  it.each([
    ["registered", ["current-area"], true],
    ["retired only", ["retired-area"], false],
    ["retired and registered", ["retired-area", "current-area"], true],
  ])("checks a %s grant against the runtime registry", async (_name, sections, allowed) => {
    const actor = await resolvedActor(sections);
    for (const capability of capabilities) {
      expect(rbac.hasCapability(actor.principal, capability), capability).toBe(allowed);
      expect(rbac.can(actor.principal, capability, {}), capability).toBe(allowed);
      expect(rbac.can(actor.principal, capability, { section: "general" }), capability).toBe(allowed);
    }
    for (const operation of ["browse", "metadata", "delete"]) {
      const decision = mediaSources.authorizeMediaSource({ firestore: db, actor, source, operation });
      if (allowed) await expect(decision).resolves.toBe(true);
      else await expect(decision).rejects.toMatchObject({ status: 403 });
    }
    // Retired grants stay in storage for explicit revocation, regardless of admission.
    expect((await db.doc(`users/${uid}`).get()).data().grants[0].sections).toEqual(sections);
    for (const section of sections) expect(rbac.can(actor.principal, "content.edit.any", { section })).toBe(true);
  });

  it("withdraws media access on the next request when the last registered area retires", async () => {
    const first = await resolvedActor(["retired-area", "current-area"]);
    expect(rbac.can(first.principal, "media.video.manage", {})).toBe(true);
    await db.doc("sections/current-area").delete();
    const next = await auth.requirePrincipal({ headers: { authorization: "Bearer scoped-test" } });
    for (const capability of capabilities) expect(rbac.hasCapability(next.principal, capability)).toBe(false);
  });
});
