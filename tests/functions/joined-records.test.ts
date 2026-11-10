import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { supportedSnapshot, unsupportedSnapshotReason } = require("../../functions/lib/no-build-post-publication.js");
const {
  joinedRecordIds, joinedAssetIds, shapeJoinedRecord, publicJoinedAsset, instantBlockAllowed,
  versionHistoryIdChunks, readLibraryHistory, pairedAssetPaths, projectPairedAsset,
} = require("../../functions/lib/joined-records.js");
const { SECTION_BLOCK_CATALOG } = require("../../functions/lib/editor-section-contract.js");
const { BLOCK_TYPES } = require("../../functions/lib/content-blocks.js");

const synopsis = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "A weekly look." }] }] };

function post(blocks: object[], credits?: object[]) {
  return {
    published: {
      sourceVersion: 1,
      metadata: { type: "post", slug: "joined-post", ...(credits ? { credits } : {}) },
      blocks,
    },
  };
}

function card(id: string, visible = true) {
  return { id, type: "record_card", visible, order: 1, data: { recordKind: "program", recordId: id } };
}

describe("joined record admission", () => {
  it("admits record cards, sponsor strips and newsletter signups", () => {
    const blocks = [
      { id: "body", type: "prose", visible: true, order: 0, data: { content: synopsis } },
      card("prog-one"),
      { id: "sponsors", type: "sponsor_strip", visible: true, order: 2, data: { sponsorIds: ["sponsor-one"], layout: "row" } },
      { id: "newsletters", type: "newsletter_signup", visible: true, order: 3, data: { newsletterIds: ["news-one"] } },
    ];
    const authorId = `au_${"a".repeat(32)}`;
    expect(supportedSnapshot(post(blocks, [{ kind: "registered", authorId, displayName: "Ada Reporter", slug: "ada-reporter" }]))).toBe(true);
    expect(joinedRecordIds(blocks)).toEqual(["prog-one", "sponsor-one", "news-one"]);
  });

  it("admits every block type the editor allows in a Post and refuses every other known type", () => {
    // The editor's Post catalog (packages/content-core/src/editor-admin.ts) is the
    // specification. Each of its 20 types has a Post template renderer (#3409, #5079).
    expect(SECTION_BLOCK_CATALOG.post).toHaveLength(20);
    for (const type of SECTION_BLOCK_CATALOG.post) {
      expect(instantBlockAllowed(type), type).toBe(true);
      expect(supportedSnapshot(post([{ id: type, type, visible: true, order: 0, data: {} }])), type).toBe(true);
    }
    const outsideCatalog = BLOCK_TYPES.filter((type: string) => !SECTION_BLOCK_CATALOG.post.includes(type));
    expect(outsideCatalog).toEqual(["town_lookup", "county_comparison", "data_hub_section", "headline", "card_grid", "document_list", "faq_item", "coverage_list", "content_shelf", "home_newscast", "video_playlist"]);
    for (const type of [...outsideCatalog, "unknown_block"]) {
      expect(instantBlockAllowed(type), type).toBe(false);
      expect(unsupportedSnapshotReason(post([{ id: type, type, visible: true, order: 0, data: {} }])))
        .toBe(`This Post has a ${type.replace(/_/g, " ")} block, which Posts cannot publish. Remove or hide it, then publish again.`);
    }
    expect(supportedSnapshot(post([{ id: "coverage", type: "coverage_list", visible: false, order: 0, data: { entries: [] } }]))).toBe(true);
  });

  it("names the slug, credit and join-count causes and refuses more than 100 joins", () => {
    expect(unsupportedSnapshotReason({ published: { sourceVersion: 1, metadata: { type: "post", slug: "Bad Slug" }, blocks: [] } }))
      .toContain("slug must use only lowercase letters, numbers and single hyphens");
    expect(unsupportedSnapshotReason(post([card("prog-one")], [{ kind: "registered", authorId: "au_1" }])))
      .toContain("credit that is not a registered author or a custom name");
    expect(supportedSnapshot(post([card("prog-one")], [{ kind: "registered", authorId: "au_1" }]))).toBe(false);
    const blocks = Array.from({ length: 101 }, (_, index) => card(`prog-${index}`));
    expect(unsupportedSnapshotReason(post(blocks))).toContain("more than 100 programs, events, sponsors or newsletters");
    expect(supportedSnapshot(post(blocks))).toBe(false);
    expect(unsupportedSnapshotReason({ published: { sourceVersion: 1, metadata: { type: "program" }, blocks: [] } }))
      .toBe("This record is not a Post with a published snapshot.");
  });

  it.each(["record_card", "sponsor_strip", "newsletter_signup"])(
    "does not let dependency classification admit %s after its catalog removal", (removed) => {
      const filename = require.resolve("../../functions/lib/joined-records.js");
      const localRequire = createRequire(filename);
      const module = { exports: {} as typeof import("../../functions/lib/joined-records.js") };
      const catalog = SECTION_BLOCK_CATALOG.post.filter((type: string) => type !== removed);
      // Load a separate owner against the future catalog; the production mirror
      // and the other cases keep their frozen, unchanged catalog.
      runInNewContext(readFileSync(filename, "utf8"), { module, require: (id: string) =>
        id === "./editor-section-contract" ? { SECTION_BLOCK_CATALOG: { post: catalog } } : localRequire(id) });
      expect(module.exports.JOINED_TYPES.has(removed)).toBe(true);
      for (const type of BLOCK_TYPES) {
        expect(module.exports.instantBlockAllowed(type), type).toBe(catalog.includes(type));
      }
    },
  );

  it("omits a hidden reference and keeps the current public fields only", () => {
    expect(joinedRecordIds([card("hidden-program", false), card("prog-one")])).toEqual(["prog-one"]);
    const program = shapeJoinedRecord("prog-one", {
      status: "published", publiclyVisible: true, deleted: false, publishAt: "2026-08-20T14:00:00.000Z",
      title: "Private working title",
      published: { sourceVersion: 4, publishedAt: "2026-08-20T14:00:00.000Z", metadata: { type: "program", title: "Due Process" }, blocks: [] },
    });
    expect(program.published.metadata.title).toBe("Due Process");
    expect(JSON.stringify(program)).not.toContain("Private working title");
    expect(shapeJoinedRecord("draft-program", { publiclyVisible: false, published: { metadata: { type: "program" } } })).toBeNull();
    const approved = { status: "approved", type: "sponsor", deleted: false, version: 3, name: "Approved sponsor" };
    const sponsor = shapeJoinedRecord("sponsor-one", {
      type: "sponsor", status: "draft", deleted: false, version: 8, name: "Draft sponsor",
    }, [{ collection: "cmsPosts", documentId: "sponsor-one", action: "approve", after: approved }]);
    expect(sponsor.approvedLibraryVersion.name).toBe("Approved sponsor");
    expect(JSON.stringify(sponsor)).not.toContain("Draft sponsor");
    expect(shapeJoinedRecord("sponsor-one", {
      type: "sponsor", status: "draft", version: 8, name: "Draft sponsor",
    }, [])).toBeNull();
    expect(publicJoinedAsset("logo", { url: "https://media.example.test/logo.png", mimeType: "image/png", width: 10, height: 20, note: "private" }))
      .toEqual({ id: "logo", url: "https://media.example.test/logo.png", mimeType: "image/png", width: 10, height: 20 });
    expect(publicJoinedAsset("logo", { mimeType: "image/png" })).toBeNull();
    const withArt = shapeJoinedRecord("prog-one", {
      status: "published", publiclyVisible: true, deleted: false, publishAt: "2026-08-20T14:00:00.000Z",
      published: { sourceVersion: 4, publishedAt: "2026-08-20T14:00:00.000Z", blocks: [],
        metadata: { type: "program", keyArtAssetId: "program-art" } },
    });
    expect(joinedAssetIds([withArt])).toEqual(["program-art"]);
  });

  it("keeps the public newsletter card and drops the approval body", () => {
    const body = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x".repeat(500) }] }] };
    const newsletter = shapeJoinedRecord("news-one", {
      type: "newsletter", status: "draft", deleted: false, version: 4, privateNote: "working-secret",
    }, [{
      collection: "cmsPosts", documentId: "news-one", action: "approve",
      after: {
        status: "approved", type: "newsletter", deleted: false, version: 2,
        title: "Public title", signupUrl: "https://public.example.test/join",
        body, privateNote: "approval-secret",
      },
    }]);
    const card = newsletter.approvedLibraryVersion;
    expect(card.title).toBe("Public title");
    expect(card.signupUrl).toBe("https://public.example.test/join");
    expect(card.summary).toBe("x".repeat(300));
    expect(card.body).toBeUndefined();
    expect(JSON.stringify(newsletter)).not.toContain("approval-secret");
    expect(JSON.stringify(newsletter)).not.toContain("working-secret");
  });

  it("reads approval history in chunks of ten", async () => {
    const ids = Array.from({ length: 11 }, (_, index) => `lib-${index}`);
    const chunks = versionHistoryIdChunks(ids);
    expect(chunks.map(chunk => chunk.length)).toEqual([10, 1]);
    const calls: string[][] = [];
    const history = await readLibraryHistory({
      collection() {
        const filters: { field: string; value: unknown }[] = [];
        const query = {
          where(field: string, _op: string, value: unknown) {
            filters.push({ field, value });
            return query;
          },
          filters,
        };
        return query;
      },
    }, {
      get(query: { filters: { field: string; value: string[] }[] }) {
        const chunk = query.filters.find(filter => filter.field === "documentId")?.value ?? [];
        calls.push(chunk);
        return Promise.resolve({ docs: chunk.map(id => ({ data: () => ({ documentId: id, action: "approve" }) })) });
      },
    }, ids);
    expect(calls).toEqual(chunks);
    expect(history.get("lib-10")).toEqual([{ documentId: "lib-10", action: "approve" }]);
    expect(history.get("lib-0")).toHaveLength(1);
  });

  it("rejects a joined asset that has no private media record", () => {
    expect(pairedAssetPaths(["logo"])).toEqual(["media_assets/logo", "media_assets_public/logo"]);
    expect(() => projectPairedAsset({
      assetId: "logo",
      privateSnapshot: { exists: false, data: () => undefined },
      publicSnapshot: { exists: true, data: () => ({ url: "https://media.example.test/logo.png" }) },
      uploadedMediaReady: true,
    })).toThrow(/cannot enter public content/);
  });
});
