import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { generatedHeadingLevelAt } from "../../packages/content-core/src/content-render";
import v1 from "./fixtures/home-composition-v1.json";
import { parseBlocks, type PageBlock } from "../../packages/content-core/src/content-model";
import { homeCompositionError } from "../../packages/content-core/src/home-composition-contract";
import { homeCompositionDefaults, homeCompositionGroups, resolveHomeComposition } from "../../packages/content-core/src/home-composition";
import { projectCmsPage } from "../src/lib/cms-loader";
import { createHomeDonorBlock } from "../../packages/content-core/src/home-donor-section";

const require = createRequire(import.meta.url);
const server = require("../../functions/lib/home-composition-contract.js");
const serverBlocks = require("../../functions/lib/content-blocks.js");
const { createPublishedSnapshot } = require("../../functions/lib/publish-snapshot.js");
const { createPreviewSnapshot } = require("../../functions/lib/preview-snapshot.js");
const { projectPublicPageDocument } = require("../../functions/lib/public-content-projection.js");
const { homeEditorBoundaryError } = require("../../functions/lib/home-editor-boundary.js");
const instant = "2026-09-05T12:00:00.000Z";

function blocks(): PageBlock[] {
  const parsed = parseBlocks(structuredClone(v1.blocks));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.blocks;
}
function v2Blocks(): PageBlock[] {
  const original = blocks();
  // Accepted spec: array order, whole Passport group, independent protected rails.
  return [original[6], original[3], original[4], original[0], original[1], original[5], original[2]]
    .map((block, order) => ({ ...block, order }));
}
function admission(value: PageBlock[]) {
  const doc = { ...v1, homeCompositionVersion: 2, blocks: value };
  const snapshot = createPublishedSnapshot({ collection: "cmsPages", document: doc, publishedAt: instant, publishedBy: "editor" });
  const preview = createPreviewSnapshot("home", doc);
  const publicDoc = { ...doc, publiclyVisible: true, published: snapshot };
  const projected = projectCmsPage(publicDoc, { mode: "published", now: new Date(instant), assets: new Map([["story-image", { id: "story-image", url: "https://media.njpbs.org/cms-media/story.webp", mimeType: "image/webp", width: 640, height: 360, alt: "Local artwork" }]]) })!;
  const runtime = projectPublicPageDocument({ pageId: "home", document: publicDoc, assets: new Map([["story-image", { id: "story-image", url: "https://media.njpbs.org/cms-media/story.webp", mimeType: "image/webp", width: 640, height: 360, alt: "Local artwork" }]]), now: new Date(instant) });
  return { snapshot, preview, projected, runtime };
}

describe("Home v2 reader contract", () => {
  it("preserves the giving plank's saved copy, identity, placement and withdrawal across real snapshots and projections", () => {
    for (const index of [0, 3, 7]) {
      const giving = createHomeDonorBlock("giving-plank"); giving.data.cards[0].itemId = "giving-card";
      const value = v2Blocks(); value.splice(index, 0, giving);
      value.forEach((block, order) => { block.order = order; });
      const { snapshot, preview, projected, runtime } = admission(value);
      for (const result of [snapshot, preview, projected, runtime.page]) expect(result.blocks).toEqual(value);
      expect(homeCompositionGroups(runtime.page.blocks).map(group => group.kind === "section" ? group.section : "content"))
        .toContain("home-donor");
      value[index].visible = false;
      const hidden = admission(value);
      expect(hidden.runtime.page.blocks[index]).toEqual(value[index]);
      expect(homeCompositionGroups(hidden.runtime.page.blocks).some(group => group.kind === "section" && group.section === "home-donor")).toBe(false);
      const duplicate = [...value, { ...value[index], id: "duplicate-giving", order: 8 }];
      expect(homeCompositionError("home", 2, duplicate)).toBeTruthy();
      expect(server.homeCompositionError("home", 2, duplicate)).toBeTruthy();
    }
  });
  it("characterizes the origin/main v1 proposal and serialization without inserting defaults", () => {
    // Captured at origin/main 5fb5dd86 before this change. Never regenerate with v2 code.
    expect(JSON.stringify(homeCompositionDefaults())).toBe(JSON.stringify(v1.blocks));
    const parsedV1 = parseBlocks(v1.blocks);
    if (!parsedV1.ok) throw new Error(parsedV1.error);
    expect(JSON.stringify(parsedV1.blocks)).toBe(JSON.stringify(v1.blocks));
    expect(JSON.stringify(serverBlocks.parseBlocks(v1.blocks).blocks)).toBe(JSON.stringify(v1.blocks));
    const snapshot = createPublishedSnapshot({ collection: "cmsPages", document: v1, publishedAt: instant, publishedBy: "editor" });
    expect(JSON.stringify(snapshot.blocks)).toBe(JSON.stringify(v1.blocks));
    expect(snapshot.metadata.homeCompositionVersion).toBe(1);
  });

  it("carries saved array order, IDs and source settings through every reader", () => {
    const value = v2Blocks();
    expect(homeCompositionError("home", 2, value)).toBeNull();
    expect(server.homeCompositionError("home", 2, value)).toBeNull();
    expect(homeCompositionError("home", 1, value)).toBeTruthy();
    const { snapshot, preview, projected, runtime } = admission(value);
    for (const result of [snapshot, preview, projected, runtime.page]) {
      expect(result.blocks).toEqual(value);
    }
    expect(snapshot.metadata.homeCompositionVersion).toBe(2);
    for (const result of [preview, projected, runtime.page]) expect(result.homeCompositionVersion).toBe(2);
    expect(homeCompositionGroups(value).map(group => group.kind === "section" ? group.section : "content"))
      .toEqual(["home-spotlight", "home-passport-copy", "home-start", "home-more", "home-featured"]);
    expect(resolveHomeComposition(2, value)).toEqual(resolveHomeComposition(1, blocks()));
  });

  it("keeps explicit withdrawn identities and copy/action groups in every projection", () => {
    const value = v2Blocks();
    value.filter(block => ["home-passport-copy", "home-passport-action", "home-featured"].includes(block.section!))
      .forEach(block => { block.visible = false; });
    const { projected, runtime } = admission(value);
    for (const result of [projected, runtime.page]) {
      expect(result.blocks).toEqual(value);
      expect(homeCompositionError("home", 2, result.blocks)).toBeNull();
      expect(homeCompositionGroups(result.blocks).map(group => group.kind === "section" ? group.section : "content"))
        .toEqual(["home-spotlight", "home-start", "home-more"]);
    }
  });

  it("uses array placement for manual shelves and keeps added rows whole", () => {
    const value = v2Blocks();
    value.splice(3, 0, { id: "row", type: "row", order: 0, visible: true, data: { columns: [12] } },
      { id: "row-copy", type: "prose", order: 0, visible: true, layout: { rowId: "row", column: 0 }, data: { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Saved row" }] }] } } });
    value.push({ id: "manual", type: "promotion_playlist", order: 0, visible: true, data: { title: "Saved shelf", placement: "before_start", cards: [{ itemId: "local", title: "Local story", summary: "Station story", imageAssetId: "story-image", alt: "Local artwork", href: "/about/" }] } });
    value.forEach((block, index) => { block.order = index; });
    const parsed = parseBlocks(value);
    expect(parsed.ok).toBe(true);
    expect(homeCompositionError("home", 2, value)).toBeNull();
    const groups = homeCompositionGroups(value);
    expect(groups[2].blocks.map(block => block.id)).toEqual(["row", "row-copy"]);
    expect(groups.at(-1)!.blocks[0].id).toBe("manual");
    expect(admission(value).runtime.page.blocks).toEqual(value);
    value.find(block => block.id === "row")!.visible = false;
    const projected = admission(value).runtime.page.blocks;
    expect(projected.map((block: PageBlock) => block.id)).toEqual(value.filter(block => !["row", "row-copy"].includes(block.id)).map(block => block.id));
    expect(parseBlocks(projected).ok).toBe(true);
    expect(homeCompositionError("home", 2, projected)).toBeNull();
  });

  it.each([
    ["missing identity", (value: PageBlock[]) => value.pop()],
    ["source substitution", (value: PageBlock[]) => { if (value[0].type === "content_shelf") value[0].data.source = "pbs_more"; }],
    ["unapproved link", (value: PageBlock[]) => { if (value[2].type === "cta_row") value[2].data.ctas[0].href = "/support/"; }],
    ["split Passport", (value: PageBlock[]) => { [value[2], value[3]] = [value[3], value[2]]; }],
    ["partial withdrawal", (value: PageBlock[]) => { value[1].visible = false; }],
    ["competing order", (value: PageBlock[]) => { value[0].order = 99; }],
    ["pinned chrome", (value: PageBlock[]) => { value[0].section = "home-header"; }],
    ["manual shelf inside row", (value: PageBlock[]) => {
      value.push({ id: "manual-row", type: "row", order: 7, visible: true, data: { columns: [12] } },
        { id: "row-manual", type: "promotion_playlist", order: 8, visible: true, layout: { rowId: "manual-row", column: 0 }, data: { title: "Station story", placement: "before_start", cards: [] } });
    }],
  ] as const)("rejects %s at TS/CJS and projection boundaries", (_name, mutate) => {
    const value = v2Blocks(); mutate(value);
    const error = homeCompositionError("home", 2, value);
    expect(error).toBeTruthy();
    expect(server.homeCompositionError("home", 2, value)).toBe(error);
    expect(() => admission(value)).toThrow();
    const published = { blocks: value, metadata: { title: v1.title, homeCompositionVersion: 2 }, sourceVersion: v1.version, publishedBy: "editor", publishedAt: instant };
    expect(() => projectPublicPageDocument({ pageId: "home", document: { ...v1, publiclyVisible: true, published }, assets: new Map(), now: new Date(instant) })).toThrow();
    expect(() => projectCmsPage({ ...v1, homeCompositionVersion: 2, blocks: value }, { mode: "draft", pageId: "home", now: new Date(instant) })).toThrow();
  });

  it("retains authored heading context across adjacent ordinary blocks", () => {
    const value = blocks();
    value.splice(2, 0,
      { id: "authored-heading", type: "headline", order: 0, visible: true, data: { text: "Local pathways", level: 2 } },
      { id: "authored-grid", type: "card_grid", order: 0, visible: true, data: { cards: [{ title: "Local story", href: "/about/" }] } });
    value.forEach((block, order) => { block.order = order; });
    expect(homeCompositionError("home", 1, value)).toBeNull();
    expect(homeCompositionError("home", 2, value)).toBeNull();
    const content = homeCompositionGroups(value).find(group => group.kind === "content")!.blocks;
    expect(content.map(block => block.id)).toEqual(["authored-heading", "authored-grid"]);
    expect(generatedHeadingLevelAt(content, 1)).toBe(3);
  });

  it("retains custom manual-shelf section labels without granting protected region identity", () => {
    const value = v2Blocks();
    const shelf: PageBlock = { id: "manual-custom-label", section: "home-local-promotions", type: "promotion_playlist", visible: true, order: 7, data: { title: "Local station story", placement: "before_start", cards: [{ itemId: "frozen-story", title: "Reviewed story", summary: "Reviewed summary", imageAssetId: "story-image", alt: "Local artwork", href: "/about/" }] } };
    value.push(shelf);
    expect(homeCompositionError("home", 2, value)).toBeNull();
    expect(server.homeCompositionError("home", 2, value)).toBeNull();
    expect(homeCompositionGroups(value).at(-1)).toEqual({ kind: "content", blocks: [shelf] });
    const { projected, runtime } = admission(value);
    expect(projected.blocks.at(-1)).toEqual(shelf);
    expect(runtime.page.blocks.at(-1)).toEqual(shelf);
    shelf.visible = false;
    const hidden = admission(value);
    expect(hidden.projected.blocks.some((block: PageBlock) => block.id === shelf.id)).toBe(false);
    expect(hidden.runtime.page.blocks.some((block: PageBlock) => block.id === shelf.id)).toBe(false);
    shelf.section = "home-featured";
    expect(homeCompositionError("home", 2, value)).toBe("The manual shelf cannot replace a required Home region.");
    expect(server.homeCompositionError("home", 2, value)).toBe("The manual shelf cannot replace a required Home region.");
    expect(() => admission(value)).toThrow();
  });

  it("preserves all whole-section permutations with TS/CJS parity", () => {
    const original = blocks();
    const groups = [[original[0], original[1]], [original[2]], [original[3], original[4]], [original[5]], [original[6]]];
    function permutations<T>(values: T[]): T[][] {
      return values.length ? values.flatMap((value, index) => permutations(values.filter((_, other) => other !== index)).map(rest => [value, ...rest])) : [[]];
    }
    for (const ordered of permutations(groups)) {
      const value = ordered.flat().map((block, order) => ({ ...block, order }));
      expect(homeCompositionError("home", 2, value)).toBeNull();
      expect(server.homeCompositionError("home", 2, value)).toBeNull();
      expect(homeCompositionGroups(value).flatMap(group => group.blocks.map(block => block.id))).toEqual(value.map(block => block.id));
    }
  });

  it("does not demand artwork for a withdrawn retained Start pair", () => {
    const value = v2Blocks();
    const start = value.find(block => block.section === "home-start")!;
    if (start.type !== "card_grid") throw new Error("Expected Start cards");
    start.data.cards[0].imageAssetId = "withdrawn-image";
    start.visible = false;
    value.find(block => block.section === "home-start-action")!.visible = false;
    expect(admission(value).projected.assets).toEqual({});
    expect(() => resolveHomeComposition(2, admission(value).projected.blocks)).not.toThrow();
  });

  it("fails future/malformed versions in shared and server admission", () => {
    for (const version of [3, "2", null, false]) {
      expect(homeCompositionError("home", version, v2Blocks())).toBeTruthy();
      expect(server.homeCompositionError("home", version, v2Blocks())).toBe(homeCompositionError("home", version, v2Blocks()));
    }
  });

  it("admits valid v2 draft saves while preserving protected sources and recovery", () => {
    const stored = v2Blocks();
    const boundary = (nextBlocks: PageBlock[], nextVersion: unknown = 2) => homeEditorBoundaryError({
      collection: "cmsPages", documentId: "home", storedBlocks: stored, nextBlocks,
      storedVersion: 2, nextVersion,
    });
    expect(boundary(v2Blocks())).toBeNull();
    expect(boundary(v2Blocks(), 3)).toContain("version-checked Home conversion");
    expect(boundary(stored.filter(block => block.section !== "home-passport-action"))).toBeTruthy();
    const sourceChanged = v2Blocks();
    const featured = sourceChanged.find(block => block.section === "home-featured")!;
    if (featured.type !== "content_shelf") throw new Error("Expected Featured shelf");
    featured.data.source = "pbs_more";
    expect(boundary(sourceChanged)).toBeTruthy();
    const recoveryChanged = v2Blocks();
    const start = recoveryChanged.find(block => block.section === "home-start")!;
    if (start.type !== "card_grid") throw new Error("Expected Start cards");
    start.data.cards[0].title = "Changed recovery content";
    expect(boundary(recoveryChanged)).toContain("Start recovery content must be preserved");
  });
});
