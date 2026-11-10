// Keep independently expected heading ranks for real page outlines.
import { describe, expect, it } from "vitest";
import { generatedHeadingLevels } from "../../packages/content-core/src/heading-outline";

interface Block {
  type: string;
  visible: boolean;
  data: unknown;
}

function headline(level: number | undefined, visible = true): Block {
  return { type: "headline", visible, data: level === undefined ? {} : { level } };
}

describe("generatedHeadingLevels", () => {
  it("starts a page of generated headings at h2 and deepens under an authored section", () => {
    expect(
      generatedHeadingLevels([
        { type: "card_grid", visible: true, data: {} },
        headline(2),
        { type: "faq_item", visible: true, data: {} },
      ]),
    ).toEqual([2, 2, 3]);
  });

  it("never goes past h6", () => {
    expect(
      generatedHeadingLevels([
        { type: "headline", visible: true, data: { level: 6 } },
        { type: "card_grid", visible: true, data: {} },
      ]),
    ).toEqual([2, 6]);
  });
});
