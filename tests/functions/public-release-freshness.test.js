import { describe, expect, it } from "vitest";
import freshness from "../../functions/lib/public-release-freshness.js";
import settings from "../../functions/lib/cms-settings-contract.js";

const { publicReleaseFreshnessDigest } = freshness;
const { DEFAULT_NJ_DECIDES_SETTINGS, NJ_DECIDES_SETTINGS_ID } = settings;
const brandPath = `cmsSettings/${NJ_DECIDES_SETTINGS_ID}`;
const brand = () => ({
  version: 3,
  values: { ...DEFAULT_NJ_DECIDES_SETTINGS, logoAssetId: "draft-logo", logoAlt: "Draft" },
  published: {
    schemaVersion: 1,
    sourceVersion: 2,
    publishedAt: "2026-10-26T17:00:00.000Z",
    values: { ...DEFAULT_NJ_DECIDES_SETTINGS, logoAssetId: "brand-logo", logoAlt: "Election coverage",
      backgroundAssetId: "brand-background" },
  },
});

function fixture(document = brand()) {
  const records = new Map([[brandPath, document]]);
  const revisions = new Map([
    ["media_assets_public/brand-logo", 10],
    ["media_assets_public/brand-background", 20],
    ["media_assets_public/draft-logo", 30],
  ]);
  const reads = [];
  const snapshot = (path, fields) => ({
    id: path.split("/").at(-1),
    ref: { path },
    exists: records.has(path) || revisions.has(path),
    updateTime: { seconds: revisions.get(path) ?? 1, nanoseconds: 0 },
    data: () => fields ? Object.fromEntries(fields.filter(field => records.get(path)?.[field] !== undefined)
      .map(field => [field, records.get(path)[field]])) : records.get(path),
  });
  const firestore = {
    doc: path => ({ path }),
    collection: path => ({ path, select: (...fields) => ({ path, fields }) }),
  };
  const transaction = {
    get: async ({ path, fields }) => ({ docs: [...records.keys()]
      .filter(key => key.slice(0, key.lastIndexOf("/")) === path)
      .map(key => snapshot(key, fields)) }),
    getAll: async (...refs) => {
      reads.push(...refs.map(ref => ref.path));
      return refs.map(ref => snapshot(ref.path));
    },
  };
  return { document, records, revisions, reads,
    digest: () => publicReleaseFreshnessDigest(transaction, firestore) };
}

describe("public release freshness for settings Media", () => {
  it.each(["brand-logo", "brand-background"])("invalidates retained %s on replacement or removal", async id => {
    const state = fixture();
    const before = await state.digest();
    state.revisions.set(`media_assets_public/${id}`, 40);
    const replaced = await state.digest();
    expect(replaced).not.toBe(before);
    state.revisions.delete(`media_assets_public/${id}`);
    expect(await state.digest()).not.toBe(replaced);
    expect(state.reads).toContain(`media_assets_public/${id}`);
    expect(state.reads).not.toContain("media_assets_public/draft-logo");
  });

  it("ignores draft values, draft versions and unreferenced Media changes", async () => {
    const state = fixture();
    const before = await state.digest();
    state.document.version += 1;
    state.document.values.logoAlt = "New draft description";
    state.revisions.set("media_assets_public/draft-logo", 50);
    expect(await state.digest()).toBe(before);
  });

  it("keeps unpublished settings out of the media seal", async () => {
    const document = brand();
    delete document.published;
    const state = fixture(document);
    const before = await state.digest();
    state.revisions.set("media_assets_public/brand-logo", 50);
    expect(await state.digest()).toBe(before);
    expect(state.reads.some(path => path.startsWith("media_assets_public/"))).toBe(false);
  });

  it("hashes invalid legacy snapshots without breaking the existing image fallback", async () => {
    const document = brand();
    document.published.values.textColor = document.published.values.backgroundColor;
    const state = fixture(document);
    const before = await state.digest();
    document.published.values.logoAlt = "Changed invalid legacy snapshot";
    expect(await state.digest()).not.toBe(before);
    expect(state.reads.some(path => path.startsWith("media_assets_public/"))).toBe(false);
  });
});
