import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getApps, deleteApp } from "firebase-admin/app";
import firebase from "../../functions/lib/firebase.js";
import auth from "../../functions/lib/auth.js";
import api from "../../functions/author-profiles.js";
import store from "../../functions/lib/author-profile-store.js";

const { db, admin } = firebase;
const ACTOR = "profile-admin";
const NOW = "2026-10-08T12:00:00.000Z";
const actions = ["create", "edit", "publish", "withdraw", "rename", "link", "archive", "delete"];

beforeEach(async () => {
  vi.restoreAllMocks();
  auth.resetAuthTokenCache();
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host) throw new Error("Firestore emulator required");
  await clearEmulatorFirestore(`http://${host}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, {
    method: "DELETE",
  });
  await db.doc(`users/${ACTOR}`).set({ active: true, role: "admin", grants: [] });
  await db.doc("users/author").set({
    active: true, grants: [{ role: "contributor" }], email: "author@example.test",
  });
  // Replace only external identity verification. Principal resolution and all
  // authorization decisions use the real stored user and production code.
  vi.spyOn(admin.auth(), "verifyIdToken").mockResolvedValue({
    uid: ACTOR, email: "profile-admin@example.test", email_verified: true,
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await Promise.all(getApps().map(deleteApp));
});

async function revoke(kind) {
  const ref = db.doc(`users/${ACTOR}`);
  if (kind === "deleted") await ref.delete();
  else if (kind === "inactive") await ref.update({ active: false });
  else await ref.update({ role: null, grants: [{ role: "contributor" }] });
}

async function profileRequest(action) {
  const { profile } = await store.createManagedProfile({
    firestore: db, displayName: "Test author", actorUid: ACTOR,
    nowIso: NOW, randomHex: "a".repeat(32),
  });
  let current = profile;
  if (["withdraw", "rename", "archive"].includes(action)) {
    ({ profile: current } = await store.publishProfile({
      firestore: db, authorId: profile.authorId, expectedVersion: profile.version,
      nowIso: NOW, actorUid: ACTOR,
    }));
  }
  return {
    action, authorId: current.authorId, expectedVersion: current.version,
    displayName: "Updated author", slug: "renamed-author", uid: "author",
  };
}

async function storedProfiles() {
  const collections = [
    "cmsAuthorProfiles", "cmsAuthorProfilesPublic", "cmsAuthorSlugs",
    "cmsStaffRecords", "cmsBylineDirectory", "cmsBylineSelf", "admin_logs",
  ];
  const snapshots = await Promise.all([
    ...collections.map((name) => db.collection(name).get()),
    db.collectionGroup("mediaUsage").get(),
  ]);
  return snapshots.flatMap((snapshot) => snapshot.docs.map((doc) => ({
    path: doc.ref.path, data: doc.data(),
  }))).sort((left, right) => left.path.localeCompare(right.path));
}

async function invoke(factory, body, { afterAuth, firestore = db } = {}) {
  const response = {
    statusCode: null, body: null, headersSent: false,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; this.headersSent = true; return this; },
  };
  await factory({
    firestore,
    requirePrincipalFn: async (req) => {
      const caller = await auth.requirePrincipal(req);
      if (afterAuth) await afterAuth();
      return caller;
    },
    log: { error() {} },
  })({ method: "POST", headers: { authorization: "Bearer profile-test" }, body }, response);
  return response;
}

describe("author profile admin authority", () => {
  it.each(["admin", "super_admin"])("allows %s to publish another contributor's linked profile", async (role) => {
    await db.doc(`users/${ACTOR}`).update({ role });
    const { profile } = await store.ensureAuthorIdentity({
      firestore: db, uid: "author", displayName: "Test contributor",
      actorUid: "author", nowIso: NOW, randomHex: "b".repeat(32),
    });
    const response = await invoke(api.createAdminUpdateAuthorProfileHandler, {
      action: "publish", authorId: profile.authorId, expectedVersion: profile.version,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body.profile.visibility).toBe("published");
    expect((await db.doc(`cmsAuthorProfilesPublic/${profile.authorId}`).get()).data().authorId).toBe(profile.authorId);
  });

  it.each(actions)("allows an active admin to %s", async (action) => {
    const body = await profileRequest(action);
    const response = await invoke(api.createAdminUpdateAuthorProfileHandler, body);
    expect(response.statusCode).toBe(200);
    expect(response.body.success).toBe(true);
    if (action === "delete") {
      expect((await db.doc(`cmsAuthorProfiles/${body.authorId}`).get()).exists).toBe(false);
    } else {
      const saved = (await db.doc(`cmsAuthorProfiles/${response.body.profile.authorId}`).get()).data();
      expect(saved.version).toBe(response.body.profile.version);
      expect(saved.updatedBy).toBe(ACTOR);
    }
  });

  it.each(actions.flatMap((action) =>
    ["demoted", "inactive", "deleted"].map((account) => ({ action, account })),
  ))("refuses $action after the caller is $account", async ({ action, account }) => {
    const body = await profileRequest(action);
    const before = await storedProfiles();
    const response = await invoke(api.createAdminUpdateAuthorProfileHandler, body, {
      afterAuth: () => revoke(account),
    });
    expect(response.statusCode).toBe(403);
    expect(response.body.success).toBeUndefined();
    expect(await storedProfiles()).toEqual(before);
  });

  it.each(actions)("rechecks %s authority on a transaction retry", async (action) => {
    const body = await profileRequest(action);
    const before = await storedProfiles();
    let retry = false;
    // Inject a Firestore ABORTED response at the database boundary. The first
    // transaction never commits; the SDK retries against the demoted account.
    const firestore = {
      doc: db.doc.bind(db),
      collection: db.collection.bind(db),
      runTransaction: (callback) => db.runTransaction(async (transaction) => {
        if (retry) {
          await revoke("demoted");
          return callback(transaction);
        }
        await callback(transaction);
        retry = true;
        throw Object.assign(new Error("Transaction aborted"), { code: 10 });
      }),
    };
    const response = await invoke(api.createAdminUpdateAuthorProfileHandler, body, { firestore });
    expect(response.statusCode).toBe(403);
    expect(await storedProfiles()).toEqual(before);
  });

  it.each(["demoted", "inactive", "deleted"])(
    "withholds the directory after the caller is %s", async (account) => {
      await profileRequest("edit");
      const response = await invoke(api.createListAuthorProfilesHandler, {}, {
        afterAuth: () => revoke(account),
      });
      expect(response.statusCode).toBe(403);
      expect(response.body.profiles).toBeUndefined();
      expect(response.body.linkableUsers).toBeUndefined();
    },
  );

  it("allows an active admin to read the bounded directory", async () => {
    const body = await profileRequest("edit");
    const response = await invoke(api.createListAuthorProfilesHandler, { limit: 1 });
    expect(response.statusCode).toBe(200);
    expect(response.body.profiles).toHaveLength(1);
    expect(response.body.profiles[0].authorId).toBe(body.authorId);
    expect(response.body.nextCursor).toBe(body.authorId);
    expect(response.body.linkableUsers).toContainEqual(expect.objectContaining({ uid: "author" }));
  });

  it.each(["demoted", "inactive", "deleted"])(
    "withholds a directory read in flight when the caller is %s", async (account) => {
      await profileRequest("edit");
      const firestore = {
        collection: db.collection.bind(db),
        getAll: async (...refs) => {
          const snapshots = await db.getAll(...refs);
          await revoke(account);
          return snapshots;
        },
      };
      const response = await invoke(api.createListAuthorProfilesHandler, {}, { firestore });
      expect(response.statusCode).toBe(403);
      expect(response.body.profiles).toBeUndefined();
      expect(response.body.linkableUsers).toBeUndefined();
    },
  );
});
