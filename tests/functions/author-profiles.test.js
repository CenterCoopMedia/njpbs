import { enrollPublicReleaseLog, publicReleaseEntries } from "../helpers/public-release-producer.js";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
// Emulator-backed spec for the author/staff/profile storage layer and its
// private backfill (issue #1044, lane 1). These exercise the real Firestore
// transactions rather than a fake, because the guarantees under test are
// transactional ones: a snapshot deleted in the same commit that takes a profile
// private, an audit row written with the change it describes, and a slug that
// cannot be claimed twice.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FieldPath } from "firebase-admin/firestore";
import adminPkg from "../helpers/firebase-admin.js";
import storePkg from "../../functions/lib/author-profile-store.js";
import staffPkg from "../../functions/deactivate-staff.js";
import authorApiPkg from "../../functions/author-profiles.js";
import contractPkg from "../../functions/lib/author-profile-contract.js";
import principalPkg from "../../functions/lib/principal.js";
import directoryPkg from "../../functions/lib/story-credit-directory.js";
import lifecyclePkg from "../../functions/set-media-lifecycle.js";
import mediaLibraryPkg from "../../functions/lib/media-library.js";
import {
  SYSTEM_ACTOR,
  backfillAuthorProfiles,
  resolveSeedName,
} from "../../scripts/backfill-author-profiles.mjs";
import { backfillBylineProjections } from "../../scripts/backfill-byline-projections.mjs";
import { readBylineDirectory } from "../../cms-api/src/byline-directory.ts";

const admin = adminPkg;
const {
  AuthorProfileError,
  archiveProfile,
  createManagedProfile,
  deleteDraftProfile,
  ensureAuthorIdentity,
  listAuthorProfiles,
  listBylineAuthors,
  listLinkableUsers,
  linkProfileToUser,
  publishProfile,
  readProfileByUid,
  renameProfileSlug,
  updateWorkingProfile,
  withdrawProfile,
  withdrawProfileForDeactivation,
} = storePkg;
const { AUTHOR_PRIVATE_FIELDS, isAuthorId } = contractPkg;
const { readAuthorIdentities } = directoryPkg;
const { createCmsSetMediaLifecycleHandler } = lifecyclePkg;
const { formatMediaEtag } = mediaLibraryPkg;

const bylineDirectory = (authorId) =>
  db.collection("cmsBylineDirectory").doc(authorId);
const bylineSelf = (uid) => db.collection("cmsBylineSelf").doc(uid);

const PROJECT = "demo-njpbs";
const NOW = "2026-08-21T18:00:00.000Z";
const LATER = "2026-08-21T19:00:00.000Z";

let db;
let hexCounter;

function nextHex() {
  hexCounter += 1;
  return hexCounter.toString(16).padStart(32, "0");
}

async function clearFirestore() {
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
}

async function seedUser(uid, fields = {}) {
  await db
    .collection("users")
    .doc(uid)
    .set({
      email: `${uid}@example.org`,
      displayName: "Taylor Example",
      active: true,
      role: null,
      grants: [{ role: "editor" }],
      ...fields,
    });
}

async function ensure(uid, overrides = {}) {
  return ensureAuthorIdentity({
    firestore: db,
    uid,
    nowIso: NOW,
    actorUid: uid,
    actorEmail: `${uid}@example.org`,
    randomHex: nextHex(),
    ...overrides,
  });
}

/** The version a profile is currently at, for an optimistic-concurrency call. */
async function versionOf(authorId) {
  return (await db.collection("cmsAuthorProfiles").doc(authorId).get()).data()
    .version;
}

async function auditActions() {
  const snapshot = await db.collection("admin_logs").get();
  return snapshot.docs.map((doc) => doc.data().action).sort();
}

async function profileStorage() {
  const collections = [
    "users",
    "cmsStaffRecords",
    "cmsAuthorProfiles",
    "cmsBylineDirectory",
    "cmsBylineSelf",
    "cmsAuthorProfilesPublic",
    "cmsAuthorSlugs",
    "admin_logs",
  ];
  const snapshots = await Promise.all([
    ...collections.map((name) => db.collection(name).get()),
    db.collectionGroup("mediaUsage").get(),
  ]);
  return snapshots.flatMap((snapshot) =>
    snapshot.docs.map((doc) => ({ path: doc.ref.path, data: doc.data() })),
  ).sort((left, right) => left.path.localeCompare(right.path));
}

async function seedPublicationRuntime(phase, overrides = {}) {
  await db.collection("system").doc("cmsPublicationRuntime").set({
    schemaVersion: 1,
    phase,
    commitSha: "a".repeat(40),
    serializerId: "node-compute-public-primary",
    ...overrides,
  });
}

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("author-profiles.test.js");
});

beforeEach(async () => {
  hexCounter = 0;
  await clearFirestore();
});

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app.delete()));
});

describe("byline projection", () => {
  it("matches edge and Functions readiness without exposing private profile fields", async () => {
    const photo = {
      assetId: "asset-1", url: "https://media.njpbs.org/cms-media/staff-profile/asset-1/abc.jpg",
      mimeType: "image/jpeg", width: 800, height: 800, sizeBytes: 120_000,
      focalX: 0.5, focalY: 0.5, credit: null, rightsBasis: "own-photo", attestedAt: NOW,
    };
    const fixtures = [
      { jobTitle: "Reporter", bio: "Private bio text must not reach the picker", photo, visibility: "private" },
      { jobTitle: "  ", bio: " \n ", photo: {}, visibility: "private" },
      { jobTitle: null, bio: null, photo: null, visibility: "private" },
    ];
    for (const [index, fields] of fixtures.entries()) {
      const authorId = `au_${String(index + 1).padStart(32, "0")}`;
      await db.collection("cmsAuthorProfiles").doc(authorId).set({
        ...contractPkg.newAuthorWorkingProfile({ authorId, uid: null, displayName: `Reporter ${index + 1}`,
          nowIso: NOW, actor: "uid-admin" }), ...fields,
      });
    }
    await backfillBylineProjections({ firestore: db });
    const encodeField = value => value === null ? { nullValue: "NULL_VALUE" }
      : typeof value === "boolean" ? { booleanValue: value }
        : typeof value === "string" ? { stringValue: value }
          : { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeField(item)])) } };
    const fetcher = async url => {
      const address = String(url);
      const json = value => new Response(JSON.stringify(value));
      if (address.includes("accounts:lookup")) return json({ users: [{ localId: "editor-1" }] });
      if (address.includes("/users/editor-1")) return json({});
      if (address.includes(":runQuery")) {
        const rows = await db.collection("cmsBylineDirectory").orderBy(FieldPath.documentId()).get();
        return json(rows.docs.map(doc => ({ document: {
          name: `projects/demo-njpbs/databases/(default)/documents/cmsBylineDirectory/${doc.id}`,
          fields: Object.fromEntries(Object.entries(doc.data()).map(([key, value]) => [key, encodeField(value)])),
        } })));
      }
      return new Response("{}", { status: 404 });
    };
    async function expectParity(published) {
      const native = await listBylineAuthors({ firestore: db });
      const edge = await readBylineDirectory({
        token: "fixture-token", uid: "editor-1", authTime: 100, apiKey: "fixture-key",
        projectId: PROJECT, body: new TextEncoder().encode("{}").buffer, fetcher,
      });
      expect(edge.authors).toEqual(native.authors);
      expect(edge.authors.map(author => author.profileReadiness)).toEqual([
        { hasPhoto: true, hasJobTitle: true, hasBio: true, published },
        { hasPhoto: false, hasJobTitle: false, hasBio: false, published: false },
        { hasPhoto: false, hasJobTitle: false, hasBio: false, published: false },
      ]);
      for (const author of edge.authors) expect(Object.keys(author).sort()).toEqual([
        "authorId", "displayName", "jobTitle", "profileReadiness",
      ]);
      expect(JSON.stringify(edge)).not.toContain("Private bio");
      expect(JSON.stringify(edge)).not.toContain("cms-media");
    }
    await expectParity(false);
    const authorId = `au_${"1".padStart(32, "0")}`;
    const published = await publishProfile({ firestore: db, authorId, expectedVersion: 1,
      nowIso: LATER, actorUid: "uid-admin" });
    await expectParity(true);
    await withdrawProfile({ firestore: db, authorId, expectedVersion: published.profile.version,
      reason: "owner", nowIso: LATER, actorUid: "uid-admin" });
    await expectParity(false);
  });

  it("updates narrow directory and self rows with profile edits and archive", async () => {
    await seedUser("uid-1", { displayName: "Taylor Example" });
    const { profile } = await ensure("uid-1");
    expect((await bylineDirectory(profile.authorId).get()).data()).toEqual({
      authorId: profile.authorId,
      displayName: "Taylor Example",
      jobTitle: null,
      profileReadiness: { hasPhoto: false, hasJobTitle: false, hasBio: false, published: false },
      eligible: true,
    });
    expect((await bylineSelf("uid-1").get()).data()).toEqual({
      authorId: profile.authorId,
    });

    const { profile: edited } = await updateWorkingProfile({
      firestore: db,
      authorId: profile.authorId,
      patch: { displayName: "Taylor E.", jobTitle: "Editor" },
      expectedVersion: profile.version,
      nowIso: LATER,
      actorUid: "uid-1",
    });
    expect((await bylineDirectory(profile.authorId).get()).data()).toEqual({
      authorId: profile.authorId,
      displayName: "Taylor E.",
      jobTitle: "Editor",
      profileReadiness: { hasPhoto: false, hasJobTitle: true, hasBio: false, published: false },
      eligible: true,
    });

    await archiveProfile({
      firestore: db,
      authorId: profile.authorId,
      expectedVersion: edited.version,
      nowIso: LATER,
      actorUid: "uid-admin",
    });
    expect((await bylineDirectory(profile.authorId).get()).data()).toEqual({
      authorId: profile.authorId,
      eligible: false,
    });
    expect((await bylineSelf("uid-1").get()).exists).toBe(false);
  });

  it("removes a departed author in the first staff deactivation transaction", async () => {
    await seedUser("uid-admin", { role: "super_admin" });
    await seedUser("uid-1", { displayName: "Former Staff" });
    const { profile } = await ensure("uid-1");

    await staffPkg.deactivateProfile({
      firestore: db,
      actor: { uid: "uid-admin", email: "uid-admin@example.org" },
      targetUid: "uid-1",
      source: null,
      nowIso: LATER,
    });

    expect((await db.collection("users").doc("uid-1").get()).data().active).toBe(false);
    expect((await bylineDirectory(profile.authorId).get()).data()).toEqual({
      authorId: profile.authorId,
      eligible: false,
    });
    expect((await bylineSelf("uid-1").get()).exists).toBe(false);
  });

  it("backfills redacted tombstones and preserves source pagination", async () => {
    await seedUser("uid-1", { displayName: "Active Staff" });
    await seedUser("uid-2", { displayName: "Departed Staff" });
    await seedUser("uid-admin", { role: "super_admin" });
    const active = (await ensure("uid-1")).profile;
    const archived = await createManagedProfile({
      firestore: db,
      displayName: "Archived Author",
      nowIso: NOW,
      actorUid: "uid-admin",
      randomHex: nextHex(),
    });
    await archiveProfile({
      firestore: db,
      authorId: archived.profile.authorId,
      expectedVersion: archived.profile.version,
      nowIso: LATER,
      actorUid: "uid-admin",
    });
    await createManagedProfile({
      firestore: db,
      displayName: "Managed Author",
      nowIso: NOW,
      actorUid: "uid-admin",
      randomHex: nextHex(),
    });
    const departed = (await ensure("uid-2")).profile;
    await staffPkg.deactivateProfile({
      firestore: db,
      actor: { uid: "uid-admin", email: "uid-admin@example.org" },
      targetUid: "uid-2",
      source: null,
      nowIso: LATER,
    });

    const projectionDocs = await db.collection("cmsBylineDirectory").get();
    const selfDocs = await db.collection("cmsBylineSelf").get();
    const clear = db.batch();
    for (const doc of [...projectionDocs.docs, ...selfDocs.docs]) clear.delete(doc.ref);
    await clear.commit();
    expect(await backfillBylineProjections({ firestore: db })).toEqual({ synced: 4 });
    expect(await backfillBylineProjections({ firestore: db })).toEqual({ synced: 4 });
    expect((await bylineDirectory(archived.profile.authorId).get()).data()).toEqual({
      authorId: archived.profile.authorId,
      eligible: false,
    });
    expect((await bylineDirectory(departed.authorId).get()).data()).toEqual({
      authorId: departed.authorId,
      eligible: false,
    });
    expect((await bylineSelf("uid-1").get()).data()).toEqual({ authorId: active.authorId });
    expect((await bylineSelf("uid-2").get()).exists).toBe(false);
    const response = {
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await authorApiPkg.createListBylineAuthorsHandler({
      firestore: db,
      requirePrincipalFn: async () => ({ uid: "uid-1" }),
    })({ method: "POST", body: {}, headers: {} }, response);
    expect(response.statusCode).toBe(200);
    expect((await bylineSelf("uid-1").get()).data().authorId).toBe(
      response.body.selfAuthorId,
    );

    let cursor = null;
    for (let page = 0; page < 3; page += 1) {
      const sourcePage = await listBylineAuthors({
        firestore: db, limit: 2, startAfter: cursor,
      });
      let query = db.collection("cmsBylineDirectory")
        .orderBy(FieldPath.documentId()).limit(2);
      if (cursor !== null) query = query.startAfter(cursor);
      const projectionPage = await query.get();
      const authors = projectionPage.docs
        .map((doc) => doc.data())
        .filter((row) => row.eligible)
        .map(({ authorId, displayName, jobTitle }) => ({
          authorId, displayName, jobTitle,
        }))
        .sort((left, right) => left.displayName.localeCompare(right.displayName));
      expect(authors).toEqual(sourcePage.authors.map(({ authorId, displayName, jobTitle }) => ({ authorId, displayName, jobTitle })));
      expect(
        projectionPage.docs.length === 2
          ? projectionPage.docs[projectionPage.docs.length - 1].id
          : null,
      ).toEqual(sourcePage.nextCursor);
      cursor = sourcePage.nextCursor;
      if (cursor === null) break;
    }
  });
});

describe("author identity", () => {
  it("mints a staff record and a private profile for an active user", async () => {
    await seedUser("uid-1");
    const result = await ensure("uid-1");

    expect(result.created).toBe(true);
    expect(isAuthorId(result.staff.authorId)).toBe(true);
    expect(result.profile.visibility).toBe("private");
    expect(result.profile.slug).toBeNull();
    expect(result.profile.displayName).toBe("Taylor Example");

    const staff = (
      await db.collection("cmsStaffRecords").doc("uid-1").get()
    ).data();
    expect(staff).toMatchObject({
      uid: "uid-1",
      authorId: result.staff.authorId,
      email: "uid-1@example.org",
      status: "active",
      createdBy: "uid-1",
    });
    // Nothing public exists yet: profiles start private.
    expect((await db.collection("cmsAuthorProfilesPublic").get()).empty).toBe(
      true,
    );
    expect(await auditActions()).toEqual(["author_profile.create"]);
  });

  it("seeds the account's own name on the self-service path", async () => {
    // The name a self endpoint carries is a hint from a sign-in profile, so the
    // account document still decides. Only the operator backfill overrides it.
    await seedUser("uid-1", { displayName: "Taylor Example" });
    const result = await ensure("uid-1", {
      displayName: "Google Account Name",
    });
    expect(result.profile.displayName).toBe("Taylor Example");

    await seedUser("uid-2", { displayName: "" });
    const fallback = await ensure("uid-2", { displayName: "Jordan Example" });
    expect(fallback.profile.displayName).toBe("Jordan Example");
  });

  it("is idempotent and keeps the same authorId across calls", async () => {
    await seedUser("uid-1");
    const first = await ensure("uid-1");
    const second = await ensure("uid-1");

    expect(second.created).toBe(false);
    expect(second.staff.authorId).toBe(first.staff.authorId);
    // Only the first call audits: a verify pass is not a change.
    expect(await auditActions()).toEqual(["author_profile.create"]);
  });

  it("refuses an unapproved account and a deactivated one", async () => {
    await expect(ensure("uid-missing")).rejects.toMatchObject({ status: 403 });

    // A deactivated account gets no linkage row and no profile at all: every
    // self-service endpoint resolves through here, so this refusal is what stops
    // a deactivated person from reading, editing, or republishing a byline.
    await seedUser("uid-off", { active: false });
    await expect(ensure("uid-off")).rejects.toMatchObject({
      status: 403,
      code: "account_inactive",
    });
    expect((await db.collection("cmsStaffRecords").get()).empty).toBe(true);
    expect((await db.collection("cmsAuthorProfiles").get()).empty).toBe(true);
  });

  it("resyncs a stale staff record and audits it before refusing", async () => {
    await seedUser("uid-1");
    const { profile } = await ensure("uid-1");
    await db.collection("users").doc("uid-1").update({ active: false });

    await expect(ensure("uid-1")).rejects.toMatchObject({
      status: 403,
      code: "account_inactive",
    });
    // The repair survives the refusal: a half-failed offboarding must not leave
    // an "active" linkage row behind just because the caller was turned away.
    expect(
      (await db.collection("cmsStaffRecords").doc("uid-1").get()).data().status,
    ).toBe("inactive");
    expect((await bylineDirectory(profile.authorId).get()).data()).toEqual({
      authorId: profile.authorId,
      eligible: false,
    });
    expect((await bylineSelf("uid-1").get()).exists).toBe(false);
    // And it is audited, like every other mutation this module makes.
    expect(await auditActions()).toEqual([
      "author_profile.create",
      "author_profile.staff_resync",
    ]);
    const resync = (await db.collection("admin_logs").get()).docs
      .map((doc) => doc.data())
      .find((row) => row.action === "author_profile.staff_resync");
    expect(resync.target).toBe("cmsStaffRecords/uid-1");
    expect(resync.before.status).toBe("active");
    expect(resync.after.status).toBe("inactive");
  });

  it("audits an email resync on an account that is still active", async () => {
    await seedUser("uid-1");
    await ensure("uid-1");
    await db
      .collection("users")
      .doc("uid-1")
      .update({ email: "texample@example.org" });
    const result = await ensure("uid-1");

    expect(result.staff.email).toBe("texample@example.org");
    expect(await auditActions()).toEqual([
      "author_profile.create",
      "author_profile.staff_resync",
    ]);
  });

  it("refuses a corrupted staff record rather than reminting an identity", async () => {
    await seedUser("uid-1");
    await db
      .collection("cmsStaffRecords")
      .doc("uid-1")
      .set({ uid: "uid-1", authorId: "uid-1", status: "active" });
    await expect(ensure("uid-1")).rejects.toMatchObject({ status: 409 });
  });
});

describe("manager-created staff profile lifecycle", () => {
  async function createManaged(displayName = "Raven Santana") {
    return createManagedProfile({
      firestore: db,
      displayName,
      nowIso: NOW,
      actorUid: "uid-admin",
      actorEmail: "admin@example.org",
      randomHex: nextHex(),
    });
  }

  it("creates an unlinked private identity and can publish it", async () => {
    const { profile } = await createManaged();
    expect(profile).toMatchObject({
      uid: null,
      lifecycle: "active",
      visibility: "private",
      slug: null,
    });

    const { profile: published } = await publishProfile({
      firestore: db,
      authorId: profile.authorId,
      expectedVersion: profile.version,
      nowIso: LATER,
      actorUid: "uid-admin",
    });
    expect(published.slug).toBe("raven-santana");
    const publicDoc = await db
      .collection("cmsAuthorProfilesPublic")
      .doc(profile.authorId)
      .get();
    expect(publicDoc.data()).not.toHaveProperty("uid");
    expect(publicDoc.data()).not.toHaveProperty("lifecycle");
  });

  it("links an approved contributor without changing the author identity", async () => {
    await seedUser("uid-raven", {
      displayName: "Raven Santana",
      grants: [{ role: "contributor" }],
    });
    const { profile } = await createManaged();
    const linked = await linkProfileToUser({
      firestore: db,
      authorId: profile.authorId,
      uid: "uid-raven",
      expectedVersion: profile.version,
      nowIso: LATER,
      actorUid: "uid-admin",
    });
    expect(linked.profile.authorId).toBe(profile.authorId);
    expect(linked.profile.uid).toBe("uid-raven");
    expect(
      (await db.collection("cmsStaffRecords").doc("uid-raven").get()).data(),
    ).toMatchObject({ authorId: profile.authorId, status: "active" });

    const self = await ensure("uid-raven");
    expect(self.created).toBe(false);
    expect(self.profile.authorId).toBe(profile.authorId);
  });

  it.each([false, true])(
    "links a private profile without authoring access, existing identity: %s",
    async (existingIdentity) => {
      await seedUser("uid-raven");
      if (existingIdentity) await ensure("uid-raven");
      await db.collection("users").doc("uid-raven").update({
        grants: [{ role: "staff" }],
      });
      const { profile } = await createManaged();

      const linked = await linkProfileToUser({
        firestore: db,
        authorId: profile.authorId,
        uid: "uid-raven",
        expectedVersion: profile.version,
        nowIso: LATER,
        actorUid: "uid-admin",
      });

      expect(linked.profile).toMatchObject({
        authorId: profile.authorId,
        uid: "uid-raven",
        visibility: "private",
      });
      expect(
        (await db.collection("cmsStaffRecords").doc("uid-raven").get()).data(),
      ).toMatchObject({ authorId: profile.authorId, status: "active" });
      expect((await db.collection("cmsAuthorProfilesPublic").get()).empty).toBe(
        true,
      );
    },
  );

  it.each([false, true])(
    "refuses a published link without authoring access, existing identity: %s",
    async (existingIdentity) => {
      await seedUser("uid-raven");
      if (existingIdentity) await ensure("uid-raven");
      const { profile } = await createManaged();
      const { profile: published } = await publishProfile({
        firestore: db,
        authorId: profile.authorId,
        expectedVersion: profile.version,
        nowIso: NOW,
        actorUid: "uid-admin",
      });
      await db.collection("users").doc("uid-raven").update({
        grants: [{ role: "staff" }],
      });
      const before = await profileStorage();

      await expect(linkProfileToUser({
        firestore: db,
        authorId: published.authorId,
        uid: "uid-raven",
        expectedVersion: published.version,
        nowIso: LATER,
        actorUid: "uid-admin",
      })).rejects.toMatchObject({ status: 403, code: "author_access_required" });

      expect(await profileStorage()).toEqual(before);
    },
  );

  it("allows an authorized managed published link", async () => {
    const grants = [{ role: "contributor", sections: ["news"] }];
    await seedUser("uid-raven", { grants });
    let { profile } = await createManaged();
    ({ profile } = await publishProfile({
      firestore: db,
      authorId: profile.authorId,
      expectedVersion: profile.version,
      nowIso: NOW,
      actorUid: "uid-admin",
    }));
    const linked = await linkProfileToUser({
      firestore: db,
      authorId: profile.authorId,
      uid: "uid-raven",
      expectedVersion: profile.version,
      nowIso: LATER,
      actorUid: "uid-admin",
    });
    expect(linked.profile).toMatchObject({
      authorId: profile.authorId,
      uid: "uid-raven",
      visibility: "published",
    });
  });

  it("replaces an untouched self-created identity when linking a managed profile", async () => {
    await seedUser("uid-raven", {
      displayName: "Raven Santana",
      grants: [{ role: "contributor" }],
    });
    const { profile: managed } = await createManaged();
    const { profile: automatic } = await ensure("uid-raven");
    expect(automatic.authorId).not.toBe(managed.authorId);
    expect(await listLinkableUsers({ firestore: db })).toContainEqual({
      uid: "uid-raven",
      displayName: "Raven Santana",
      email: "uid-raven@example.org",
    });

    const linked = await linkProfileToUser({
      firestore: db,
      authorId: managed.authorId,
      uid: "uid-raven",
      expectedVersion: managed.version,
      nowIso: LATER,
      actorUid: "uid-admin",
      actorEmail: "admin@example.org",
    });

    expect(linked.profile).toMatchObject({
      authorId: managed.authorId,
      uid: "uid-raven",
    });
    expect(
      (await db.collection("cmsStaffRecords").doc("uid-raven").get()).data(),
    ).toMatchObject({ authorId: managed.authorId, version: 2 });
    expect(
      (
        await db
          .collection("cmsAuthorProfiles")
          .doc(automatic.authorId)
          .get()
      ).exists,
    ).toBe(false);
    expect((await bylineDirectory(automatic.authorId).get()).exists).toBe(false);
    expect((await bylineDirectory(managed.authorId).get()).data()).toMatchObject({
      authorId: managed.authorId,
      eligible: true,
    });
    expect((await bylineSelf("uid-raven").get()).data()).toEqual({
      authorId: managed.authorId,
    });
    expect((await ensure("uid-raven")).profile.authorId).toBe(managed.authorId);
  });

  it("preserves an auto-created identity after a byline references it", async () => {
    await seedUser("uid-raven", { displayName: "Raven Santana" });
    const { profile: managed } = await createManaged();
    const { profile: automatic } = await ensure("uid-raven");
    await db.collection("cmsPosts").doc("post-1").set({
      credits: [{ kind: "registered", authorId: automatic.authorId }],
    });

    await expect(
      linkProfileToUser({
        firestore: db,
        authorId: managed.authorId,
        uid: "uid-raven",
        expectedVersion: managed.version,
        nowIso: LATER,
        actorUid: "uid-admin",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (
        await db
          .collection("cmsAuthorProfiles")
          .doc(automatic.authorId)
          .get()
      ).exists,
    ).toBe(true);
    expect(
      (await db.collection("cmsStaffRecords").doc("uid-raven").get()).data()
        .authorId,
    ).toBe(automatic.authorId);
  });

  it("includes an active unlinked profile in the byline directory", async () => {
    const { profile } = await createManaged();
    const result = await listBylineAuthors({ firestore: db });
    expect(result.authors).toEqual([
      {
        authorId: profile.authorId,
        displayName: "Raven Santana",
        jobTitle: null,
        profileReadiness: { hasPhoto: false, hasJobTitle: false, hasBio: false, published: false },
      },
    ]);
  });

  it("archives a published identity while preserving id and slug", async () => {
    const { profile } = await createManaged();
    const published = await publishProfile({
      firestore: db,
      authorId: profile.authorId,
      expectedVersion: profile.version,
      nowIso: NOW,
      actorUid: "uid-admin",
    });
    const archived = await archiveProfile({
      firestore: db,
      authorId: profile.authorId,
      expectedVersion: published.profile.version,
      nowIso: LATER,
      actorUid: "uid-admin",
    });
    expect(archived.profile).toMatchObject({
      authorId: profile.authorId,
      slug: "raven-santana",
      lifecycle: "archived",
      visibility: "private",
      withdrawnReason: "archive",
    });
    expect(
      (await db.collection("cmsAuthorSlugs").doc("raven-santana").get()).exists,
    ).toBe(true);
    expect(
      (
        await db
          .collection("cmsAuthorProfilesPublic")
          .doc(profile.authorId)
          .get()
      ).exists,
    ).toBe(false);
    expect((await listBylineAuthors({ firestore: db })).authors).toEqual([]);
  });

  it("deletes only an unreferenced, never-published draft", async () => {
    const { profile } = await createManaged();
    await db
      .collection("cmsPosts")
      .doc("referenced-post")
      .set({
        type: "post",
        credits: [{ kind: "registered", authorId: profile.authorId }],
      });
    await expect(
      deleteDraftProfile({
        firestore: db,
        authorId: profile.authorId,
        expectedVersion: profile.version,
        nowIso: LATER,
        actorUid: "uid-admin",
      }),
    ).rejects.toMatchObject({ code: "profile_referenced" });

    await db.collection("cmsPosts").doc("referenced-post").delete();

    const credit = { kind: "registered", authorId: profile.authorId };
    for (const [collection, id, document] of [
      [
        "cmsPosts",
        "published-reference",
        {
          type: "post",
          published: {
            credits: [
              {
                ...credit,
                displayName: "The frozen name",
                slug: "the-frozen-name",
              },
            ],
          },
        },
      ],
      [
        "cmsVersionHistory",
        "before-reference",
        { collection: "cmsPosts", documentId: "old-post", before: { credits: [credit] } },
      ],
      [
        "cmsVersionHistory",
        "after-reference",
        { collection: "cmsPosts", documentId: "old-post", after: { credits: [credit] } },
      ],
    ]) {
      await db.collection(collection).doc(id).set(document);
      await expect(
        deleteDraftProfile({
          firestore: db,
          authorId: profile.authorId,
          expectedVersion: profile.version,
          nowIso: LATER,
          actorUid: "uid-admin",
        }),
      ).rejects.toMatchObject({ code: "profile_referenced" });
      await db.collection(collection).doc(id).delete();
    }

    await deleteDraftProfile({
      firestore: db,
      authorId: profile.authorId,
      expectedVersion: profile.version,
      nowIso: LATER,
      actorUid: "uid-admin",
    });
    expect(
      (await db.collection("cmsAuthorProfiles").doc(profile.authorId).get())
        .exists,
    ).toBe(false);
    expect((await bylineDirectory(profile.authorId).get()).exists).toBe(false);
  });

  it("scans past filtered user pages when listing linkable accounts", async () => {
    const batch = db.batch();
    for (let index = 0; index < 200; index += 1) {
      batch.set(db.collection("users").doc(`a-${String(index).padStart(3, "0")}`), {
        displayName: `Inactive ${index}`,
        active: false,
      });
    }
    batch.set(db.collection("users").doc("z-linkable"), {
      displayName: "Zelda Linkable",
      active: true,
    });
    await batch.commit();

    expect(await listLinkableUsers({ firestore: db })).toContainEqual({
      uid: "z-linkable",
      displayName: "Zelda Linkable",
      email: null,
    });
  });
});

describe("publish and withdraw", () => {
  async function activeProfile(uid = "uid-1") {
    await seedUser(uid);
    const { profile } = await ensure(uid);
    return profile;
  }

  it("publishes a snapshot, claims a slug, and audits", async () => {
    const profile = await activeProfile();
    const { profile: published } = await publishProfile({
      firestore: db,
      authorId: profile.authorId,
      expectedVersion: profile.version,
      nowIso: NOW,
      actorUid: "uid-1",
    });

    expect(published.visibility).toBe("published");
    expect(published.slug).toBe("taylor-example");

    const snapshot = (
      await db.collection("cmsAuthorProfilesPublic").doc(profile.authorId).get()
    ).data();
    expect(snapshot.displayName).toBe("Taylor Example");
    expect(snapshot.slug).toBe("taylor-example");

    // The stored public document must carry no private field. This is the same
    // guarantee the pure spec asserts, re-checked against what actually landed
    // in Firestore, because a storage-layer field merge is exactly how a
    // redaction contract gets bypassed.
    for (const field of AUTHOR_PRIVATE_FIELDS) {
      expect(Object.keys(snapshot)).not.toContain(field);
    }
    expect(JSON.stringify(snapshot)).not.toContain("example.org");
    expect(JSON.stringify(snapshot)).not.toContain("uid-1");

    const slugDoc = (
      await db.collection("cmsAuthorSlugs").doc("taylor-example").get()
    ).data();
    expect(slugDoc).toMatchObject({
      authorId: profile.authorId,
      state: "active",
    });
    expect(await auditActions()).toEqual([
      "author_profile.create",
      "author_profile.publish",
    ]);
  });

  it("publishes and withdraws a public profile with serializer disabled", async () => {
    const profile = await activeProfile();
    await seedPublicationRuntime("ready");
    await db.doc("system/publicDeployment/controls/serializer").set({ schemaVersion: 1, enabled: false });
    const { profile: published } = await publishProfile({ firestore: db, authorId: profile.authorId,
      expectedVersion: profile.version, nowIso: LATER, actorUid: "uid-1" });
    expect((await db.doc(`cmsAuthorProfilesPublic/${profile.authorId}`).get()).exists).toBe(true);
    await withdrawProfile({ firestore: db, authorId: profile.authorId, reason: "admin",
      expectedVersion: published.version, nowIso: LATER, actorUid: "uid-admin" });
    expect((await db.doc(`cmsAuthorProfilesPublic/${profile.authorId}`).get()).exists).toBe(false);
  });
  it("refuses to publish a linked profile for guide-only staff", async () => {
    await seedUser("uid-staff", { grants: [{ role: "staff" }] });
    const { profile } = await ensure("uid-staff");

    await expect(
      publishProfile({
        firestore: db,
        authorId: profile.authorId,
        expectedVersion: profile.version,
        nowIso: NOW,
        actorUid: "uid-staff",
      }),
    ).rejects.toMatchObject({ status: 403, code: "author_access_required" });

    expect((await db.collection("cmsAuthorProfilesPublic").get()).empty).toBe(
      true,
    );
  });

  it.each(["paused", "starting"])(
    "refuses publication while the publication runtime is %s",
    async (phase) => {
      const profile = await activeProfile();
      await seedPublicationRuntime(phase);

      await expect(
        publishProfile({
          firestore: db,
          authorId: profile.authorId,
          expectedVersion: profile.version,
          nowIso: LATER,
          actorUid: "uid-1",
        }),
      ).rejects.toMatchObject({ status: 409, code: "failed-precondition" });

      expect(await versionOf(profile.authorId)).toBe(profile.version);
      expect((await db.collection("cmsAuthorProfilesPublic").get()).empty).toBe(
        true,
      );
      expect(await auditActions()).toEqual(["author_profile.create"]);
    },
  );

  it.each([
    [
      "edit",
      (profile) =>
        updateWorkingProfile({
          firestore: db,
          authorId: profile.authorId,
          patch: { displayName: "Changed Name" },
          expectedVersion: profile.version,
          nowIso: LATER,
          actorUid: "uid-1",
        }),
    ],
    [
      "withdrawal",
      (profile) =>
        withdrawProfile({
          firestore: db,
          authorId: profile.authorId,
          reason: "admin",
          expectedVersion: profile.version,
          nowIso: LATER,
          actorUid: "uid-admin",
        }),
    ],
    [
      "slug rename",
      (profile) =>
        renameProfileSlug({
          firestore: db,
          authorId: profile.authorId,
          slug: "changed-name",
          expectedVersion: profile.version,
          nowIso: LATER,
          actorUid: "uid-admin",
        }),
    ],
    [
      "archive",
      (profile) =>
        archiveProfile({
          firestore: db,
          authorId: profile.authorId,
          expectedVersion: profile.version,
          nowIso: LATER,
          actorUid: "uid-admin",
        }),
    ],
  ])("refuses a paused published-profile %s without a partial write", async (_label, mutate) => {
    const profile = await activeProfile();
    const { profile: published } = await publishProfile({
      firestore: db,
      authorId: profile.authorId,
      expectedVersion: profile.version,
      nowIso: NOW,
      actorUid: "uid-1",
    });
    const profileRef = db.collection("cmsAuthorProfiles").doc(profile.authorId);
    const publicRef = db
      .collection("cmsAuthorProfilesPublic")
      .doc(profile.authorId);
    const before = (await profileRef.get()).data();
    const publicBefore = (await publicRef.get()).data();
    const auditBefore = await auditActions();
    const slugBefore = (
      await db.collection("cmsAuthorSlugs").orderBy("slug").get()
    ).docs.map((doc) => doc.data());
    await seedPublicationRuntime("paused");

    await expect(mutate(published)).rejects.toMatchObject({
      status: 409,
      code: "failed-precondition",
    });

    expect((await profileRef.get()).data()).toEqual(before);
    expect((await publicRef.get()).data()).toEqual(publicBefore);
    expect(await auditActions()).toEqual(auditBefore);
    expect(
      (await db.collection("cmsAuthorSlugs").orderBy("slug").get()).docs.map(
        (doc) => doc.data(),
      ),
    ).toEqual(slugBefore);
  });

  it.each([
    ["guide-only", { grants: [{ role: "staff" }] }],
    ["empty grants", { grants: [] }],
    ["empty scope", { grants: [{ role: "contributor", sections: [] }] }],
    ["inactive", { active: false }],
    ["missing account", null],
  ])("refuses published edits for an owner with %s access", async (_label, account) => {
    const profile = await activeProfile();
    await seedUser("uid-admin", { role: "admin", grants: [] });
    const { profile: published } = await publishProfile({
      firestore: db,
      authorId: profile.authorId,
      expectedVersion: profile.version,
      nowIso: NOW,
      actorUid: "uid-1",
    });
    const userRef = db.collection("users").doc("uid-1");
    if (account === null) await userRef.delete();
    else await userRef.update(account);
    const before = await profileStorage();

    for (const actorUid of ["uid-1", "uid-admin"]) {
      await expect(updateWorkingProfile({
        firestore: db,
        authorId: published.authorId,
        patch: { displayName: "Updated name", photo: null },
        expectedVersion: await versionOf(published.authorId),
        nowIso: LATER,
        actorUid,
      })).rejects.toMatchObject({ status: 403, code: "author_access_required" });
      expect(await profileStorage()).toEqual(before);
    }
  });

  it("keeps a scoped contributor's published edits working", async () => {
    const profile = await activeProfile();
    await db.collection("users").doc("uid-1").update({
      grants: [{ role: "contributor", sections: ["news"] }],
    });
    const { profile: published } = await publishProfile({
      firestore: db,
      authorId: profile.authorId,
      expectedVersion: profile.version,
      nowIso: NOW,
      actorUid: "uid-1",
    });

    const { profile: updated } = await updateWorkingProfile({
      firestore: db,
      authorId: published.authorId,
      patch: { displayName: "Updated name" },
      expectedVersion: published.version,
      nowIso: LATER,
      actorUid: "uid-1",
    });
    expect(updated.displayName).toBe("Updated name");
    expect((await db.collection("cmsAuthorProfilesPublic").get()).empty).toBe(
      false,
    );
  });

  it("keeps an unlinked managed profile's published edits working", async () => {
    const { profile } = await createManagedProfile({
      firestore: db,
      displayName: "Managed author",
      nowIso: NOW,
      actorUid: "uid-admin",
      randomHex: nextHex(),
    });
    const { profile: published } = await publishProfile({
      firestore: db,
      authorId: profile.authorId,
      expectedVersion: profile.version,
      nowIso: NOW,
      actorUid: "uid-admin",
    });

    const { profile: updated } = await updateWorkingProfile({
      firestore: db,
      authorId: published.authorId,
      patch: { displayName: "Updated name" },
      expectedVersion: published.version,
      nowIso: LATER,
      actorUid: "uid-admin",
    });
    expect(updated.displayName).toBe("Updated name");
    expect(
      (await db.collection("cmsAuthorProfilesPublic").get()).empty,
    ).toBe(false);
  });

  it("keeps a private draft editable after the owner loses authoring access", async () => {
    const profile = await activeProfile();
    await db.collection("users").doc("uid-1").update({
      grants: [{ role: "staff" }],
    });

    const { profile: updated } = await updateWorkingProfile({
      firestore: db,
      authorId: profile.authorId,
      patch: { displayName: "Draft name" },
      expectedVersion: profile.version,
      nowIso: LATER,
      actorUid: "uid-1",
    });
    expect(updated.displayName).toBe("Draft name");
    expect((await db.collection("cmsAuthorProfilesPublic").get()).empty).toBe(
      true,
    );
  });

  it("allows a private draft edit while publication is paused", async () => {
    const profile = await activeProfile();
    await seedPublicationRuntime("paused");

    const { profile: updated } = await updateWorkingProfile({
      firestore: db,
      authorId: profile.authorId,
      patch: { displayName: "Draft Name" },
      expectedVersion: profile.version,
      nowIso: LATER,
      actorUid: "uid-1",
    });

    expect(updated.displayName).toBe("Draft Name");
    expect((await db.collection("cmsAuthorProfilesPublic").get()).empty).toBe(
      true,
    );
    expect(await auditActions()).toEqual([
      "author_profile.create",
      "author_profile.update",
    ]);
  });

  it("refuses to delete a stray public snapshot while publication is paused", async () => {
    const profile = await activeProfile();
    const publicRef = db
      .collection("cmsAuthorProfilesPublic")
      .doc(profile.authorId);
    await publicRef.set({ authorId: profile.authorId, displayName: "Stray" });
    await seedPublicationRuntime("paused");

    await expect(
      withdrawProfile({
        firestore: db,
        authorId: profile.authorId,
        reason: "admin",
        expectedVersion: profile.version,
        nowIso: LATER,
        actorUid: "uid-admin",
      }),
    ).rejects.toMatchObject({ status: 409, code: "failed-precondition" });

    expect((await publicRef.get()).exists).toBe(true);
    expect(await versionOf(profile.authorId)).toBe(profile.version);
    expect(await auditActions()).toEqual(["author_profile.create"]);
  });

  it("fails closed on a malformed publication runtime control", async () => {
    const profile = await activeProfile();
    await seedPublicationRuntime("ready", { serializerId: "" });

    await expect(
      publishProfile({
        firestore: db,
        authorId: profile.authorId,
        expectedVersion: profile.version,
        nowIso: LATER,
        actorUid: "uid-1",
      }),
    ).rejects.toMatchObject({ status: 409, code: "failed-precondition" });
    expect(await versionOf(profile.authorId)).toBe(profile.version);
    expect((await db.collection("cmsAuthorProfilesPublic").get()).empty).toBe(
      true,
    );
  });

  it("publishes when the publication runtime is ready", async () => {
    const profile = await activeProfile();
    await seedPublicationRuntime("ready");

    const { profile: published } = await publishProfile({
      firestore: db,
      authorId: profile.authorId,
      expectedVersion: profile.version,
      nowIso: LATER,
      actorUid: "uid-1",
    });

    expect(published.visibility).toBe("published");
    expect(
      (
        await db
          .collection("cmsAuthorProfilesPublic")
          .doc(profile.authorId)
          .get()
      ).exists,
    ).toBe(true);
  });

  it("refuses to publish a deactivated author", async () => {
    const profile = await activeProfile();
    await db.collection("users").doc("uid-1").update({ active: false });
    await expect(
      publishProfile({
        firestore: db,
        authorId: profile.authorId,
        expectedVersion: profile.version,
        nowIso: NOW,
        actorUid: "uid-1",
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect((await db.collection("cmsAuthorProfilesPublic").get()).empty).toBe(
      true,
    );
  });

  it("deletes the snapshot on withdrawal and keeps the slug reserved", async () => {
    const profile = await activeProfile();
    await publishProfile({
      firestore: db,
      authorId: profile.authorId,
      expectedVersion: await versionOf(profile.authorId),
      nowIso: NOW,
      actorUid: "uid-1",
    });
    const { profile: withdrawn } = await withdrawProfile({
      firestore: db,
      authorId: profile.authorId,
      reason: "admin",
      expectedVersion: await versionOf(profile.authorId),
      nowIso: LATER,
      actorUid: "uid-admin",
    });

    expect((await db.doc("system/publicDeployment/contexts/public").get()).data().withdrawalRevision).toBe(1);
    expect(withdrawn.visibility).toBe("private");
    expect(withdrawn.slug).toBe("taylor-example");
    expect(
      (
        await db
          .collection("cmsAuthorProfilesPublic")
          .doc(profile.authorId)
          .get()
      ).exists,
    ).toBe(false);
    // The slug row survives, so the route stays reserved for this person.
    expect(
      (await db.collection("cmsAuthorSlugs").doc("taylor-example").get())
        .exists,
    ).toBe(true);
    expect(await auditActions()).toContain("author_profile.withdraw");
  });

  it("republishes to the same slug without claiming a second one", async () => {
    const profile = await activeProfile();
    await publishProfile({
      firestore: db,
      authorId: profile.authorId,
      expectedVersion: await versionOf(profile.authorId),
      nowIso: NOW,
      actorUid: "uid-1",
    });
    await withdrawProfile({
      firestore: db,
      authorId: profile.authorId,
      reason: "owner",
      expectedVersion: await versionOf(profile.authorId),
      nowIso: LATER,
      actorUid: "uid-1",
    });
    const { profile: again } = await publishProfile({
      firestore: db,
      authorId: profile.authorId,
      expectedVersion: await versionOf(profile.authorId),
      nowIso: LATER,
      actorUid: "uid-1",
    });

    expect(again.slug).toBe("taylor-example");
    expect((await db.collection("cmsAuthorSlugs").get()).size).toBe(1);
  });

  it("suffixes a slug when two authors share a name", async () => {
    const first = await activeProfile("uid-1");
    await seedUser("uid-2");
    const { profile: second } = await ensure("uid-2");

    await publishProfile({
      firestore: db,
      authorId: first.authorId,
      expectedVersion: await versionOf(first.authorId),
      nowIso: NOW,
      actorUid: "uid-1",
    });
    const { profile: published } = await publishProfile({
      firestore: db,
      authorId: second.authorId,
      expectedVersion: second.version,
      nowIso: NOW,
      actorUid: "uid-2",
    });
    expect(published.slug).toBe("taylor-example-2");
  });

  it("rejects a stale write with a version conflict", async () => {
    const profile = await activeProfile();
    await expect(
      updateWorkingProfile({
        firestore: db,
        authorId: profile.authorId,
        patch: { displayName: "New Name" },
        expectedVersion: profile.version + 5,
        nowIso: LATER,
        actorUid: "uid-1",
      }),
    ).rejects.toMatchObject({ status: 409, code: "version_conflict" });
  });

  it("refuses every mutation that does not name the version it opened", async () => {
    // An omitted expectedVersion used to pass, which silently turned two
    // concurrent editors into last-write-wins instead of the promised 409.
    const profile = await activeProfile();
    const expectedRefusal = {
      status: 400,
      code: "expected_version_required",
    };

    await expect(
      updateWorkingProfile({
        firestore: db,
        authorId: profile.authorId,
        patch: { displayName: "New Name" },
        nowIso: LATER,
        actorUid: "uid-1",
      }),
    ).rejects.toMatchObject(expectedRefusal);
    await expect(
      publishProfile({
        firestore: db,
        authorId: profile.authorId,
        nowIso: LATER,
        actorUid: "uid-1",
      }),
    ).rejects.toMatchObject(expectedRefusal);
    await expect(
      withdrawProfile({
        firestore: db,
        authorId: profile.authorId,
        reason: "owner",
        nowIso: LATER,
        actorUid: "uid-1",
      }),
    ).rejects.toMatchObject(expectedRefusal);
    await expect(
      renameProfileSlug({
        firestore: db,
        authorId: profile.authorId,
        slug: "t-example",
        nowIso: LATER,
        actorUid: "uid-admin",
      }),
    ).rejects.toMatchObject(expectedRefusal);

    // Nothing was written by any of the four refusals.
    expect(await versionOf(profile.authorId)).toBe(profile.version);
    expect(await auditActions()).toEqual(["author_profile.create"]);
  });

  it("refuses a version that is not a positive integer", async () => {
    const profile = await activeProfile();
    for (const expectedVersion of [0, -1, 1.5, "1", null]) {
      await expect(
        updateWorkingProfile({
          firestore: db,
          authorId: profile.authorId,
          patch: { displayName: "New Name" },
          expectedVersion,
          nowIso: LATER,
          actorUid: "uid-1",
        }),
      ).rejects.toMatchObject({
        status: 400,
        code: "expected_version_required",
      });
    }
  });

  it("gives the second of two concurrent editors a conflict, not a silent win", async () => {
    const profile = await activeProfile();
    const opened = profile.version;
    await updateWorkingProfile({
      firestore: db,
      authorId: profile.authorId,
      patch: { displayName: "First Writer" },
      expectedVersion: opened,
      nowIso: LATER,
      actorUid: "uid-1",
    });
    await expect(
      updateWorkingProfile({
        firestore: db,
        authorId: profile.authorId,
        patch: { displayName: "Second Writer" },
        expectedVersion: opened,
        nowIso: LATER,
        actorUid: "uid-1",
      }),
    ).rejects.toMatchObject({ status: 409, code: "version_conflict" });
    expect(
      (
        await db.collection("cmsAuthorProfiles").doc(profile.authorId).get()
      ).data().displayName,
    ).toBe("First Writer");
  });

  it("re-snapshots a published profile when its content is edited", async () => {
    const profile = await activeProfile();
    await publishProfile({
      firestore: db,
      authorId: profile.authorId,
      expectedVersion: await versionOf(profile.authorId),
      nowIso: NOW,
      actorUid: "uid-1",
    });
    await updateWorkingProfile({
      firestore: db,
      authorId: profile.authorId,
      patch: {
        displayName: "Taylor Example",
        jobTitle: "Director",
        links: { x: { handle: "njpbs", url: "https://x.com/njpbs" } },
      },
      expectedVersion: await versionOf(profile.authorId),
      nowIso: LATER,
      actorUid: "uid-1",
    });
    const snapshot = (
      await db.collection("cmsAuthorProfilesPublic").doc(profile.authorId).get()
    ).data();
    expect(snapshot.jobTitle).toBe("Director");
    expect(snapshot.links.x.url).toBe("https://x.com/njpbs");
  });

  // Omitted preserves, null clears, and a photograph is resolved against the
  // media library before it is stored. All three are exercised against real
  // media_assets documents in the "profile photographs" suite below, because the
  // rule only means anything alongside the asset it points at.

  it("refuses an invalid social link at the storage boundary", async () => {
    const profile = await activeProfile();
    await expect(
      updateWorkingProfile({
        firestore: db,
        authorId: profile.authorId,
        patch: {
          displayName: "Taylor Example",
          links: {
            x: { handle: "njpbs", url: "https://x.com.evil.example/njpbs" },
          },
        },
        expectedVersion: profile.version,
        nowIso: LATER,
        actorUid: "uid-1",
      }),
    ).rejects.toMatchObject({ status: 400, code: "validation_failed" });
  });
});

describe("admin rename and listing", () => {
  it("retires the old slug and claims the new one", async () => {
    await seedUser("uid-1");
    const { profile } = await ensure("uid-1");
    await publishProfile({
      firestore: db,
      authorId: profile.authorId,
      expectedVersion: await versionOf(profile.authorId),
      nowIso: NOW,
      actorUid: "uid-1",
    });

    const { profile: renamed } = await renameProfileSlug({
      firestore: db,
      authorId: profile.authorId,
      slug: "t-example",
      expectedVersion: await versionOf(profile.authorId),
      nowIso: LATER,
      actorUid: "uid-admin",
    });

    expect(renamed.slug).toBe("t-example");
    expect(renamed.previousSlugs).toEqual(["taylor-example"]);
    expect(
      (
        await db.collection("cmsAuthorSlugs").doc("taylor-example").get()
      ).data().state,
    ).toBe("retired");
    expect(
      (await db.collection("cmsAuthorSlugs").doc("t-example").get()).data()
        .state,
    ).toBe("active");

    const snapshot = (
      await db.collection("cmsAuthorProfilesPublic").doc(profile.authorId).get()
    ).data();
    // The snapshot carries the redirect history the public build needs.
    expect(snapshot.slug).toBe("t-example");
    expect(snapshot.previousSlugs).toEqual(["taylor-example"]);
  });

  it("refuses a rename onto a retired slug so a redirect never changes owner", async () => {
    await seedUser("uid-1");
    const { profile } = await ensure("uid-1");
    await publishProfile({
      firestore: db,
      authorId: profile.authorId,
      expectedVersion: await versionOf(profile.authorId),
      nowIso: NOW,
      actorUid: "uid-1",
    });
    await renameProfileSlug({
      firestore: db,
      authorId: profile.authorId,
      slug: "t-example",
      expectedVersion: await versionOf(profile.authorId),
      nowIso: LATER,
      actorUid: "uid-admin",
    });

    await seedUser("uid-2", { displayName: "Jordan Example" });
    const { profile: other } = await ensure("uid-2");
    await publishProfile({
      firestore: db,
      authorId: other.authorId,
      expectedVersion: other.version,
      nowIso: NOW,
      actorUid: "uid-2",
    });
    await expect(
      renameProfileSlug({
        firestore: db,
        authorId: other.authorId,
        slug: "taylor-example",
        expectedVersion: await versionOf(other.authorId),
        nowIso: LATER,
        actorUid: "uid-admin",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("lists profiles with a bounded page", async () => {
    for (const uid of ["uid-1", "uid-2", "uid-3"]) {
      await seedUser(uid, { displayName: `Person ${uid}` });
      await ensure(uid);
    }
    const page = await listAuthorProfiles({ firestore: db, limit: 2 });
    expect(page.profiles).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();

    const rest = await listAuthorProfiles({
      firestore: db,
      limit: 2,
      startAfter: page.nextCursor,
    });
    expect(rest.profiles).toHaveLength(1);
    expect(rest.nextCursor).toBeNull();
  });
});

describe("byline directory", () => {
  function fakeRes() {
    return {
      statusCode: null,
      body: null,
      headersSent: false,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        this.headersSent = true;
        return this;
      },
    };
  }

  async function listBylineAuthorsAs(uid, body = {}) {
    const res = fakeRes();
    await authorApiPkg.createListBylineAuthorsHandler({
      firestore: db,
      requirePrincipalFn: async () => ({
        uid,
        email: `${uid}@example.org`,
        // A Firebase account with no CMS approval resolves to exactly this: an
        // identity with no grants. Nothing about it is a refusal, which is the
        // whole reason this endpoint has to check admission itself.
        principal: { id: uid, grants: [] },
      }),
      log: { error: () => {} },
    })({ method: "POST", headers: {}, ip: null, body }, res);
    return res;
  }

  it("refuses a Firebase account that has no approved CMS account", async () => {
    await seedUser("uid-1", { displayName: "Taylor Example" });
    await ensure("uid-1");

    const res = await listBylineAuthorsAs("uid-nobody");

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe("approval_required");
    // Nothing about who works here reached an unapproved caller.
    expect(res.body.authors).toBeUndefined();
  });

  it("refuses a deactivated account", async () => {
    await seedUser("uid-1", { displayName: "Taylor Example" });
    await ensure("uid-1");
    await seedUser("uid-off", { displayName: "Former Staff", active: false });

    const res = await listBylineAuthorsAs("uid-off");

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe("account_inactive");
    expect(res.body.authors).toBeUndefined();
  });

  it("serves an approved active account the directory and its own id", async () => {
    await seedUser("uid-1", { displayName: "Taylor Example" });
    await seedUser("uid-2", { displayName: "Jordan Example" });
    const { staff } = await ensure("uid-2");
    await ensure("uid-1");

    const res = await listBylineAuthorsAs("uid-2");

    expect(res.statusCode).toBe(200);
    expect(res.body.authors.map((author) => author.displayName)).toEqual([
      "Jordan Example",
      "Taylor Example",
    ]);
    expect(res.body.selfAuthorId).toBe(staff.authorId);
    // Names and opaque ids only.
    for (const author of res.body.authors) {
      expect(author.uid).toBeUndefined();
      expect(author.email).toBeUndefined();
    }
  });

  it("does not default a new post to an archived self profile", async () => {
    await seedUser("uid-1", { displayName: "Taylor Example" });
    const { profile } = await ensure("uid-1");
    await archiveProfile({
      firestore: db,
      authorId: profile.authorId,
      expectedVersion: profile.version,
      nowIso: LATER,
      actorUid: "uid-admin",
    });

    const res = await listBylineAuthorsAs("uid-1");

    expect(res.statusCode).toBe(200);
    expect(res.body.selfAuthorId).toBeNull();
    expect(res.body.authors.map((author) => author.authorId)).not.toContain(
      profile.authorId,
    );
  });

  it("drops a deactivated author from the directory but keeps their credits readable", async () => {
    await seedUser("uid-1", { displayName: "Taylor Example" });
    await seedUser("uid-2", { displayName: "Jordan Example" });
    await seedUser("uid-admin", { role: "super_admin" });
    const { staff: departing } = await ensure("uid-1");
    await ensure("uid-2");

    const before = await listBylineAuthorsAs("uid-2");
    expect(before.body.authors.map((author) => author.authorId)).toContain(
      departing.authorId,
    );

    await withdrawProfileForDeactivation({
      firestore: db,
      uid: "uid-1",
      nowIso: LATER,
      actorUid: "uid-admin",
      actorEmail: "uid-admin@example.org",
    });

    const after = await listBylineAuthorsAs("uid-2");
    expect(after.body.authors.map((author) => author.authorId)).not.toContain(
      departing.authorId,
    );
    // The linkage row is marked inactive rather than deleted, and the change is
    // audited like every other mutation to account data.
    const linkage = (
      await db.collection("cmsStaffRecords").doc("uid-1").get()
    ).data();
    expect(linkage.status).toBe("inactive");
    expect(linkage.authorId).toBe(departing.authorId);
    expect(await auditActions()).toContain("author_profile.staff_resync");

    // A story that already credits them still resolves to one identity: the join
    // key and the working profile both survive the offboarding, so the byline on
    // published work keeps reading correctly.
    const identities = await readAuthorIdentities({
      firestore: db,
      authorIds: [departing.authorId],
    });
    const identity = identities.get(departing.authorId);
    expect(identity.displayName).toBe("Taylor Example");
    expect(identity.active).toBe(false);
  });

  it("deactivates the linkage through the real deactivateStaff handler", async () => {
    await seedUser("uid-1", { displayName: "Taylor Example" });
    await seedUser("uid-admin", { role: "super_admin" });
    const { staff } = await ensure("uid-1");

    const handler = staffPkg.createDeactivateStaffHandler({
      firestore: db,
      authClient: {
        updateUser: async () => {},
        revokeRefreshTokens: async () => {},
        getUser: async () => ({ tokensValidAfterTime: LATER }),
      },
      requireSuperAdminFn: async () => ({
        uid: "uid-admin",
        email: "uid-admin@example.org",
      }),
      now: () => LATER,
      nowIso: () => LATER,
      log: { error: () => {} },
    });
    const res = fakeRes();
    await handler(
      { method: "POST", headers: {}, body: { targetUid: "uid-1" }, ip: null },
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(
      (await db.collection("cmsStaffRecords").doc("uid-1").get()).data().status,
    ).toBe("inactive");
    expect(staff.status).toBe("active");
  });

  it("does not write a second audit row for a repeated offboarding", async () => {
    await seedUser("uid-1", { displayName: "Taylor Example" });
    await ensure("uid-1");
    const withdrawal = {
      firestore: db,
      uid: "uid-1",
      nowIso: LATER,
      actorUid: "uid-admin",
    };
    const first = await withdrawProfileForDeactivation(withdrawal);
    const second = await withdrawProfileForDeactivation(withdrawal);

    expect(first.linkageDeactivated).toBe(true);
    expect(second.linkageDeactivated).toBe(false);
    expect(
      (await auditActions()).filter(
        (action) => action === "author_profile.staff_resync",
      ),
    ).toHaveLength(1);
  });
});

describe("deactivation semantics", () => {
  it("withdraws the public profile and keeps the stable authorId", async () => {
    await seedUser("uid-1");
    const { profile } = await ensure("uid-1");
    await publishProfile({
      firestore: db,
      authorId: profile.authorId,
      expectedVersion: await versionOf(profile.authorId),
      nowIso: NOW,
      actorUid: "uid-1",
    });

    const result = await withdrawProfileForDeactivation({
      firestore: db,
      uid: "uid-1",
      nowIso: LATER,
      actorUid: "uid-admin",
    });

    // No expectedVersion: offboarding is a forced, system-driven withdrawal with
    // no opened form behind it, and it must not fail on a race while a public
    // profile is still standing.
    expect(result.withdrawn).toBe(true);
    expect(result.profile.visibility).toBe("private");
    expect(result.profile.withdrawnReason).toBe("deactivation");
    // The join key survives, so already-published Post bylines still resolve to
    // one identity even though the public author page is gone.
    expect(result.profile.authorId).toBe(profile.authorId);
    expect(
      (
        await db
          .collection("cmsAuthorProfilesPublic")
          .doc(profile.authorId)
          .get()
      ).exists,
    ).toBe(false);
  });

  it("takes the public snapshot down through the real deactivateStaff handler", async () => {
    // The store-level withdrawal above is only half the guarantee: it has to be
    // wired into the offboarding boundary staff actually use, or a deactivated
    // author keeps a live public page.
    await seedUser("uid-1");
    await seedUser("uid-admin", { role: "super_admin" });
    const { profile } = await ensure("uid-1");
    await publishProfile({
      firestore: db,
      authorId: profile.authorId,
      expectedVersion: await versionOf(profile.authorId),
      nowIso: NOW,
      actorUid: "uid-1",
    });
    expect(
      (
        await db
          .collection("cmsAuthorProfilesPublic")
          .doc(profile.authorId)
          .get()
      ).exists,
    ).toBe(true);

    const handler = staffPkg.createDeactivateStaffHandler({
      firestore: db,
      authClient: {
        updateUser: async () => {},
        revokeRefreshTokens: async () => {},
        getUser: async () => ({ tokensValidAfterTime: LATER }),
      },
      requireSuperAdminFn: async () => ({
        uid: "uid-admin",
        email: "uid-admin@example.org",
      }),
      now: () => LATER,
      nowIso: () => LATER,
      log: { error: () => {} },
    });

    const res = {
      statusCode: null,
      body: null,
      headersSent: false,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        this.headersSent = true;
        return this;
      },
    };
    await handler(
      { method: "POST", headers: {}, body: { targetUid: "uid-1" }, ip: null },
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.publicProfileWithdrawn).toBe(true);
    expect(
      (
        await db
          .collection("cmsAuthorProfilesPublic")
          .doc(profile.authorId)
          .get()
      ).exists,
    ).toBe(false);
    // The working profile and its stable join key survive the offboarding.
    const working = await db
      .collection("cmsAuthorProfiles")
      .doc(profile.authorId)
      .get();
    expect(working.data().visibility).toBe("private");
    expect(working.data().withdrawnReason).toBe("deactivation");
    expect(working.data().authorId).toBe(profile.authorId);

    // The queryable linkage row goes inactive with the account. It used to stay
    // "active" forever: the byline directory then contradicted the account state,
    // and the disabled person could never resync it themselves, because every
    // self endpoint refuses a deactivated account before reaching the repair.
    const staff = (
      await db.collection("cmsStaffRecords").doc("uid-1").get()
    ).data();
    expect(staff.status).toBe("inactive");
    expect(staff.authorId).toBe(profile.authorId);
    expect(staff.updatedBy).toBe("uid-admin");
    // Account data never changes silently: the flip is audited in the same
    // transaction, following the module's resync row.
    const resyncRows = (await db.collection("admin_logs").get()).docs
      .map((doc) => doc.data())
      .filter((row) => row.action === "author_profile.staff_resync");
    expect(resyncRows).toHaveLength(1);
    expect(resyncRows[0].target).toBe("cmsStaffRecords/uid-1");
    expect(resyncRows[0].before.status).toBe("active");
    expect(resyncRows[0].after.status).toBe("inactive");
    expect(resyncRows[0].actorUid).toBe("uid-admin");
  });

  it("returns 503 with CMS access disabled when a paused runtime blocks deactivation withdrawal", async () => {
    await seedUser("uid-1");
    await seedUser("uid-admin", { role: "super_admin" });
    const { profile } = await ensure("uid-1");
    await publishProfile({
      firestore: db,
      authorId: profile.authorId,
      expectedVersion: profile.version,
      nowIso: NOW,
      actorUid: "uid-1",
    });
    await seedPublicationRuntime("paused");

    let authTouched = false;
    const handler = staffPkg.createDeactivateStaffHandler({
      firestore: db,
      authClient: {
        updateUser: async () => {
          authTouched = true;
        },
        revokeRefreshTokens: async () => {
          authTouched = true;
        },
        getUser: async () => {
          authTouched = true;
          return { tokensValidAfterTime: LATER };
        },
      },
      requireSuperAdminFn: async () => ({
        uid: "uid-admin",
        email: "uid-admin@example.org",
      }),
      now: () => LATER,
      nowIso: () => LATER,
      log: { error: () => {} },
    });
    const res = {
      statusCode: null,
      body: null,
      headersSent: false,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        this.headersSent = true;
        return this;
      },
    };

    await handler(
      { method: "POST", headers: {}, body: { targetUid: "uid-1" }, ip: null },
      res,
    );

    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({
      cmsAccessDisabled: true,
      uid: "uid-1",
    });
    expect(authTouched).toBe(false);
    expect((await db.collection("users").doc("uid-1").get()).data()).toMatchObject({
      active: false,
      role: null,
      grants: [],
    });
    expect(
      (await db.collection("cmsStaffRecords").doc("uid-1").get()).data().status,
    ).toBe("inactive");
    expect(
      (
        await db
          .collection("cmsAuthorProfilesPublic")
          .doc(profile.authorId)
          .get()
      ).exists,
    ).toBe(true);
    expect(
      (await db.collection("cmsAuthorProfiles").doc(profile.authorId).get()).data()
        .visibility,
    ).toBe("published");
  });

  it("is a no-op for an author who was never published", async () => {
    await seedUser("uid-1");
    await ensure("uid-1");
    const result = await withdrawProfileForDeactivation({
      firestore: db,
      uid: "uid-1",
      nowIso: LATER,
      actorUid: "uid-admin",
    });
    expect(result.withdrawn).toBe(false);
  });
});

describe("private backfill", () => {
  it("creates linkage for every active named user and is idempotent", async () => {
    await seedUser("uid-1", { displayName: "Taylor Example" });
    await seedUser("uid-2", { displayName: "Jordan Example" });
    await seedUser("uid-off", { displayName: "Former Staff", active: false });

    const first = await backfillAuthorProfiles({
      firestore: db,
      nowIso: NOW,
      randomHex: nextHex,
    });
    expect(first.created.sort()).toEqual(["uid-1", "uid-2"]);
    expect(first.skippedInactive).toEqual(["uid-off"]);
    expect(first.needsMapping).toEqual([]);

    const second = await backfillAuthorProfiles({
      firestore: db,
      nowIso: NOW,
      randomHex: nextHex,
    });
    expect(second.created).toEqual([]);
    expect(second.verified.sort()).toEqual(["uid-1", "uid-2"]);

    // One audit row per creation, none for the verify pass.
    expect(await auditActions()).toEqual([
      "author_profile.backfill",
      "author_profile.backfill",
    ]);
    const staff = (
      await db.collection("cmsStaffRecords").doc("uid-1").get()
    ).data();
    expect(staff.createdBy).toBe(SYSTEM_ACTOR);
    // Nothing the backfill writes is public.
    expect((await db.collection("cmsAuthorProfilesPublic").get()).empty).toBe(
      true,
    );
  });

  it("reports rather than guesses when an account has no name", async () => {
    await seedUser("uid-1", { displayName: "" });
    const result = await backfillAuthorProfiles({
      firestore: db,
      nowIso: NOW,
      randomHex: nextHex,
    });
    expect(result.needsMapping).toEqual(["uid-1"]);
    expect(result.created).toEqual([]);
    expect((await db.collection("cmsStaffRecords").get()).empty).toBe(true);
  });

  it("uses an explicit mapping, including one naming a staff content record", async () => {
    await seedUser("uid-1", { displayName: "" });
    await seedUser("uid-2", { displayName: "" });
    // The content storage contract routes every non-page kind, staff included,
    // to cmsPosts. A decoy in cmsPages proves the lookup does not read there.
    await db
      .collection("cmsPosts")
      .doc("staff-record-9")
      .set({ type: "staff", name: "Casey Fixture", role: "Engineer" });
    await db
      .collection("cmsPages")
      .doc("staff-record-9")
      .set({ type: "staff", name: "Wrong Collection", role: "Decoy" });

    const result = await backfillAuthorProfiles({
      firestore: db,
      nowIso: NOW,
      randomHex: nextHex,
      mapping: {
        "uid-1": { displayName: "Taylor Example" },
        "uid-2": { staffContentId: "staff-record-9" },
      },
    });
    expect(result.created.sort()).toEqual(["uid-1", "uid-2"]);

    const linked = await readProfileByUid({ firestore: db, uid: "uid-2" });
    expect(linked.profile.displayName).toBe("Casey Fixture");
  });

  it("lets an explicit mapping correct a stale user-document name", async () => {
    // Rule 1 of the linkage rule: the mapping wins. The whole reason an operator
    // writes one is that the account's stored name is wrong -- a legal name, a
    // misspelling, a placeholder from an SSO import -- and a mapping that only
    // applied when the stored name happened to be empty would silently discard
    // the correction and put the stale name on a byline.
    await seedUser("uid-1", { displayName: "S. Example (MSU account)" });
    await seedUser("uid-2", { displayName: "Jordan Example" });

    const result = await backfillAuthorProfiles({
      firestore: db,
      nowIso: NOW,
      randomHex: nextHex,
      mapping: { "uid-1": { displayName: "Taylor Example" } },
    });
    expect(result.created.sort()).toEqual(["uid-1", "uid-2"]);

    const corrected = await readProfileByUid({ firestore: db, uid: "uid-1" });
    expect(corrected.profile.displayName).toBe("Taylor Example");
    // The unmapped account is untouched by the change: with no mapping entry the
    // user document is still what seeds the name.
    const untouched = await readProfileByUid({ firestore: db, uid: "uid-2" });
    expect(untouched.profile.displayName).toBe("Jordan Example");
  });

  it("fails before writing when a mapping names an unknown uid", async () => {
    await seedUser("uid-1");
    await expect(
      backfillAuthorProfiles({
        firestore: db,
        nowIso: NOW,
        randomHex: nextHex,
        mapping: { "uid-typo": { displayName: "Nobody" } },
      }),
    ).rejects.toThrow(/not CMS users|are not CMS users/);
    expect((await db.collection("cmsStaffRecords").get()).empty).toBe(true);
  });

  it("never matches a staff content record by name", () => {
    // The linkage rule in one assertion: with no stored display name and no
    // mapping, a staff content record with exactly the right name is still not
    // used, because names are not identities.
    const staffContentById = new Map([
      ["staff-record-9", { type: "staff", name: "Taylor Example" }],
    ]);
    expect(
      resolveSeedName({
        uid: "uid-1",
        userDoc: { email: "texample@example.org" },
        mappingEntry: undefined,
        staffContentById,
      }),
    ).toBeNull();
  });

  it("refuses a mapping that points at a missing or nameless record", () => {
    expect(() =>
      resolveSeedName({
        uid: "uid-1",
        userDoc: {},
        mappingEntry: { staffContentId: "nope" },
        staffContentById: new Map(),
      }),
    ).toThrow(/does not exist/);
    expect(() =>
      resolveSeedName({
        uid: "uid-1",
        userDoc: {},
        mappingEntry: {},
        staffContentById: new Map(),
      }),
    ).toThrow(/displayName or staffContentId/);
  });
});

describe("self endpoints", () => {
  function fakeRes() {
    return {
      statusCode: null,
      body: null,
      headersSent: false,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        this.headersSent = true;
        return this;
      },
    };
  }

  function selfDeps(uid) {
    return {
      firestore: db,
      requirePrincipalFn: async () => ({
        uid,
        email: `${uid}@example.org`,
        principal: principalPkg.principalFromUserDoc(
          uid,
          (await db.collection("users").doc(uid).get()).data(),
        ),
      }),
      log: { error: () => {} },
    };
  }

  it.each([
    { name: "legacy contributor", fields: { grants: [{ role: "contributor" }] } },
    { name: "contributor tier with stale owner role", fields: { accessTier: "contributor", role: "super_admin" } },
  ])("refuses $name self publication without changing the saved profile", async ({ fields }) => {
    await db.doc("system/staffAccessActivation").set({ schema: 1, state: "active", cleanScan: true });
    await seedUser("uid-contributor", fields);
    const { profile } = await ensure("uid-contributor");
    const before = await profileStorage();
    const res = fakeRes();
    await authorApiPkg.createSetAuthorProfileVisibilityHandler(selfDeps("uid-contributor"))(
      { method: "POST", headers: {}, body: { visibility: "published", expectedVersion: profile.version } }, res,
    );
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe("profile_publish_access_required");
    expect(await profileStorage()).toEqual(before);
  });

  it.each([
    { name: "scoped legacy editor", fields: { grants: [{ role: "editor", sections: ["news"] }] } },
    ...["editor", "publisher", "admin", "owner"].map((accessTier) => ({
      name: accessTier, fields: { accessTier, grants: [] },
    })),
  ])("allows $name to publish their own profile", async ({ fields }) => {
    await db.doc("system/staffAccessActivation").set({ schema: 1, state: "active", cleanScan: true });
    await seedUser("uid-editor", fields);
    const { profile } = await ensure("uid-editor");
    const res = fakeRes();
    await authorApiPkg.createSetAuthorProfileVisibilityHandler(selfDeps("uid-editor"))(
      { method: "POST", headers: {}, body: { visibility: "published", expectedVersion: profile.version } }, res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.profile.visibility).toBe("published");
    expect((await db.doc(`cmsAuthorProfilesPublic/${profile.authorId}`).get()).data().authorId).toBe(profile.authorId);
  });

  it("keeps contributor self withdrawal available", async () => {
    await seedUser("uid-contributor", { grants: [{ role: "contributor" }] });
    const { profile } = await ensure("uid-contributor");
    // An admin may publish this contributor's profile from Staff profiles.
    const { profile: published } = await publishProfile({
      firestore: db, authorId: profile.authorId, expectedVersion: profile.version,
      nowIso: NOW, actorUid: "uid-admin",
    });
    const res = fakeRes();
    await authorApiPkg.createSetAuthorProfileVisibilityHandler(selfDeps("uid-contributor"))(
      { method: "POST", headers: {}, body: { visibility: "private", expectedVersion: published.version } }, res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.profile.visibility).toBe("private");
    expect((await db.doc(`cmsAuthorProfilesPublic/${profile.authorId}`).get()).exists).toBe(false);
  });

  it("refuses every self-profile endpoint for guide-only staff", async () => {
    await seedUser("uid-staff", { grants: [{ role: "staff" }] });

    for (const handler of [
      authorApiPkg.createGetAuthorProfileHandler(selfDeps("uid-staff")),
      authorApiPkg.createUpdateAuthorProfileHandler(
        selfDeps("uid-staff"),
      ),
      authorApiPkg.createSetAuthorProfileVisibilityHandler(
        selfDeps("uid-staff"),
      ),
    ]) {
      const res = fakeRes();
      await handler(
        {
          method: "POST",
          headers: {},
          ip: null,
          body: {
            displayName: "Orientation only",
            expectedVersion: 1,
            visibility: "published",
          },
        },
        res,
      );
      expect(res.statusCode).toBe(403);
      expect(res.body.code).toBe("author_access_required");
    }

    expect((await db.collection("cmsAuthorProfiles").get()).empty).toBe(true);
    expect((await db.collection("cmsAuthorProfilesPublic").get()).empty).toBe(
      true,
    );
  });

  it("refuses a deactivated account on read and on update", async () => {
    await seedUser("uid-off", { active: false });

    for (const handler of [
      authorApiPkg.createGetAuthorProfileHandler(selfDeps("uid-off")),
      authorApiPkg.createUpdateAuthorProfileHandler(selfDeps("uid-off")),
    ]) {
      const res = fakeRes();
      await handler(
        {
          method: "POST",
          headers: {},
          ip: null,
          body: { displayName: "Former Staff", expectedVersion: 1 },
        },
        res,
      );
      expect(res.statusCode).toBe(403);
      expect(res.body.code).toBe("account_inactive");
    }
    // No profile was minted for the refused account, and nothing went public.
    expect((await db.collection("cmsAuthorProfiles").get()).empty).toBe(true);
    expect((await db.collection("cmsAuthorProfilesPublic").get()).empty).toBe(
      true,
    );
  });

  it("repairs a stale staff record before refusing a deactivated self request", async () => {
    await seedUser("uid-off");
    await ensure("uid-off");
    await db.collection("users").doc("uid-off").update({ active: false });

    const res = fakeRes();
    await authorApiPkg.createGetAuthorProfileHandler(selfDeps("uid-off"))(
      { method: "POST", headers: {}, ip: null, body: {} },
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe("account_inactive");
    expect(
      (await db.collection("cmsStaffRecords").doc("uid-off").get()).data()
        .status,
    ).toBe("inactive");
  });

  it("still verify-or-creates on first contact for an active account", async () => {
    await seedUser("uid-1");
    const res = fakeRes();
    await authorApiPkg.createGetAuthorProfileHandler(selfDeps("uid-1"))(
      { method: "POST", headers: {}, ip: null, body: {} },
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.created).toBe(true);
    expect(res.body.profile.version).toBe(1);
  });

  it("refuses a self update that names no version", async () => {
    await seedUser("uid-1");
    await ensure("uid-1");
    const res = fakeRes();
    await authorApiPkg.createUpdateAuthorProfileHandler(selfDeps("uid-1"))(
      {
        method: "POST",
        headers: {},
        ip: null,
        body: { displayName: "Taylor Example" },
      },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe("expected_version_required");
  });
});

// -- profile photographs ------------------------------------------------------
//
// The photograph is the one profile field whose validity depends on a second
// collection, so these run against real media_assets documents: the bounds are
// read from the library record, never from the request, and nothing between an
// upload and a public page reviews the result.

describe("profile photographs", () => {
  const PHOTO_URL =
    "https://media.njpbs.org/cms-media/staff-profile/asset-1/abc.jpg";

  async function seedAsset(id = "asset-1", overrides = {}) {
    await db
      .collection("media_assets")
      .doc(id)
      .set({
        id,
        name: "Profile photo: Taylor Example",
        originalName: "headshot.jpg",
        category: "staff-profile",
        mimeType: "image/jpeg",
        kind: "image",
        sizeBytes: 120_000,
        width: 800,
        height: 800,
        url: PHOTO_URL,
        license: "Profile photo: supplied by the staff member, cleared for use",
        credit: null,
        lifecycle: "active",
        source: "upload",
        version: 1,
        createdBy: "uid-1",
        createdAt: NOW,
        updatedAt: NOW,
        updatedBy: "uid-1",
        ...overrides,
      });
    return id;
  }

  async function activeProfile(uid = "uid-1") {
    await seedUser(uid);
    const { profile } = await ensure(uid);
    return profile;
  }

  function photoRequest(overrides = {}) {
    return {
      assetId: "asset-1",
      focalX: 0.25,
      focalY: 0.75,
      rightsBasis: "own-photo",
      ...overrides,
    };
  }

  async function attach(profile, overrides = {}, options = {}) {
    return updateWorkingProfile({
      firestore: db,
      authorId: profile.authorId,
      patch: { displayName: "Taylor Example", photo: photoRequest(overrides) },
      expectedVersion: await versionOf(profile.authorId),
      nowIso: LATER,
      actorUid: "uid-1",
      ...options,
    });
  }

  it.each(["reserved", "object_ready"])("refuses a late photo attachment while replacement is %s", async state => {
    const profile = await activeProfile();
    await seedAsset();
    const replacementRef = db.collection("system/media/replacements").doc("asset-1");
    const claim = { state, assetId: "asset-1", attemptId: "replacement-one" };
    await replacementRef.set(claim);

    await expect(attach(profile)).rejects.toMatchObject({
      status: 409, code: "photo_replacement_in_progress",
    });
    expect((await db.doc(`cmsAuthorProfiles/${profile.authorId}`).get()).data()).toMatchObject({
      photo: null, version: profile.version,
    });
    expect((await replacementRef.get()).data()).toEqual(claim);
    expect(await auditActions()).not.toContain("author_profile.photo_attach");

    // A completed replacement atomically updates the asset and releases its
    // claim. The later attachment must use the replacement photograph.
    const nextUrl = "https://media.njpbs.org/cms-media/staff-profile/asset-1/replaced.jpg";
    const completed = db.batch();
    completed.update(db.doc("media_assets/asset-1"), { url: nextUrl, version: 2 });
    completed.delete(replacementRef);
    await completed.commit();
    const { profile: attached } = await attach(profile);
    expect(attached.photo.url).toBe(nextUrl);
  });

  it("keeps a saved WebP through a later edit until the library says it is animated", async () => {
    const profile = await activeProfile();
    const url = "https://media.njpbs.org/cms-media/staff-profile/asset-webp/abc.webp";
    await seedAsset("asset-webp", { mimeType: "image/webp", url });
    await expect(attach(profile, { assetId: "asset-webp" })).rejects.toMatchObject({
      status: 400,
    });

    await db.collection("media_assets").doc("asset-webp").update({ animated: false });
    const { profile: attached } = await attach(profile, { assetId: "asset-webp" });
    expect(attached.photo.mimeType).toBe("image/webp");

    await db.collection("media_assets").doc("asset-webp").update({
      animated: admin.firestore.FieldValue.delete(),
    });
    const { profile: renamed } = await updateWorkingProfile({
      firestore: db,
      authorId: profile.authorId,
      patch: {
        displayName: "Taylor E. Example",
        photo: photoRequest({ assetId: "asset-webp", focalX: 0.4 }),
      },
      expectedVersion: await versionOf(profile.authorId),
      nowIso: LATER,
      actorUid: "uid-1",
    });
    expect(renamed.displayName).toBe("Taylor E. Example");
    expect(renamed.photo).toMatchObject({ assetId: "asset-webp", focalX: 0.4 });

    await db.collection("media_assets").doc("asset-webp").update({ animated: true });
    await expect(updateWorkingProfile({
      firestore: db,
      authorId: profile.authorId,
      patch: {
        displayName: "Taylor E. Example",
        photo: photoRequest({ assetId: "asset-webp" }),
      },
      expectedVersion: await versionOf(profile.authorId),
      nowIso: LATER,
      actorUid: "uid-1",
    })).rejects.toMatchObject({ status: 400 });
  });

  it("attaches a photo from the library, stamping the attestation and auditing it", async () => {
    const profile = await activeProfile();
    await seedAsset();
    const { profile: updated } = await attach(profile);

    expect(updated.photo).toEqual({
      assetId: "asset-1",
      url: PHOTO_URL,
      mimeType: "image/jpeg",
      width: 800,
      height: 800,
      sizeBytes: 120_000,
      focalX: 0.25,
      focalY: 0.75,
      credit: null,
      rightsBasis: "own-photo",
      attestedAt: LATER,
      attestedBy: "uid-1",
      attachedAt: LATER,
    });
    expect(await auditActions()).toContain("author_profile.photo_attach");
  });

  it("reads the bounds from the library record rather than the request", async () => {
    const profile = await activeProfile();
    // Every one of these is a way a client-stated fact would have let a bad
    // photograph through: the record is small, animated, over-size, or retired.
    // The library category is not a bound.
    const cases = [
      { width: 320, height: 320 },
      { mimeType: "image/gif" },
      { sizeBytes: 6 * 1024 * 1024 },
      { lifecycle: "tombstoned" },
    ];
    for (const [index, overrides] of cases.entries()) {
      const id = await seedAsset(`asset-bad-${index}`, overrides);
      await expect(attach(profile, { assetId: id })).rejects.toMatchObject({
        status: 400,
        code: "validation_failed",
      });
    }
    // An id that names nothing is refused too, rather than stored as a dangling
    // reference the public build would have to cope with.
    await expect(
      attach(profile, { assetId: "asset-missing" }),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      (
        await db.collection("cmsAuthorProfiles").doc(profile.authorId).get()
      ).data().photo,
    ).toBeNull();
  });

  it("requires a rights basis, and a credit when the photo is licensed", async () => {
    const profile = await activeProfile();
    await seedAsset();
    await seedAsset("asset-licensed", {
      license: "Profile photo: licensed from a third party, credit required",
    });
    await expect(
      attach(profile, { rightsBasis: undefined }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      attach(profile, {
        assetId: "asset-licensed",
        rightsBasis: "licensed-photo",
      }),
    ).rejects.toMatchObject({ status: 400 });
    const { profile: updated } = await attach(profile, {
      assetId: "asset-licensed",
      rightsBasis: "licensed-photo",
      credit: "Ryan Jones",
    });
    expect(updated.photo.credit).toBe("Ryan Jones");
  });

  // Library category and license do not block a profile photo. The basis staff
  // confirm is saved with the profile and its audit row; the Admin warns when it
  // differs from the library license.
  it("records the confirmed rights basis from any library image", async () => {
    const profile = await activeProfile();
    await seedAsset("asset-general", { category: "general", license: "NJ PBS owned" });
    const { profile: updated } = await attach(profile, {
      assetId: "asset-general",
      rightsBasis: "station-photo",
    });
    expect(updated.photo).toMatchObject({ assetId: "asset-general", rightsBasis: "station-photo" });
    expect(await auditActions()).toContain("author_profile.photo_attach");

    // A new basis on the same file is a new attestation with its own audit row.
    const { profile: rebased } = await attach(updated, {
      assetId: "asset-general",
      rightsBasis: "own-photo",
    });
    expect(rebased.photo.rightsBasis).toBe("own-photo");
    expect((await auditActions()).filter((action) => action === "author_profile.photo_attach")).toHaveLength(2);

    await seedAsset("asset-station", {
      license: "Profile photo: NJ PBS or Montclair State photograph",
    });
    const { profile: claimed } = await attach(rebased, {
      assetId: "asset-station",
      rightsBasis: "own-photo",
    });
    expect(claimed.photo.rightsBasis).toBe("own-photo");
  });

  it("lets a staff member keep a photo an admin attached, but not take someone else's", async () => {
    const profile = await activeProfile();
    // Uploaded by an admin on this person's behalf.
    await seedAsset("asset-admin", { createdBy: "uid-admin" });

    // The self path refuses to bind an asset this caller did not upload.
    await expect(
      attach(
        profile,
        { assetId: "asset-admin" },
        { requireAssetOwnerUid: "uid-1" },
      ),
    ).rejects.toMatchObject({ status: 403, code: "photo_not_owned" });

    // The admin path may bind it, and afterwards the owner's own saves keep it:
    // otherwise a photograph set for someone would break their next edit.
    await attach(profile, { assetId: "asset-admin" });
    const { profile: kept } = await attach(
      profile,
      { assetId: "asset-admin", focalY: 0.1 },
      { requireAssetOwnerUid: "uid-1" },
    );
    expect(kept.photo.assetId).toBe("asset-admin");
    expect(kept.photo.focalY).toBe(0.1);
  });

  it("keeps the attestation through a recrop and re-takes it for a new photo", async () => {
    const profile = await activeProfile();
    await seedAsset();
    await seedAsset("asset-2", {
      url: `${PHOTO_URL}?v=2`.replace("?v=2", "-2.jpg"),
    });
    const first = (await attach(profile)).profile.photo;

    const recropped = (await attach(profile, { focalX: 0.9 })).profile.photo;
    expect(recropped.attestedAt).toBe(first.attestedAt);
    expect(recropped.attachedAt).toBe(first.attachedAt);

    const replaced = (await attach(profile, { assetId: "asset-2" })).profile
      .photo;
    expect(replaced.assetId).toBe("asset-2");
    // Replacing is a new asset, never a rewritten binary: the first photograph is
    // still in the library, untouched.
    expect(
      (await db.collection("media_assets").doc("asset-1").get()).data()
        .lifecycle,
    ).toBe("active");
  });

  it("preserves the photo when a save omits it and clears it on an explicit null", async () => {
    const profile = await activeProfile();
    await seedAsset();
    await attach(profile);

    // A text-only save must not take someone's photograph down.
    const { profile: textOnly } = await updateWorkingProfile({
      firestore: db,
      authorId: profile.authorId,
      patch: { displayName: "Taylor Example", jobTitle: "Director" },
      expectedVersion: await versionOf(profile.authorId),
      nowIso: LATER,
      actorUid: "uid-1",
    });
    expect(textOnly.photo.assetId).toBe("asset-1");

    const { profile: cleared } = await updateWorkingProfile({
      firestore: db,
      authorId: profile.authorId,
      patch: { displayName: "Taylor Example", photo: null },
      expectedVersion: await versionOf(profile.authorId),
      nowIso: LATER,
      actorUid: "uid-1",
    });
    expect(cleared.photo).toBeNull();
    expect(await auditActions()).toContain("author_profile.photo_remove");
    // Removal withdraws the use, not the binary: the original stays in the
    // library behind the tombstone fence rather than being deleted.
    const asset = (
      await db.collection("media_assets").doc("asset-1").get()
    ).data();
    expect(asset.lifecycle).toBe("active");
    expect(asset.storageKey ?? asset.url).toBeTruthy();
  });

  it("carries the crop into the public snapshot and removes it with the photo", async () => {
    const profile = await activeProfile();
    await seedAsset();
    await attach(profile);
    await publishProfile({
      firestore: db,
      authorId: profile.authorId,
      expectedVersion: await versionOf(profile.authorId),
      nowIso: LATER,
      actorUid: "uid-1",
    });

    const publicRef = db
      .collection("cmsAuthorProfilesPublic")
      .doc(profile.authorId);
    const snapshot = (await publicRef.get()).data();
    // Everything the public page needs to draw the square crop without reading
    // the media library, and nothing about who attested to it.
    expect(snapshot.photo).toEqual({
      assetId: "asset-1",
      url: PHOTO_URL,
      mimeType: "image/jpeg",
      width: 800,
      height: 800,
      focalX: 0.25,
      focalY: 0.75,
      credit: null,
    });
    expect(JSON.stringify(snapshot)).not.toContain("attestedBy");

    await updateWorkingProfile({
      firestore: db,
      authorId: profile.authorId,
      patch: { displayName: "Taylor Example", photo: null },
      expectedVersion: await versionOf(profile.authorId),
      nowIso: LATER,
      actorUid: "uid-1",
    });
    expect((await publicRef.get()).data().photo).toBeNull();
  });

  it("copies library thumbnails onto the profile and the public snapshot", async () => {
    const profile = await activeProfile();
    const thumb = "https://media.njpbs.org/cms-media/staff-profile/asset-1/thumbs/abc-w480.webp";
    await seedAsset("asset-1", {
      thumbnails: [{
        url: thumb,
        width: 480,
        height: 480,
        storageKey: "cms-media/staff-profile/asset-1/thumbs/abc-w480.webp",
      }],
    });
    const { profile: updated } = await attach(profile);
    expect(updated.photo.thumbnails).toEqual([{ url: thumb, width: 480, height: 480 }]);
    expect(updated.photo).not.toHaveProperty("storageKey");

    await publishProfile({
      firestore: db,
      authorId: profile.authorId,
      expectedVersion: await versionOf(profile.authorId),
      nowIso: LATER,
      actorUid: "uid-1",
    });
    const published = (await db.collection("cmsAuthorProfilesPublic").doc(profile.authorId).get()).data();
    expect(published.photo.thumbnails).toEqual([{ url: thumb, width: 480, height: 480 }]);
    expect(JSON.stringify(published.photo)).not.toContain("storageKey");
  });

  it("copies library thumbnails onto an older portrait when it is published", async () => {
    const profile = await activeProfile();
    const thumb = "https://media.njpbs.org/cms-media/staff-profile/asset-1/thumbs/abc-w480.webp";
    await seedAsset("asset-1", {
      thumbnails: [{ url: thumb, width: 480, height: 480, storageKey: "secret" }],
    });
    const { profile: updated } = await attach(profile);
    const older = { ...updated.photo };
    delete older.thumbnails;
    await db.collection("cmsAuthorProfiles").doc(profile.authorId).update({ photo: older });
    const { profile: publishedProfile } = await publishProfile({
      firestore: db,
      authorId: profile.authorId,
      expectedVersion: await versionOf(profile.authorId),
      nowIso: LATER,
      actorUid: "uid-1",
    });
    expect(publishedProfile.photo.thumbnails).toEqual([{ url: thumb, width: 480, height: 480 }]);
    const published = (await db.collection("cmsAuthorProfilesPublic").doc(profile.authorId).get()).data();
    expect(published.photo.thumbnails).toEqual([{ url: thumb, width: 480, height: 480 }]);
    expect(JSON.stringify(published.photo)).not.toContain("secret");
  });

  it("does not copy thumbnails from a replaced binary onto an attested photo", async () => {
    const profile = await activeProfile();
    const thumb = "https://media.njpbs.org/cms-media/staff-profile/asset-1/thumbs/new-w480.webp";
    await seedAsset("asset-1", {
      url: "https://media.njpbs.org/cms-media/staff-profile/asset-1/new.jpg",
      width: 900,
      height: 900,
      thumbnails: [{ url: thumb, width: 480, height: 480, storageKey: "secret" }],
    });
    const { profile: updated } = await attach(profile);
    const attested = {
      ...updated.photo,
      url: PHOTO_URL,
      width: 800,
      height: 800,
    };
    delete attested.thumbnails;
    await db.collection("cmsAuthorProfiles").doc(profile.authorId).update({ photo: attested });
    const { profile: publishedProfile } = await publishProfile({
      firestore: db,
      authorId: profile.authorId,
      expectedVersion: await versionOf(profile.authorId),
      nowIso: LATER,
      actorUid: "uid-1",
    });
    expect(publishedProfile.photo.url).toBe(PHOTO_URL);
    expect(publishedProfile.photo.thumbnails).toBeUndefined();
  });

  it("withdraws the photo with the profile when the account is deactivated", async () => {
    const profile = await activeProfile();
    await seedAsset();
    await attach(profile);
    await publishProfile({
      firestore: db,
      authorId: profile.authorId,
      expectedVersion: await versionOf(profile.authorId),
      nowIso: LATER,
      actorUid: "uid-1",
    });

    await withdrawProfileForDeactivation({
      firestore: db,
      uid: "uid-1",
      nowIso: LATER,
      actorUid: "uid-admin",
    });

    // The public page and its photograph are gone together; the working profile
    // keeps the photograph so reactivating restores what the person had.
    expect(
      (
        await db
          .collection("cmsAuthorProfilesPublic")
          .doc(profile.authorId)
          .get()
      ).exists,
    ).toBe(false);
    expect(
      (
        await db.collection("cmsAuthorProfiles").doc(profile.authorId).get()
      ).data().photo.assetId,
    ).toBe("asset-1");
  });

  // -- the tombstone fence ----------------------------------------------------
  //
  // The media lifecycle boundary decides "is this asset still in use" with one
  // collection-group query over `mediaUsage` documents. A profile that points at
  // a photograph without registering one is invisible to that query, so a media
  // manager could retire a file a published profile was still showing. These run
  // the real lifecycle handler, because the fence is that query and nothing else.

  async function tombstone(assetId, version) {
    const res = {
      statusCode: null,
      body: null,
      headersSent: false,
      set: () => res,
      status: (code) => {
        res.statusCode = code;
        return res;
      },
      json: (payload) => {
        res.body = payload;
        res.headersSent = true;
        return res;
      },
    };
    await createCmsSetMediaLifecycleHandler({
      firestore: db,
      requirePrincipalFn: async () => ({
        uid: "uid-admin",
        email: "admin@example.org",
        principal: { id: "uid-admin", grants: [{ role: "super_admin" }] },
      }),
      now: () => LATER,
      log: { warn: () => {}, error: () => {} },
    })(
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "if-match": formatMediaEtag(assetId, version),
        },
        body: { assetId, action: "tombstone" },
        ip: "203.0.113.29",
      },
      res,
    );
    return res;
  }

  /** The lifecycle boundary needs a public deployment receipt to act at all. */
  async function seedDeploymentReceipt() {
    await db
      .collection("system")
      .doc("publicDeployment")
      .set({
        schemaVersion: 1,
        mediaLifecycleReady: true,
        state: "idle",
      activeGeneration: 7,
      activeDeploymentId: "deployment-7",
      activeCommitSha: "b".repeat(40),
      lastReservedGeneration: 7,
      newestEligibleGeneration: 7,
      newestEligibleBuildBatchId: "build-seven",
    });
  }

  async function usageFor(authorId, state) {
    const snapshot = await db
      .collection(`cmsAuthorProfiles/${authorId}/mediaUsage`)
      .doc(state)
      .get();
    return snapshot.exists ? snapshot.data() : null;
  }

  it("registers the photograph in the usage fence, so it cannot be tombstoned", async () => {
    const profile = await activeProfile();
    await Promise.all([seedAsset(), seedDeploymentReceipt()]);
    await attach(profile);

    expect((await usageFor(profile.authorId, "working")).assetIds).toEqual([
      "asset-1",
    ]);
    const refused = await tombstone("asset-1", 1);
    expect(refused.statusCode).toBe(409);
    expect(refused.body.error).toMatch(/still used/i);
    expect(
      (await db.collection("media_assets").doc("asset-1").get()).data()
        .lifecycle,
    ).toBe("active");
  });

  it("frees the photograph when it is cleared from the profile", async () => {
    const profile = await activeProfile();
    await Promise.all([seedAsset(), seedDeploymentReceipt()]);
    await attach(profile);

    await updateWorkingProfile({
      firestore: db,
      authorId: profile.authorId,
      patch: { displayName: "Taylor Example", photo: null },
      expectedVersion: await versionOf(profile.authorId),
      nowIso: LATER,
      actorUid: "uid-1",
    });

    expect((await usageFor(profile.authorId, "working")).assetIds).toEqual([]);
    const accepted = await tombstone("asset-1", 1);
    expect(accepted.statusCode).toBe(200);
    expect(
      (await db.collection("media_assets").doc("asset-1").get()).data()
        .lifecycle,
    ).toBe("tombstoned");
  });

  it("holds the published claim only while the profile is public", async () => {
    const profile = await activeProfile();
    await Promise.all([seedAsset(), seedDeploymentReceipt()]);
    await attach(profile);
    // A private profile claims the asset for its working state, never for the
    // published one: nothing public is showing it yet.
    expect((await usageFor(profile.authorId, "published")).assetIds).toEqual(
      [],
    );

    await publishProfile({
      firestore: db,
      authorId: profile.authorId,
      expectedVersion: await versionOf(profile.authorId),
      nowIso: LATER,
      actorUid: "uid-1",
    });
    expect((await usageFor(profile.authorId, "published")).assetIds).toEqual([
      "asset-1",
    ]);

    await withdrawProfileForDeactivation({
      firestore: db,
      uid: "uid-1",
      nowIso: LATER,
      actorUid: "uid-admin",
    });

    // Withdrawal releases the published claim. The working profile keeps the
    // photograph, so the asset is still fenced -- reactivating restores what the
    // person had, and it must not have been retired underneath them.
    expect((await usageFor(profile.authorId, "published")).assetIds).toEqual(
      [],
    );
    expect((await usageFor(profile.authorId, "working")).assetIds).toEqual([
      "asset-1",
    ]);
    const refused = await tombstone("asset-1", 1);
    expect(refused.statusCode).toBe(409);
  });

  it("refuses to publish a profile whose photo left the library", async () => {
    const profile = await activeProfile();
    await seedAsset();
    await attach(profile);
    // The asset is retired after it was attached. The stored copy still names a
    // usable image, so publication proceeds -- the snapshot is detached by
    // design. What must not happen is a re-save silently reattaching it.
    await db
      .collection("media_assets")
      .doc("asset-1")
      .update({ lifecycle: "tombstoned" });
    await expect(attach(profile)).rejects.toMatchObject({
      status: 400,
      code: "validation_failed",
    });
  });
});

describe("author-page controls", () => {
  // Pin and hide change what ONE author page lists. They are the only fields on
  // the profile whose whole point is a public rendering decision, so what is
  // pinned here is that they are bounded, versioned and audited like every other
  // profile edit -- and that neither can touch a post.
  it("stores a pin and a bounded hidden list and carries both into the snapshot", async () => {
    await seedUser("uid-pin");
    const { profile } = await ensure("uid-pin");
    await publishProfile({
      firestore: db,
      authorId: profile.authorId,
      expectedVersion: profile.version,
      nowIso: NOW,
      actorUid: "uid-pin",
    });

    const { profile: updated } = await updateWorkingProfile({
      firestore: db,
      authorId: profile.authorId,
      patch: {
        displayName: profile.displayName,
        pinnedPostId: "post-pinned",
        hiddenPostIds: ["post-hidden", "post-hidden", "post-other"],
      },
      expectedVersion: await versionOf(profile.authorId),
      nowIso: LATER,
      actorUid: "uid-pin",
    });
    expect(updated.pinnedPostId).toBe("post-pinned");
    // Deduplicated, order preserved.
    expect(updated.hiddenPostIds).toEqual(["post-hidden", "post-other"]);

    const snapshot = (
      await db.collection("cmsAuthorProfilesPublic").doc(profile.authorId).get()
    ).data();
    expect(snapshot.pinnedPostId).toBe("post-pinned");
    expect(snapshot.hiddenPostIds).toEqual(["post-hidden", "post-other"]);
  });

  it("preserves the stored controls when a save does not mention them", async () => {
    // The admin roster edits a profile's text without rendering these controls.
    // A whole-state rule would discard an author's curation on every such save.
    await seedUser("uid-keep");
    const { profile } = await ensure("uid-keep");
    await updateWorkingProfile({
      firestore: db,
      authorId: profile.authorId,
      patch: {
        displayName: profile.displayName,
        pinnedPostId: "post-pinned",
        hiddenPostIds: ["post-hidden"],
      },
      expectedVersion: profile.version,
      nowIso: LATER,
      actorUid: "uid-keep",
    });
    const { profile: after } = await updateWorkingProfile({
      firestore: db,
      authorId: profile.authorId,
      patch: { displayName: "Renamed By An Admin" },
      expectedVersion: await versionOf(profile.authorId),
      nowIso: LATER,
      actorUid: "uid-admin",
    });
    expect(after.pinnedPostId).toBe("post-pinned");
    expect(after.hiddenPostIds).toEqual(["post-hidden"]);
  });

  it("refuses an unbounded hidden list, a bad id, and a pinned-and-hidden post", async () => {
    await seedUser("uid-bounds");
    const { profile } = await ensure("uid-bounds");
    const patch = (extra) => ({
      firestore: db,
      authorId: profile.authorId,
      patch: { displayName: profile.displayName, ...extra },
      expectedVersion: profile.version,
      nowIso: LATER,
      actorUid: "uid-bounds",
    });

    await expect(
      updateWorkingProfile(
        patch({
          hiddenPostIds: Array.from(
            { length: 51 },
            (_, index) => `post-${index}`,
          ),
        }),
      ),
    ).rejects.toMatchObject({ status: 400, code: "validation_failed" });
    await expect(
      updateWorkingProfile(patch({ hiddenPostIds: ["../escape"] })),
    ).rejects.toMatchObject({ status: 400, code: "validation_failed" });
    await expect(
      updateWorkingProfile(patch({ pinnedPostId: "post/one" })),
    ).rejects.toMatchObject({ status: 400, code: "validation_failed" });
    await expect(
      updateWorkingProfile(
        patch({ pinnedPostId: "post-one", hiddenPostIds: ["post-one"] }),
      ),
    ).rejects.toMatchObject({ status: 400, code: "validation_failed" });
  });

  it("requires the version the form was opened at, like every other edit", async () => {
    await seedUser("uid-version");
    const { profile } = await ensure("uid-version");
    await expect(
      updateWorkingProfile({
        firestore: db,
        authorId: profile.authorId,
        patch: { displayName: profile.displayName, pinnedPostId: "post-one" },
        expectedVersion: profile.version + 5,
        nowIso: LATER,
        actorUid: "uid-version",
      }),
    ).rejects.toMatchObject({ status: 409, code: "version_conflict" });
  });

  it("audits the pin and the size of the hidden list", async () => {
    await seedUser("uid-audit");
    const { profile } = await ensure("uid-audit");
    await updateWorkingProfile({
      firestore: db,
      authorId: profile.authorId,
      patch: {
        displayName: profile.displayName,
        pinnedPostId: "post-pinned",
        hiddenPostIds: ["post-a", "post-b"],
      },
      expectedVersion: profile.version,
      nowIso: LATER,
      actorUid: "uid-audit",
    });
    const rows = await db.collection("admin_logs").get();
    const after = rows.docs
      .map((document) => document.data())
      .find((row) => row.after?.pinnedPostId === "post-pinned");
    expect(after).toBeTruthy();
    // The ids themselves stay on the profile document the row points at; the row
    // records that a curation choice was made and by whom.
    expect(after.after.hiddenPostCount).toBe(2);
  });
});

describe("error contract", () => {
  it("carries an http status on every refusal", () => {
    const error = new AuthorProfileError(409, "conflict", "version_conflict");
    expect(error.status).toBe(409);
    expect(error.code).toBe("version_conflict");
  });
});

it("change-log: author publish and withdrawal append with their public projection", async () => {
  const { initialPublicDeploymentPointer } = await import("../../functions/lib/public-deployment.js");
  await db.doc("system/publicDeployment").set({ ...initialPublicDeploymentPointer(), activeCommitSha: "a".repeat(40),
    activeGeneration: 1, activeDeploymentId: "fixture-release", lastReservedGeneration: 1,
    newestEligibleGeneration: 1, newestEligibleBuildBatchId: "fixture-release" });
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 1 });
  await seedPublicationRuntime("ready");
  await enrollPublicReleaseLog(db);
  const { profile } = await createManagedProfile({ firestore: db, displayName: "Public Author", nowIso: NOW,
    actorUid: "uid-admin", randomHex: nextHex() });
  expect(await publicReleaseEntries(db)).toHaveLength(0);
  const { profile: published } = await publishProfile({ firestore: db, authorId: profile.authorId,
    expectedVersion: profile.version, nowIso: LATER, actorUid: "uid-admin" });
  expect((await publicReleaseEntries(db))[0].changes).toMatchObject([{ kind: "author", id: profile.authorId, action: "dependency" }]);
  await withdrawProfile({ firestore: db, authorId: profile.authorId, expectedVersion: published.version, nowIso: LATER, actorUid: "uid-admin", reason: "Editorial withdrawal" });
  expect((await publicReleaseEntries(db))[1].changes).toMatchObject([{ kind: "author", id: profile.authorId, action: "withdraw" }]);
  expect((await db.doc(`cmsAuthorProfilesPublic/${profile.authorId}`).get()).exists).toBe(false);
});
