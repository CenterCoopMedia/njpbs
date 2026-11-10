import { describe, expect, it } from "vitest";
import type { PageBlock } from "../../packages/content-core/src/content-model";
import type { RenderedContentGroup } from "../../packages/content-core/src/content-row-render";
import {
  groupLinkCardDirectories,
  groupLinkCardsByConsecutiveYear,
  renderLinkCardDirectory,
} from "../../packages/content-core/src/link-card-directory-groups";

const block = (id: string, type: PageBlock["type"]): PageBlock => ({
  id,
  type,
  order: 0,
  visible: true,
  data: type === "link_card"
    ? { title: id, url: `https://example.com/${id}` }
    : type === "divider" ? {} : { columns: [12] },
} as PageBlock);
const group = (id: string, type: PageBlock["type"]): RenderedContentGroup => ({
  block: block(id, type),
  html: id,
});

describe("link card directory grouping", () => {
  it("groups only consecutive top-level runs of two or more cards", () => {
    const result = groupLinkCardDirectories([
      group("one", "link_card"),
      group("two", "link_card"),
      group("break", "divider"),
      group("single", "link_card"),
    ]);
    expect(result.map((item) => item.kind)).toEqual([
      "link-card-directory",
      "block",
      "block",
    ]);
    expect(result[0].kind === "link-card-directory" && result[0].groups.map(({ block }) => block.id))
      .toEqual(["one", "two"]);
  });

  it("leaves a row group independent even when it contains link cards", () => {
    expect(groupLinkCardDirectories([group("row", "row")])).toEqual([{
      kind: "block",
      group: group("row", "row"),
    }]);
  });

  it("preserves separate nonconsecutive runs of the same year", () => {
    const cards = [
      group("first-2026", "link_card"),
      group("only-2025", "link_card"),
      group("second-2026", "link_card"),
    ];
    (cards[0].block as Extract<PageBlock, { type: "link_card" }>).data.date = "2026-09-17";
    (cards[1].block as Extract<PageBlock, { type: "link_card" }>).data.date = "2025-09-23";
    (cards[2].block as Extract<PageBlock, { type: "link_card" }>).data.date = "2026-06-01";

    expect(groupLinkCardsByConsecutiveYear(cards).map(({ year, groups }) => ({
      year,
      ids: groups.map(({ block }) => block.id),
    }))).toEqual([
      { year: "2026", ids: ["first-2026"] },
      { year: "2025", ids: ["only-2025"] },
      { year: "2026", ids: ["second-2026"] },
    ]);
  });

  it("offers date sorting only when dates can change the order", () => {
    const cards = [group("first", "link_card"), group("second", "link_card")];
    expect(renderLinkCardDirectory(cards)).not.toContain("data-coverage-sort");

    (cards[0].block as Extract<PageBlock, { type: "link_card" }>).data.date = "2026-09-17";
    expect(renderLinkCardDirectory(cards)).not.toContain("data-coverage-sort");

    (cards[1].block as Extract<PageBlock, { type: "link_card" }>).data.date = "2026-09-17";
    expect(renderLinkCardDirectory(cards)).not.toContain("data-coverage-sort");

    (cards[1].block as Extract<PageBlock, { type: "link_card" }>).data.date = "2025-09-23";
    expect(renderLinkCardDirectory(cards)).toContain("data-coverage-sort");
  });
});
