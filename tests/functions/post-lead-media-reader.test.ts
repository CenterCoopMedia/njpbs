// @vitest-environment node
import { describe, expect, it } from "vitest";
import reader from "../../functions/published-post-reader.js";
import { projectPublishedPostRead } from "../../site/src/lib/published-post-shadow";

const now = new Date("2026-10-15T12:00:00Z");
const slug = "lead-reader-fixture";
const lead = { kind: "image", data: { assetId: "poster", alt: "County meeting" } };

// Database boundary only: real snapshot selection, metadata validation, asset
// projection and Site admission run unchanged against deterministic stored rows.
function database(leadMedia: unknown, bodyImage = false) {
  const stored = { id: "fixture", version: 1, publiclyVisible: true, deleted: false, status: "published",
    published: { sourceVersion: 1, publishedAt: now.toISOString(), metadata: {
      type: "post", slug, previousSlugs: [], title: "County meeting", date: "2026-10-15", tags: [], locale: "en", leadMedia,
    }, blocks: bodyImage ? [{ id: "photo", type: "image", visible: true, order: 0, data: { assetId: "poster", alt: "County meeting" } }] : [] } };
  const rows = new Map<string, any>([["cmsPosts/fixture", stored]]);
  const ref = (path: string) => ({ path, id: path.split("/").at(-1) });
  const snap = (path: string) => ({ ...ref(path), ref: ref(path), exists: rows.has(path), data: () => structuredClone(rows.get(path)) });
  const valueAt = (row: any, path: string) => path.split(".").reduce((value, key) => value?.[key], row);
  function query(collection: string, conditions: [string, string, any][] = [], limit = Infinity): any {
    return { collection, conditions, maximum: limit,
      where: (key: string, operator: string, value: any) => query(collection, [...conditions, [key, operator, value]], limit),
      select: () => query(collection, conditions, limit),
      limit: (maximum: number) => query(collection, conditions, maximum), doc: (id: string) => ref(`${collection}/${id}`) };
  }
  const firestore = { doc: ref, collection: query };
  const transaction = { get: async (request: any) => {
    if (request.path) return snap(request.path);
    const docs = [...rows].filter(([path, row]) => path.startsWith(`${request.collection}/`) && request.conditions.every(([key, op, expected]: any[]) => {
      const value = valueAt(row, key);
      if (op === "==") return value === expected;
      if (op === "in") return expected.includes(value);
      if (op === "array-contains") return Array.isArray(value) && value.includes(expected);
      if (op === "array-contains-any") return Array.isArray(value) && value.some(item => expected.includes(item));
      throw new Error(`Unsupported fixture query ${op}`);
    })).slice(0, request.maximum).map(([path]) => snap(path));
    return { docs };
  }, getAll: async (...refs: any[]) => refs.map(ref => snap(ref.path)) };
  return { firestore, transaction, stored, rows };
}

describe("lead media through the real published Post reader", () => {
  it.each([null, { kind: "unknown", data: {} }, { kind: "embed", data: { title: "Bad link", url: "javascript:alert(1)" } }, lead])("keeps invalid or unavailable leads from refusing the public Post: %j", async leadMedia => {
    const boundary = database(leadMedia);
    const read = await reader.readPublishedPost({ ...boundary, slug, now, includeChrome: false });
    const content = projectPublishedPostRead(read, slug, "a".repeat(40), now)!;
    expect(content.posts[0].title).toBe("County meeting");
    expect(content.posts[0].leadMedia).toBeNull();
    expect(content.posts[0].heroImage).toBeNull();
  });

  it("preserves strict body asset refusal when the same missing image is also in the body", async () => {
    const boundary = database(lead, true);
    await expect(reader.readPublishedPost({ ...boundary, slug, now, includeChrome: false })).rejects.toMatchObject({ readerCode: "reader_media_ineligible" });
  });

  it.each([null, lead])("keeps a joined body card asset required when the lead is %j", async leadMedia => {
    const boundary = database(leadMedia);
    boundary.stored.published.blocks = [{ id: "program-card", type: "record_card", visible: true, order: 0,
      data: { recordKind: "program", recordId: "program-one" } }] as any;
    boundary.rows.set("cmsPosts/program-one", { publiclyVisible: true, status: "published", published: {
      sourceVersion: 1, publishedAt: now.toISOString(), metadata: { type: "program", title: "Program", slug: "program-one",
        locale: "en", previousSlugs: [], keyArtAssetId: "poster", keyArtAlt: "Program artwork" }, blocks: [] } });
    await expect(reader.readPublishedPost({ ...boundary, slug, now, includeChrome: false })).rejects.toMatchObject({ readerCode: "reader_media_ineligible" });
  });

  it("keeps Home card reads available when a lead-only poster is missing", async () => {
    const boundary = database(lead);
    const cards = await reader.readPublishedHomePostCards({ ...boundary, slugs: [slug], now });
    expect(cards[0].document.published.metadata.title).toBe("County meeting");
    expect(cards[0].assets).toEqual([]);
  });
});
