import { describe, expect, it } from "vitest";
import { mixedTagTokens, tagMatchFor, tagSuggestions, tagTokenEdit, tagsToTokens, tokensToTags } from "../src/lib/media-tags";

const items = (...lists: string[][]) => lists.map((tags) => ({ tags }));

describe("media tag tokens", () => {
  it("converts stored tags to tokens and back without changing spelling", () => {
    expect(tagsToTokens(["Interview", "interview"])).toEqual([{ value: "Interview" }, { value: "interview" }]);
    expect(tokensToTags([{ value: "Newark" }, { value: "B-roll", mixed: true }])).toEqual(["Newark", "B-roll"]);
    expect(tagMatchFor("images")).toBe("case-insensitive");
    expect(tagMatchFor("video")).toBe("exact");
  });

  it("marks a tag mixed when it is not on every selected item and keeps first-seen order", () => {
    for (const match of ["exact", "case-insensitive"] as const) {
      expect(mixedTagTokens(items(["Newark", "Budget"], ["Trenton", "Newark"]), match)).toEqual([
        { value: "Newark" }, { value: "Budget", mixed: true }, { value: "Trenton", mixed: true },
      ]);
    }
    expect(mixedTagTokens([], "exact")).toEqual([]);
    // A tag stored twice on one item still counts once for that item.
    expect(mixedTagTokens(items(["Newark", "Newark"], []), "exact")).toEqual([{ value: "Newark", mixed: true }]);
  });

  it("returns add and remove from the original and edited tokens", () => {
    const original = mixedTagTokens(items(["Newark", "Budget"], ["Newark", "Trenton"]), "exact");
    // Remove Budget, promote Trenton to every item, add Housing, leave Newark alone.
    const next = [{ value: "Newark" }, { value: "Trenton" }, { value: "Housing" }];
    expect(tagTokenEdit(original, next, "exact")).toEqual({ add: ["Trenton", "Housing"], remove: ["Budget"] });
    // A mixed token left mixed is neither added nor removed.
    expect(tagTokenEdit(original, original, "exact")).toEqual({ add: [], remove: [] });
  });

  it("images: case variants on different items are one token spelled as first seen, solid when every item holds a spelling, and removing it removes each item's spelling", () => {
    const tokens = mixedTagTokens(items(["Interview"], ["interview", "Newark"]), "case-insensitive");
    expect(tokens).toEqual([{ value: "Interview" }, { value: "Newark", mixed: true }]);
    expect(mixedTagTokens(items(["Interview"], ["Newark"]), "case-insensitive")).toEqual([
      { value: "Interview", mixed: true }, { value: "Newark", mixed: true },
    ]);
    const edit = tagTokenEdit(tokens, [{ value: "Newark", mixed: true }], "case-insensitive");
    // The plan removes with the same match, so either stored spelling goes.
    expect(edit).toEqual({ add: [], remove: ["Interview"] });
    // A retyped spelling of a token already there is not a new tag.
    expect(tagTokenEdit(tokens, [{ value: "INTERVIEW" }, { value: "Newark", mixed: true }], "case-insensitive")).toEqual({ add: [], remove: [] });
  });

  it("video: case variants stay separate tokens with their own mixed state, and removing one leaves the other", () => {
    const tokens = mixedTagTokens(items(["Interview", "interview"], ["interview"]), "exact");
    expect(tokens).toEqual([{ value: "Interview", mixed: true }, { value: "interview" }]);
    expect(tagTokenEdit(tokens, [{ value: "Interview", mixed: true }], "exact")).toEqual({ add: [], remove: ["interview"] });
    expect(tagTokenEdit(tokens, [{ value: "interview" }], "exact")).toEqual({ add: [], remove: ["Interview"] });
  });

  it("suggests selection tags, then page tags, then recent tags, by prefix, without used tags, at most 8", () => {
    expect(tagSuggestions({
      selection: ["Newark", "Budget"],
      page: ["Nature", "Newark", "Night"],
      recent: ["News", "Nurses", "Budget", "Nutrition", "Nj", "Navy", "Nets"],
      used: ["Night"],
      query: " n",
    })).toEqual(["Newark", "Nature", "News", "Nurses", "Nutrition", "Nj", "Navy", "Nets"]);
    expect(tagSuggestions({ selection: ["Newark"], page: [], recent: [], used: [], query: "" })).toEqual([]);
    expect(tagSuggestions({ selection: ["Newark", "Nature"], page: [], recent: [], used: [], query: "n", limit: 1 })).toEqual(["Newark"]);
  });

  it("never suggests a tag already used in another letter case", () => {
    expect(tagSuggestions({
      selection: ["interview"],
      page: ["Interview", "INTERVIEWS"],
      recent: ["Interviews"],
      used: ["INTERVIEW"],
      query: "inter",
    })).toEqual(["INTERVIEWS"]);
  });
});
