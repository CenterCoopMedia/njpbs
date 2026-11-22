import { createRequire } from "node:module";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createPublishedSnapshot } = require("../../functions/lib/publish-snapshot.js");
const { createPreviewSnapshot } = require("../../functions/lib/preview-snapshot.js");
const { projectPublicPageDocument } = require("../../functions/lib/public-content-projection.js");

it("keeps working Schedule copy in saved preview and freezes it on publication", () => {
  const now = new Date("2026-10-06T12:00:00Z");
  const publishedAt = now.toISOString();
  const scheduleCopy = { version: 1, heading: "This week on NJ PBS", introduction: "See upcoming programs." };
  const document = {
    id: "schedule", template: "programLanding", status: "draft", publiclyVisible: true,
    title: "TV listings for New Jersey", description: "Search summary", version: 7, blocks: [],
  };
  const snapshot = (working: typeof document) => createPublishedSnapshot({
    collection: "cmsPages", document: working, publishedAt, publishedBy: "editor",
  });
  const legacy = snapshot(document);
  const owned = { ...document, scheduleCopy };
  expect(createPreviewSnapshot("schedule", owned)).toMatchObject({ version: 7, scheduleCopy });

  const readPublic = (published: ReturnType<typeof snapshot>) => projectPublicPageDocument({
    pageId: "schedule", document: { ...owned, published }, now, assets: new Map(),
  }).page;
  expect(readPublic(legacy)).toMatchObject({ title: document.title, description: document.description });
  expect(readPublic(legacy)).not.toHaveProperty("scheduleCopy");
  expect(readPublic(snapshot(owned))).toMatchObject({ scheduleCopy });
});
