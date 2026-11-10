import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  SECTION_BLOCK_CATALOG,
  SECTION_BLOCK_MAX,
  SECTION_BLOCK_TOTAL_MAX,
  validateSection as validateSectionTs,
  type EditorBlock,
  type SectionId,
} from "../../packages/content-core/src/editor-admin";
import type { BlockType } from "../../packages/content-core/src/content-model";
import { projectPublishedPostRead } from "../src/lib/published-post-shadow";
import post from "./fixtures/shadow-posts/post.json";

const require = createRequire(import.meta.url);
const {
  SECTION_BLOCK_CATALOG: cjsCatalog,
  SECTION_BLOCK_MAX: cjsMax,
  SECTION_BLOCK_TOTAL_MAX: cjsTotalMax,
  validateSection: validateSectionCjs,
} = require("../../functions/lib/editor-section-contract.js");

const block = (id: string, type: BlockType, order = 0): EditorBlock => ({
  id,
  type,
  order,
});

const cases: Array<{
  name: string;
  section: SectionId;
  blocks: EditorBlock[];
}> = [
  { name: "empty home", section: "home", blocks: [] },
  { name: "AP embed on a generic Page", section: "genericPage", blocks: [block("map", "embed")] },
  {
    name: "valid generic page",
    section: "genericPage",
    blocks: [block("heading", "headline"), block("copy", "prose", 1)],
  },
  {
    name: "off-catalog generic block",
    section: "genericPage",
    blocks: [block("cards", "card_grid")],
  },
  {
    name: "duplicate id",
    section: "home",
    blocks: [block("same", "prose"), block("same", "divider", 1)],
  },
  {
    name: "blank id",
    section: "post",
    blocks: [block("", "prose")],
  },
  {
    name: "per-type cap",
    section: "home",
    blocks: [block("one", "headline"), block("two", "headline", 1)],
  },
  {
    name: "whole-page cap",
    section: "genericPage",
    blocks: Array.from({ length: 41 }, (_, index) =>
      block(`divider-${index}`, "divider", index),
    ),
  },
];

describe("the Functions section contract mirrors the canonical admin editor", () => {
  it("pins every template catalog and cap", () => {
    expect(cjsCatalog).toEqual(SECTION_BLOCK_CATALOG);
    expect(cjsMax).toEqual(SECTION_BLOCK_MAX);
    expect(cjsTotalMax).toEqual(SECTION_BLOCK_TOTAL_MAX);
  });

  it.each(cases)("agrees on $name", ({ section, blocks }) => {
    expect(validateSectionCjs(section, blocks)).toEqual(
      validateSectionTs(section, blocks),
    );
  });

  it.each([45, 200])("accepts a %i-block Post in both readers", (count) => {
    const blocks = Array.from({ length: count }, (_, index) =>
      block(`prose-${index}`, "prose", index),
    );
    expect(validateSectionTs("post", blocks)).toBeNull();
    expect(validateSectionCjs("post", blocks)).toBeNull();
  });

  it("projects all 200 blocks through the public Post reader", () => {
    const blocks = Array.from({ length: 200 }, (_, index) => ({
      ...post.document.published.blocks[0], id: `prose-${index}`, order: index,
    }));
    const input = { ...post, document: { ...post.document,
      published: { ...post.document.published, blocks } } };
    const content = projectPublishedPostRead(input, "shadow-fixture", "a".repeat(40),
      new Date("2026-11-05T12:00:00Z"));
    expect(content?.posts[0].blocks).toHaveLength(200);
    expect(content?.posts[0].blocks.at(-1)?.id).toBe("prose-199");
  });

  it.each([
    ["post", 201],
    ["home", 41],
    ["programLanding", 41],
    ["genericPage", 41],
  ] as const)("refuses %s at %i blocks in both readers", (section, count) => {
    const blocks = Array.from({ length: count }, (_, index) =>
      block(`prose-${index}`, "prose", index),
    );
    expect(validateSectionTs(section, blocks)?.reason).toContain("too many blocks");
    expect(validateSectionCjs(section, blocks)).toEqual(validateSectionTs(section, blocks));
  });
});
