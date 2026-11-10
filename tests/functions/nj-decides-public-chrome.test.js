import { describe, expect, it } from "vitest";
import reader from "../../functions/published-post-reader.js";
import contract from "../../functions/lib/cms-settings-contract.js";

const { readPublishedChrome } = reader;
const { DEFAULT_NJ_DECIDES_SETTINGS, NJ_DECIDES_SETTINGS_ID } = contract;
const image = { lifecycle: "active", source: "site_seed", mimeType: "image/png",
  url: "https://media.njpbs.org/cms-media/fixture/election.png", altText: "Example election graphic", width: 800, height: 300 };
const publicImage = { mimeType: image.mimeType, url: image.url, altText: image.altText, width: 800, height: 300 };
const setting = { schemaVersion: 1, version: 3, values: DEFAULT_NJ_DECIDES_SETTINGS,
  published: { schemaVersion: 1, sourceVersion: 2, publishedAt: "2026-10-26T17:00:00.000Z",
    values: { ...DEFAULT_NJ_DECIDES_SETTINGS, logoAssetId: "brand-logo", logoAlt: "Election coverage" } } };

function store(records) {
  const fieldValue = (document, field) => field.split(".").reduce((value, key) => value?.[key], document);
  const snapshot = (ref, fields) => ({ id: ref.path.split("/").at(-1), exists: records.has(ref.path), data: () => {
    const document = records.get(ref.path);
    if (!document || fields === undefined) return document;
    const selected = {};
    for (const field of fields) {
      const value = fieldValue(document, field);
      if (value === undefined) continue;
      const keys = field.split("."), leaf = keys.pop();
      const parent = keys.reduce((target, key) => target[key] ??= {}, selected);
      parent[leaf] = structuredClone(value);
    }
    return selected;
  } });
  const query = (path, filters = [], fields, count = Infinity) => ({ path, filters, fields, count,
    where(field, operator, value) {
      if (operator !== "==") throw new Error("Unsupported fixture query");
      return query(path, [...filters, { field, value }], fields, count);
    },
    limit(value) { return query(path, filters, fields, value); },
    select(...selected) { return query(path, filters, selected, count); },
  });
  return {
    firestore: { doc: path => ({ path }), collection: path => query(path) },
    transaction: { getAll: async (...refs) => refs.map(ref => snapshot(ref)), get: async ref => {
      if (!ref.filters) return snapshot(ref);
      const docs = [...records].filter(([path, document]) => path.startsWith(`${ref.path}/`) && path.split("/").length === 2 &&
        ref.filters.every(({ field, value }) => fieldValue(document, field) === value))
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).slice(0, ref.count)
        .map(([path]) => snapshot({ path }, ref.fields));
      return { docs, size: docs.length };
    } },
  };
}

describe("published NJ Decides chrome", () => {
  it("keeps paired branding readable alongside projected Post and Page destinations", async () => {
    const linked = (type, slug, contentLinkNewTab) => ({
      type, status: "published", publiclyVisible: true, publishAt: setting.published.publishedAt,
      contentLinkUrl: "https://example.test/private-draft", privateBody: "PRIVATE working draft",
      published: { sourceVersion: 2, publishedAt: setting.published.publishedAt, blocks: [{ privateBody: "Retained body" }],
        metadata: { type, slug, contentLinkMode: "custom", contentLinkUrl: `https://example.test/${slug}`, contentLinkNewTab } },
    });
    const records = new Map([
      [`cmsSettings/${NJ_DECIDES_SETTINGS_ID}`, setting], ["media_assets/brand-logo", image], ["media_assets_public/brand-logo", publicImage],
      ["cmsPosts/story", linked("post", "election-report", false)],
      [`cmsPages/page-${"a".repeat(32)}`, linked("page", "election-guide", true)],
      ["cmsPosts/hidden", { ...linked("post", "hidden", true), publiclyVisible: false }],
    ]);
    const { firestore, transaction } = store(records);
    const result = await readPublishedChrome(firestore, transaction, new Date("2026-10-26T18:00:00Z"));
    expect(result.settings[0].assets).toEqual({ "brand-logo": { mimeType: "image/png", url: image.url, width: 800, height: 300 } });
    expect(result.contentLinks).toHaveLength(2);
    expect(result.contentLinks).toEqual(expect.arrayContaining([
      { path: "/posts/election-report/", contentLinkMode: "custom", contentLinkUrl: "https://example.test/election-report", contentLinkNewTab: false, previousSlugs: [] },
      { path: "/election-guide/", contentLinkMode: "custom", contentLinkUrl: "https://example.test/election-guide", contentLinkNewTab: true, previousSlugs: [] },
    ]));
    expect(JSON.stringify(result)).not.toContain("PRIVATE working draft");
    expect(JSON.stringify(result)).not.toContain("private-draft");
    expect(JSON.stringify(result)).not.toContain("Retained body");
  });
  it("reads the frozen brand and resolves only paired public Media", async () => {
    const { firestore, transaction } = store(new Map([
      [`cmsSettings/${NJ_DECIDES_SETTINGS_ID}`, setting], ["media_assets/brand-logo", image], ["media_assets_public/brand-logo", publicImage],
    ]));
    const result = await readPublishedChrome(firestore, transaction, new Date("2026-10-26T18:00:00Z"));
    expect(result.settings).toHaveLength(1);
    expect(result.settings[0].published.values.logoAlt).toBe("Election coverage");
    expect(result.settings[0].assets).toEqual({ "brand-logo": {
      mimeType: "image/png", url: image.url, width: 800, height: 300,
    } });
  });
  it("keeps the public context readable when custom Media is unavailable", async () => {
    const { firestore, transaction } = store(new Map([[`cmsSettings/${NJ_DECIDES_SETTINGS_ID}`, setting]]));
    const result = await readPublishedChrome(firestore, transaction, new Date("2026-10-26T18:00:00Z"));
    expect(result.settings[0].assets).toEqual({});
    expect(result.navigationPages).toEqual([]);
  });
  it("carries the same published election banner on every chrome read", async () => {
    const published = { schemaVersion: 2, sourceVersion: 2, publishedAt: "2026-10-26T17:00:00.000Z",
      values: { enabled: true, njDecides: true, message: "", liveLabel: "Live", startsAt: "2026-11-03T23:00:00.000Z" } };
    const records = new Map([["cmsSettings/public-homepage-banner", { version: 3, published,
      values: { enabled: false, message: "PRIVATE working draft" } }]]);
    const { firestore, transaction } = store(records);
    const result = await readPublishedChrome(firestore, transaction, new Date("2026-10-26T18:00:00Z"));
    expect(result.settings).toEqual([{ id: "public-homepage-banner", version: 2, published }]);
    records.set("cmsSettings/public-homepage-banner", { version: 3, published: { ...published,
      values: { ...published.values, message: 42 } } });
    expect((await readPublishedChrome(firestore, transaction, new Date("2026-10-26T18:00:00Z"))).settings).toEqual([]);
    await expect(readPublishedChrome(firestore, transaction, new Date("2026-10-26T18:00:00Z"), { strictBanner: true })).rejects.toThrow();
  });
  it("carries both frozen banner links through the build-free shared settings reader", async () => {
    const published = { schemaVersion: 4, sourceVersion: 7, publishedAt: "2026-11-03T19:00:00.000Z",
      values: { enabled: true, njDecides: true, message: "Election night", linkLabel: "Results", linkHref: "/results/",
        secondLinkLabel: "Watch live", secondLinkHref: "https://live.njpbs.org/" } };
    const { firestore, transaction } = store(new Map([["cmsSettings/public-homepage-banner", { schemaVersion: 4, version: 8, published,
      values: { enabled: false, message: "PRIVATE", secondLinkLabel: "PRIVATE" } }]]));
    const result = await readPublishedChrome(firestore, transaction, new Date("2026-11-03T19:00:00Z"), { strictBanner: true });
    expect(result.settings).toEqual([{ id: "public-homepage-banner", version: 7, published }]);
  });
  it("ignores invalid saved branding instead of failing a Page or Post", async () => {
    const bad = { ...setting, published: { ...setting.published,
      values: { ...DEFAULT_NJ_DECIDES_SETTINGS, textColor: DEFAULT_NJ_DECIDES_SETTINGS.backgroundColor } } };
    const { firestore, transaction } = store(new Map([[`cmsSettings/${NJ_DECIDES_SETTINGS_ID}`, bad]]));
    expect((await readPublishedChrome(firestore, transaction, new Date("2026-10-26T18:00:00Z"))).settings).toEqual([]);
  });
});
