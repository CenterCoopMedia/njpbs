import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const express = require("express");
let server;
let db;

beforeAll(async () => {
  vi.stubEnv("FUNCTIONS_EMULATOR", "true");
  ({ db } = require("./lib/firebase"));
  const { cmsGetPublicPage } = require("./public-content");
  await db.doc("system/dev-test-readiness").get();
  const app = express();
  app.use(express.json());
  app.post("/page", cmsGetPublicPage);
  server = await new Promise(resolve => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
});

afterAll(async () => {
  await new Promise(resolve => server?.close(resolve));
  const { getApps, deleteApp } = require("firebase-admin/app");
  await Promise.all(getApps().map(deleteApp));
  vi.unstubAllEnvs();
});

it.each([
  ["production", "https://media.njpbs.org/cms-media/photo.jpg", "image/jpeg", 200],
  ["production", "https://njpbs.org/brand/logo.png", "image/png", 200],
  ["production", "https://dev-media.example.org/cms-media/photo.jpg", "image/jpeg", 503],
  ["production", "https://dev-public.example.org/brand/logo.png", "image/png", 503],
  ["development", "https://media.njpbs.org/cms-media/photo.jpg", "image/jpeg", 200],
  ["development", "https://njpbs.org/brand/logo.png", "image/png", 200],
  ["development", "https://dev-media.example.org/cms-media/photo.jpg", "image/jpeg", 200],
  ["development", "https://dev-public.example.org/brand/logo.png", "image/png", 200],
  ["development", "https://media.njpbs.org/cms-media/notice.pdf", "application/pdf", 200],
  ["development", "https://dev-media.example.org/cms-media/notice.pdf", "application/pdf", 200],
  ["development", "https://dev-public.example.org/brand/notice.pdf", "application/pdf", 503],
  ["development", "https://example.test/cms-media/photo.jpg", "image/jpeg", 503],
  ["development", "https://dev-media.example.org/private/photo.jpg", "image/jpeg", 503],
])("projects published assets through HTTP and Firestore: %s %s", async (environment, url, mimeType, status) => {
  vi.stubEnv("CMS_DEPLOYMENT_ENVIRONMENT", environment);
  const projection = { url, mimeType, altText: "Fixture", width: 640, height: 480 };
  const publishedAt = "2026-08-25T12:00:00.000Z";
  const block = mimeType === "application/pdf"
    ? { id: "notice", type: "document_list", order: 0, visible: true,
      data: { documents: [{ itemId: "notice-one", assetId: "dev-host-fixture", title: "Board notice",
        publisher: "njpba", addedAt: publishedAt }] } }
    : { id: "photo", type: "image", order: 0, visible: true,
      data: { assetId: "dev-host-fixture", alt: "Fixture" } };
  const refs = [db.doc("cmsPages/contact"), db.doc("media_assets/dev-host-fixture"), db.doc("media_assets_public/dev-host-fixture")];
  try {
    await refs[0].set({ status: "published", publishAt: publishedAt, publiclyVisible: true,
      template: "genericPage", version: 1, published: {
        metadata: { title: "Contact" }, blocks: [block], publishedAt, sourceVersion: 1,
      } });
    await refs[1].set({ ...projection, source: "site_seed", lifecycle: "active" });
    await refs[2].set(projection);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/page`, {
      method: "POST", headers: { "content-type": "application/json", "x-njpbs-cms-edge": "local-cms-edge-only" },
      body: JSON.stringify({ pageId: "contact" }),
    });
    const body = await response.json();
    expect(response.status).toBe(status);
    if (status === 200) expect(body.page.assets["dev-host-fixture"].url).toBe(url);
    else expect(body.error).toBe("Public content is unavailable");
  } finally {
    await Promise.all(refs.map(ref => ref.delete()));
  }
});
