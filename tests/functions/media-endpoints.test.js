import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import adminPkg from "../helpers/firebase-admin.js";
import mediaLibrary from "../../functions/lib/media-library.js";
import { deleteApp, initializeApp as initClient } from "firebase/app";
import {
  connectAuthEmulator,
  signInWithEmailAndPassword,
  getAuth,
  signOut,
} from "firebase/auth";

const admin = adminPkg;
const PROJECT = "demo-njpbs";
const REGION = "us-central1";
const FUNCTIONS_HOST = process.env.FUNCTIONS_EMULATOR_HOST || "127.0.0.1:5001";
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const fnUrl = (name) => `http://${FUNCTIONS_HOST}/${PROJECT}/${REGION}/${name}`;

function mediaRecord(id, category) {
  return {
    id,
    name: `${category} asset`,
    originalName: `${id}.png`,
    category,
    tags: [category],
    description: null,
    altText: "Old alt text",
    license: "NJ PBS owned",
    credit: null,
    mimeType: "image/png",
    kind: "image",
    sizeBytes: 128,
    width: 1,
    height: 1,
    contentHash: `${id}-private-hash`,
    storageKey: `cms-media/${category}/${id}/private.png`,
    url: `https://media.njpbs.org/cms-media/${category}/${id}/public.png`,
    lifecycle: "active",
    source: "upload",
    version: 1,
    createdAt: "2026-08-13T12:00:00.000Z",
    createdBy: "seed-user",
    updatedAt: "2026-08-13T12:00:00.000Z",
    updatedBy: "seed-user",
  };
}

describe("media endpoint wiring", () => {
  let db;
  let clientApp;
  let clientAuth;

  beforeAll(() => {
    if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
    db = admin.firestore();
    clientApp = initClient(
      { apiKey: "demo-key", projectId: PROJECT },
      "media-endpoints-test",
    );
    clientAuth = getAuth(clientApp);
    connectAuthEmulator(clientAuth, `http://${AUTH_HOST}`, {
      disableWarnings: true,
    });
  });

  beforeEach(async () => {
    await clearEmulatorFirestore(
      `http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
      { method: "DELETE" },
    );
    await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`, {
      method: "DELETE",
    });
  });

  afterAll(async () => {
    await deleteApp(clientApp);
    await Promise.all(admin.apps.map((app) => app.delete()));
  });

  it("lists media site-wide and updates across categories through real auth", async () => {
    // Finish account creation before password sign-in: refreshing a signup token
    // retains auth_time, which can precede the emulator's validSince.
    await admin.auth().createUser({
      email: "media-news-editor@example.com",
      password: "password123",
      emailVerified: true,
    });
    const credential = await signInWithEmailAndPassword(
      clientAuth, "media-news-editor@example.com", "password123",
    );
    const uid = credential.user.uid;
    await db.collection("users").doc(uid).set({
      role: null,
      grants: [{ role: "editor", sections: ["news"] }],
    });
    const news = mediaRecord("news-one", "news");
    const arts = mediaRecord("arts-one", "arts");
    await Promise.all([
      db.collection("sections").doc("news").set({ label: "News" }),
      db.collection("media_assets").doc(news.id).set(news),
      db.collection("media_assets").doc(arts.id).set(arts),
      db.collection("media_assets_public").doc(news.id).set({
        url: news.url,
        altText: news.altText,
        mimeType: news.mimeType,
        width: news.width,
        height: news.height,
      }),
      db.collection("media_assets_public").doc(arts.id).set({
        url: arts.url,
        altText: arts.altText,
        mimeType: arts.mimeType,
        width: arts.width,
        height: arts.height,
      }),
    ]);
    const token = await credential.user.getIdToken();
    await signOut(clientAuth);

    const listed = await fetch(fnUrl("cmsListMedia"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toContain("no-store");
    const library = await listed.json();
    expect(library).toMatchObject({
      success: true,
      allCount: 2,
      total: 2,
      records: [{ id: "arts-one", category: "arts", version: 1 }, { id: "news-one", category: "news", version: 1 }],
    });
    expect(library.records[0]).not.toHaveProperty("contentHash");
    expect(library.records[0]).not.toHaveProperty("storageKey");

    const updated = await fetch(fnUrl("cmsUpdateMediaMetadata"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "If-Match": library.records[1].etag,
      },
      body: JSON.stringify({
        assetId: "news-one",
        metadata: {
          name: "News studio",
          altText: "Monitors in the NJ PBS news studio",
        },
      }),
    });
    expect(updated.status).toBe(200);
    expect(updated.headers.get("etag")).toBeTruthy();
    await expect(updated.json()).resolves.toMatchObject({
      success: true,
      changed: true,
      asset: { id: "news-one", name: "News studio", version: 2 },
    });
    expect((await db.collection("media_assets").doc("arts-one").get()).data())
      .toMatchObject({ name: "arts asset", version: 1 });
    expect((await db.collection("media_assets_public").doc("news-one").get()).data())
      .toMatchObject({ altText: "Monitors in the NJ PBS news studio" });
    const audit = await db.collection("admin_logs").get();
    expect(audit.docs).toHaveLength(1);
    expect(audit.docs[0].data()).toMatchObject({
      actorUid: uid,
      action: "media.metadata.update",
      target: "media_assets/news-one",
    });
  }, 20_000);

  it("applies real authentication and site-wide media to bin listing and restore", async () => {
    await admin.auth().createUser({
      email: "bin-news-editor@example.com",
      password: "password123",
      emailVerified: true,
    });
    const credential = await signInWithEmailAndPassword(
      clientAuth, "bin-news-editor@example.com", "password123",
    );
    const uid = credential.user.uid;
    await db.collection("users").doc(uid).set({
      role: null, grants: [{ role: "editor", sections: ["news"] }],
    });
    const news = {
      ...mediaRecord("news-bin", "news"), lifecycle: "purging",
      tombstonedAt: "2026-09-01T00:00:00.000Z", tombstonedBy: "seed-user",
      purgeAfter: "2026-10-01T00:00:00.000Z",
    };
    const arts = { ...news, ...mediaRecord("arts-bin", "arts"), lifecycle: "tombstoned" };
    await Promise.all([
      db.collection("sections").doc("news").set({ label: "News" }),
      db.collection("media_assets").doc(news.id).set(news),
      db.collection("media_assets").doc(arts.id).set(arts),
    ]);
    const token = await credential.user.getIdToken();
    await signOut(clientAuth);
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const listed = await fetch(fnUrl("cmsListBinnedMedia"), {
      method: "POST", headers, body: JSON.stringify({}),
    });
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toContain("no-store");
    const library = await listed.json();
    expect(library).toMatchObject({
      success: true, total: 2,
      records: [{ id: arts.id, category: "arts", lifecycle: "tombstoned" }, { id: news.id, category: "news", lifecycle: "purging" }],
    });
    expect(library.records[0]).not.toHaveProperty("contentHash");
    expect(library.records[0]).not.toHaveProperty("storageKey");

    for (const [assetId, status] of [["missing-bin", 404], [news.id, 409]]) {
      const restored = await fetch(fnUrl("cmsRestoreMedia"), {
        method: "POST",
        headers: { ...headers, "If-Match": mediaLibrary.formatMediaEtag(assetId, 1) },
        body: JSON.stringify({ assetId }),
      });
      expect(restored.status).toBe(status);
      expect(restored.headers.get("cache-control")).toContain("no-store");
      const result = await restored.json();
      expect(result.error).toMatch(status === 404 ? /not available/ : /being removed/);
    }

    for (const [endpoint, body, requestHeaders] of [
      ["cmsListBinnedMedia", {}, { "Content-Type": "application/json" }],
      ["cmsRestoreMedia", { assetId: news.id }, {
        "Content-Type": "application/json", "If-Match": mediaLibrary.formatMediaEtag(news.id, 1),
      }],
    ]) {
      const denied = await fetch(fnUrl(endpoint), {
        method: "POST", headers: requestHeaders, body: JSON.stringify(body),
      });
      expect(denied.status).toBe(401);
    }
    expect((await db.collection("admin_logs").get()).empty).toBe(true);
    expect((await db.collection("media_assets").doc(news.id).get()).data().lifecycle).toBe("purging");
    expect((await db.collection("media_assets").doc(arts.id).get()).data().lifecycle).toBe("tombstoned");
  }, 20_000);
  it("exports replacement with real authentication and a required media capability", async () => {
    const form = () => {
      const body = new FormData();
      body.set("assetId", "arts-one");
      body.set("file", new Blob(["image fixture"], { type: "image/png" }), "image.png");
      return body;
    };
    expect((await fetch(fnUrl("cmsReplaceMediaBinary"), { method: "POST", body: form() })).status).toBe(401);
    await admin.auth().createUser({
      email: "replace-editor@example.com",
      password: "password123",
      emailVerified: true,
    });
    const credential = await signInWithEmailAndPassword(
      clientAuth, "replace-editor@example.com", "password123",
    );
    await db.collection("users").doc(credential.user.uid).set({ role: null, grants: [{ role: "staff" }] });
    await db.collection("media_assets").doc("arts-one").set(mediaRecord("arts-one", "arts"));
    const token = await credential.user.getIdToken();
    const denied = await fetch(fnUrl("cmsReplaceMediaBinary"), {
      method: "POST", body: form(), headers: { Authorization: `Bearer ${token}`, "If-Match": mediaLibrary.formatMediaEtag("arts-one", 1) },
    });
    expect(denied.status).toBe(404);
    expect((await db.collection("admin_logs").get()).empty).toBe(true);
  }, 20_000);

});
