import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { createBlock, defaultBlockData } from "../src/lib/block-factory";
import { parseBlocks } from "../../packages/content-core/src/content-model";
import { editorFieldsForBlock } from "../../packages/content-core/src/editor-admin";

beforeEach(() => vi.stubEnv("VITE_CMS_HOME_LAYOUTS_ENABLED", undefined));
afterEach(() => vi.unstubAllEnvs());

describe("defaultBlockData", () => {
  it("starts an explicitly inserted support appeal ready to publish", () => {
    const block = createBlock("support_appeal", "appeal");
    expect(block.data).toMatchObject({ heading: "Before you go, a request for help…", buttonLabel: "Donate to the NJ PBS Year-End Fund",
      href: "https://www.pbs.org/donation/?station_id=63b643e1-1a13-4dd9-9bab-ff6f7527715f&campaign=passport", style: "blue" });
    expect(parseBlocks([block]).ok).toBe(true);
  });
  it("creates production-compatible content shelves when Home layouts are disabled", () => {
    vi.stubEnv("VITE_CMS_HOME_LAYOUTS_ENABLED", "false");
    expect(createBlock("content_shelf", "shelf").data).toEqual({
      title: "", source: "pbs_featured", itemLimit: 4, moreLabel: "", moreHref: "",
    });
    expect(defaultBlockData("promotion_playlist")).toMatchObject({ presentation: "rail", columns: 3 });
  });

  it.each([undefined, "true", "", "FALSE", "0"])("enables Home layouts for flag value %s", (value) => {
    vi.stubEnv("VITE_CMS_HOME_LAYOUTS_ENABLED", value);
    expect(createBlock("content_shelf", "shelf").data).toMatchObject({ presentation: "grid", columns: 3, itemLimit: 3 });
  });

  it("offers the admitted shelf counts and starts new shelves with a three-column grid", () => {
    const itemLimitField = editorFieldsForBlock("content_shelf")
      .find((field) => field.key === "itemLimit");
    expect(itemLimitField?.options?.map((option) => option.value)).toEqual([3, 4, 6, 8, 12, 16, 24]);
    expect(defaultBlockData("content_shelf")).toEqual({
      title: "",
      source: "pbs_featured",
      itemLimit: 3,
      presentation: "grid",
      columns: 3,
      moreLabel: "",
      moreHref: "",
    });
    const block = createBlock("content_shelf", "shelf");
    expect(block.data.itemLimit).toBe(3);
    for (const itemLimit of [3, 6]) {
      const blocks = [{ ...block, data: { ...block.data, itemLimit } }];
      expect(parseBlocks(blocks)).toEqual({ ok: true, blocks });
    }
  });

});
