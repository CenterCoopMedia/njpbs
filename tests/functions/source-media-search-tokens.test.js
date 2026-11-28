import { describe, expect, it } from "vitest";
import searchTokens from "../../functions/lib/source-media-search-tokens.js";

const {
  MAX_SEARCH_TOKENS, MAX_SEARCH_TOKEN_LENGTH, matchesSourceMediaSearch, sourceMediaSearchPlan, sourceMediaSearchTokens,
} = searchTokens;

describe("video search tokens", () => {
  it("stores lowercase NFKC words from the name, tags and description without repeats", () => {
    expect(sourceMediaSearchTokens({
      name: "Dusk harbor — ＴＩＭＥＬＡＰＳＥ", tags: ["Harbor", "b-roll"], description: "Ferry at dusk, 2026.",
    })).toEqual(["dusk", "harbor", "timelapse", "b", "roll", "ferry", "at", "2026"]);
    expect(sourceMediaSearchTokens({ name: "Café crème" })).toEqual(["café", "crème"]);
    expect(sourceMediaSearchTokens({ name: "Only name", description: null, tags: undefined })).toEqual(["only", "name"]);
    expect(sourceMediaSearchTokens()).toEqual([]);
  });

  it("stores every word of the largest valid metadata", () => {
    // Distinct one-character words: each CJK ideograph is a letter that NFKC keeps.
    let next = 0x4e00;
    const words = (count) => Array.from({ length: count }, () => String.fromCodePoint(next++)).join(" ");
    const name = words(250);
    const tags = Array.from({ length: 30 }, () => words(40));
    const description = words(1000);
    expect([name.length, Math.max(...tags.map((tag) => tag.length)), description.length]).toEqual([499, 79, 1999]);
    const tokens = sourceMediaSearchTokens({ name, tags, description });
    expect(tokens).toHaveLength(2450);
    expect(tokens.at(-1)).toBe(String.fromCodePoint(next - 1));
    expect(MAX_SEARCH_TOKENS).toBeGreaterThan(tokens.length);
  });

  it("bounds the word count and length and keeps name words first", () => {
    const description = Array.from({ length: MAX_SEARCH_TOKENS + 50 }, (_, index) => `word${index}`).join(" ");
    const tokens = sourceMediaSearchTokens({ name: "Lead title", description });
    expect(tokens).toHaveLength(MAX_SEARCH_TOKENS);
    expect(tokens.slice(0, 2)).toEqual(["lead", "title"]);
    const [long] = sourceMediaSearchTokens({ name: `${"🎥".repeat(2)}${"é".repeat(60)}` });
    expect(Array.from(long)).toHaveLength(MAX_SEARCH_TOKEN_LENGTH);
  });

  it("indexes the longest query word and matches the rest as word starts", () => {
    const tokens = sourceMediaSearchTokens({ name: "Dusk harbor", tags: ["ferry"] });
    expect(sourceMediaSearchPlan("  HARBOR dusk ")).toEqual({ indexed: "harbor", rest: ["dusk"], words: ["harbor", "dusk"] });
    expect(sourceMediaSearchPlan("--- ")).toBeNull();
    expect(matchesSourceMediaSearch(tokens, sourceMediaSearchPlan("harbor"))).toBe(true);
    expect(matchesSourceMediaSearch(tokens, sourceMediaSearchPlan("harbor fer"))).toBe(true);
    expect(matchesSourceMediaSearch(tokens, sourceMediaSearchPlan("harbor night"))).toBe(false);
    expect(matchesSourceMediaSearch(tokens, sourceMediaSearchPlan("harb"))).toBe(false);
    expect(matchesSourceMediaSearch(undefined, sourceMediaSearchPlan("harbor"))).toBe(false);
  });
});
