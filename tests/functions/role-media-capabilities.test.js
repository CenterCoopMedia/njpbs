import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { readFileSync } from "node:fs";
import { createRequire, Module } from "node:module";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import admin from "../helpers/firebase-admin.js";

// Role templates land separately. Supply only their capability table here;
// all capability decisions, source admission and transactions use production code.
// Do not add an injected positive permission result to an endpoint.
const roles = {
  video_manager: ["media.video.read", "media.video.manage"],
  image_manager: ["media.manage"],
  video_reader_image_manager: ["media.video.read", "media.manage"],
  profile_manager: ["profiles.manage"],
};
const functionsRoot = fileURLToPath(new URL("../../functions/", import.meta.url));
const require = createRequire(import.meta.url);
const modules = new Map();
function load(relativePath) {
  const filename = resolve(functionsRoot, relativePath);
  if (modules.has(filename)) return modules.get(filename).exports;
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(dirname(filename));
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = (id) => {
    const dependency = createRequire(filename).resolve(id);
    return dependency.startsWith(functionsRoot) && dependency.endsWith(".js") &&
      dependency !== resolve(functionsRoot, "lib/firebase.js")
      ? load(dependency)
      : originalRequire(id);
  };
  modules.set(filename, loaded);
  let source = readFileSync(filename, "utf8");
  if (filename === resolve(functionsRoot, "lib/rbac.js")) {
    const marker = "const ROLE_CAPABILITIES = Object.freeze({";
    if (!source.includes(marker)) throw new Error("RBAC role table moved");
    source = source.replace(marker, `${marker}\n...${JSON.stringify(roles)},`);
  }
  loaded._compile(source, filename);
  return loaded.exports;
}

const rbac = load("lib/rbac.js");
const { principalFromUserDoc } = load("lib/principal.js");
const feedback = load("media-feedback.js");
const media = load("media.js");
const listing = load("list-media.js");
const profiles = load("author-profiles.js");
const store = load("lib/author-profile-store.js");
const { authorizeMediaSource } = load("lib/media-sources.js");
const { AUTHOR_PHOTO_CATEGORY } = require("../../functions/lib/author-profile-contract.js");
const sourceRef = { backend: "s3", sourceId: "video-library", id: "video-1" };
const source = { id: "video-library", prefix: "", access: "active_staff", writable: true };
const registryFn = () => new Map([[source.id, source]]);
let db;

function actor(role, uid = role) {
  return {
    uid, email: `${uid}@example.org`, emailVerified: true, approvedActive: true,
    principal: principalFromUserDoc(uid, { active: true, grants: [{ role }] }),
  };
}

function response() {
  return {
    statusCode: 0, body: null,
    set() { return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function invoke(factory, currentActor, body, extra = {}) {
  const res = response();
  await factory({
    firestore: db,
    requirePrincipalFn: async () => currentActor,
    verifyAppCheckFn: async () => true,
    registryFn,
    log: { error() {}, warn() {} },
    ...extra,
  })({
    method: "POST", body,
    headers: { "content-type": "application/json", "x-firebase-appcheck": "test" },
    rawBody: Buffer.from(JSON.stringify(body)),
  }, res);
  return res;
}

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Use the Firestore emulator");
  if (!admin.apps.length) admin.initializeApp({ projectId: "demo-njpbs" });
  db = isolatedFirestore("role-media-capabilities.test.js");
});

beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  await Promise.all(Object.keys(roles).map(uid => db.doc(`users/${uid}`).set({
    active: true, displayName: uid, grants: [{ role: uid }],
  })));
});

describe("independent media capabilities", () => {
  it("lets a video-only manager moderate video feedback without image management", async () => {
    const currentActor = actor("video_manager");
    expect(rbac.hasCapability(currentActor.principal, "media.manage")).toBe(false);
    await db.doc("mediaSourceAssets/video-1").set({
      sourceId: source.id, lifecycle: "active", name: "Feedback video",
      originalName: "feedback.mp4", nameSort: "feedback video",
      updatedAtSort: "2026-10-07T12:00:00.000Z", mimeType: "video/mp4",
      kind: "video", sizeBytes: 1024, preview: "browser", rightsStatus: "complete",
      license: "Station owned", credit: null, description: null, tags: [], version: 1,
      createdBy: "someone-else", createdAt: "2026-10-07T12:00:00.000Z",
      updatedAt: "2026-10-07T12:00:00.000Z", objectKey: "feedback.mp4",
      objectVersionId: "private-v1",
    });
    const mutate = (who, body) => invoke(feedback.createCmsMutateMediaCommentHandler,
      who, { schemaVersion: 1, ref: sourceRef, requestId: randomUUID(), ...body });
    const created = await mutate(actor("video_manager", "comment-author"), {
      action: "create", text: "Please review this frame",
    });
    expect(created.statusCode, JSON.stringify(created.body)).toBe(200);
    const commentId = created.body.comment.id;
    const listed = await invoke(feedback.createCmsListMediaCommentsHandler, currentActor,
      { schemaVersion: 1, ref: sourceRef });
    expect(listed.statusCode, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.comments[0]).toMatchObject({ id: commentId, canResolve: true });

    // A reader that manages images still cannot moderate someone else's video thread.
    const imageManager = actor("video_reader_image_manager");
    const denied = await mutate(imageManager, { action: "resolve", commentId, baseVersion: 1 });
    expect(denied.statusCode).toBe(403);
    const resolved = await mutate(currentActor, { action: "resolve", commentId, baseVersion: 1 });
    expect(resolved.statusCode, JSON.stringify(resolved.body)).toBe(200);
    const deleted = await mutate(currentActor, { action: "delete", commentId, baseVersion: 2 });
    expect(deleted.statusCode).toBe(403);
    const reopened = await mutate(currentActor, { action: "reopen", commentId, baseVersion: 2 });
    expect(reopened.statusCode, JSON.stringify(reopened.body)).toBe(200);
  });

  it("gives an image-only manager no video source or feedback access", async () => {
    const currentActor = actor("image_manager");
    expect(rbac.hasCapability(currentActor.principal, "media.manage")).toBe(true);
    await expect(authorizeMediaSource({ firestore: db, actor: currentActor, source, operation: "metadata" }))
      .rejects.toMatchObject({ status: 403 });
    for (const factory of [feedback.createCmsListMediaCommentsHandler, feedback.createCmsMutateMediaCommentHandler]) {
      const denied = await invoke(factory, currentActor, {
        schemaVersion: 1, ref: sourceRef,
        ...(factory === feedback.createCmsMutateMediaCommentHandler
          ? { action: "resolve", commentId: "a".repeat(64), baseVersion: 1, requestId: randomUUID() } : {}),
      });
      expect(denied.statusCode, JSON.stringify(denied.body)).toBe(404);
    }
  });

  it("lets a profiles-only manager upload, select and set a photo without general media access", async () => {
    const currentActor = actor("profile_manager");
    for (const capability of ["content.create", "media.upload", "media.manage", "media.video.read"]) {
      expect(rbac.hasCapability(currentActor.principal, capability), capability).toBe(false);
    }
    const buffer = await sharp({ create: { width: 500, height: 500, channels: 3, background: "blue" } }).png().toBuffer();
    const upload = {
      originalName: "portrait.png", mimeType: "image/png", buffer,
      fields: { name: "Profile photo", category: AUTHOR_PHOTO_CATEGORY, altText: "Staff member", license: "Profile photo: NJ PBS or Montclair State photograph" },
    };
    const objects = new Map();
    const storage = {
      async putStaging(value) { objects.set(value.key, value); },
      async putFinal(value) { objects.set(value.key, value); return { created: true }; },
      async head(key) { const value = objects.get(key); return { contentLength: value.body.length, contentType: value.mimeType, metadata: value.metadata }; },
      async deleteStaging(key) { objects.delete(key); },
      async deleteFinal(key) { objects.delete(key); },
    };
    const uploadPhoto = async (fields) => {
      const res = response();
      await media.createCmsUploadMediaHandler({
        firestore: db, requirePrincipalFn: async () => currentActor,
        parseUploadFn: async () => ({ ...upload, fields }), storageFactory: () => storage,
        masterStorageFactory: () => null, publicOrigin: "https://media.njpbs.org",
        maxUploadBytes: 10 * 1024 * 1024,
        log: { error() {}, warn() {} },
      })({ method: "POST", headers: { "content-type": "multipart/form-data; boundary=test" }, rawBody: buffer }, res);
      return res;
    };
    await db.doc(`mediaCategories/${AUTHOR_PHOTO_CATEGORY}`).set({
      id: AUTHOR_PHOTO_CATEGORY, label: "Staff profiles", description: "Profile images", order: 1, active: true, version: 1,
    });
    const uploaded = await uploadPhoto(upload.fields);
    expect(uploaded.statusCode, JSON.stringify(uploaded.body)).toBe(201);
    const assetId = uploaded.body.asset.id;
    const storedPhoto = (await db.doc(`media_assets/${assetId}`).get()).data();
    await db.doc("media_assets/another-photo").set({ ...storedPhoto, id: "another-photo", createdBy: "someone-else" });
    const selected = await invoke(listing.createCmsListMediaHandler, currentActor, {
      categories: [AUTHOR_PHOTO_CATEGORY], kinds: ["image"], profilePhotoScope: "self",
    });
    expect(selected.statusCode, JSON.stringify(selected.body)).toBe(200);
    expect(selected.body.records.map(asset => asset.id)).toEqual([assetId]);
    expect(selected.body.total).toBe(1);
    const { profile } = await store.createManagedProfile({
      firestore: db, displayName: "Staff member", nowIso: "2026-10-07T12:00:00.000Z",
      actorUid: currentActor.uid, actorEmail: currentActor.email, randomHex: "b".repeat(32),
    });
    const saved = await invoke(profiles.createAdminUpdateAuthorProfileHandler, currentActor, {
      apiVersion: 1, action: "edit", authorId: profile.authorId, expectedVersion: profile.version,
      displayName: "Staff member", photo: { assetId, rightsBasis: "station-photo", credit: null },
    });
    expect(saved.statusCode, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.profile.photo.assetId).toBe(assetId);
    expect((await db.doc(`cmsAuthorProfiles/${profile.authorId}`).get()).data().photo.assetId).toBe(assetId);
    const deniedList = await invoke(listing.createCmsListMediaHandler, currentActor, { kinds: ["image"] });
    expect(deniedList.statusCode).toBe(403);
    const countBefore = objects.size;
    const deniedUpload = await uploadPhoto({ ...upload.fields, category: "general" });
    expect(deniedUpload.statusCode).toBe(403);
    expect(objects.size).toBe(countBefore);
  });
});
