// @vitest-environment node
//
// Pins the two halves of the Post slug contract together.
//
// Two kinds of drift are possible and both have bitten. Across LANGUAGES: the
// Functions bundle runs a CommonJS mirror of the canonical TypeScript core, so
// the rule the server mints by can fork from the rule the model states. Across
// STRICTNESS: the writer's mint rule and the build's route rule are deliberately
// different, and the relationship between them has to hold in one direction --
// everything mintable is routable -- or a legal save fails the public build.
//
// The second one is what this branch is fixing. A post titled "New" minted the
// slug "new", which the build's stricter list refused, and a strict publish
// build fails on the first invalid document, so one post bricked every build.

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import * as ts from "../../packages/content-core/src/post-slugs";
import { isPublicContentSlug } from "../src/lib/public-content-routes";

const require = createRequire(import.meta.url);
const cjs = require("../../functions/lib/post-slug-contract.js");

// Titles chosen to exercise every branch: ordinary, reserved, unsluggable,
// punctuation-heavy, accented, apostrophes, and long enough to force a
// truncation on both the root and its numbered candidates.
const TITLES = [
  "Trenton budget hearing draws a crowd",
  "New",
  "NEW",
  "  new  ",
  "Index",
  "All",
  "Tags",
  "",
  "🎬🎬🎬",
  "État of the state",
  "New Jersey's transit fight",
  "Hello -- world!!  again",
  "A".repeat(300),
  "Trenton ".repeat(40),
  "-leading-and-trailing-",
];

describe("the CommonJS mirror matches the canonical core", () => {
  it("agrees on every exported constant", () => {
    expect(cjs.POST_SLUG_MAX).toBe(ts.POST_SLUG_MAX);
    expect(cjs.POST_SLUG_SHAPE.source).toBe(ts.POST_SLUG_SHAPE.source);
    expect(cjs.POST_SLUG_FALLBACK_ROOT).toBe(ts.POST_SLUG_FALLBACK_ROOT);
    expect(cjs.RESERVED_POST_SLUG_TAIL).toBe(ts.RESERVED_POST_SLUG_TAIL);
    expect([...cjs.RESERVED_POST_SLUGS]).toEqual([...ts.RESERVED_POST_SLUGS]);
  });

  it("agrees on every slug it derives from a title", () => {
    for (const title of TITLES) {
      expect(cjs.slugifyPostTitle(title)).toBe(ts.slugifyPostTitle(title));
      expect(cjs.mintablePostSlugRoot(title)).toBe(ts.mintablePostSlugRoot(title));
      for (const attempt of [1, 2, 3, 17, 9999]) {
        const root = ts.mintablePostSlugRoot(title);
        expect(cjs.postSlugCandidate(root, attempt)).toBe(
          ts.postSlugCandidate(root, attempt),
        );
      }
    }
  });

  it("agrees on both predicates", () => {
    const cases = [
      "trenton-budget",
      "new",
      "tags",
      "Trenton",
      "two--hyphens",
      "-leading",
      "trailing-",
      "has/slash",
      "",
      "a".repeat(ts.POST_SLUG_MAX),
      "a".repeat(ts.POST_SLUG_MAX + 1),
      "a".repeat(300),
    ];
    for (const value of cases) {
      expect(cjs.isMintablePostSlug(value)).toBe(ts.isMintablePostSlug(value));
      expect(cjs.isServerMintableSlugShape(value)).toBe(
        ts.isServerMintableSlugShape(value),
      );
    }
  });
});

describe("mintable implies routable", () => {
  it("routes every slug the writer can legally mint", () => {
    // The invariant the whole fix rests on. If this ever fails, some post can be
    // saved and then refused by its own build.
    for (const title of TITLES) {
      const root = ts.mintablePostSlugRoot(title);
      for (const attempt of [1, 2, 3, 10, 100, 1000, 10_000]) {
        const candidate = ts.postSlugCandidate(root, attempt);
        expect(ts.isMintablePostSlug(candidate)).toBe(true);
        expect(ts.isServerMintableSlugShape(candidate)).toBe(true);
        expect(isPublicContentSlug(candidate)).toBe(true);
      }
    }
  });

  it("keeps every minted candidate inside the mint bound", () => {
    const root = ts.mintablePostSlugRoot("Trenton ".repeat(40));
    for (const attempt of [1, 2, 1000, 10_000]) {
      expect(ts.postSlugCandidate(root, attempt).length).toBeLessThanOrEqual(
        ts.POST_SLUG_MAX,
      );
    }
  });

  it("never mints a reserved word, and gives it a readable tail instead", () => {
    expect(ts.mintablePostSlugRoot("New")).toBe("new-post");
    expect(ts.mintablePostSlugRoot("Index")).toBe("index-post");
    for (const reserved of ts.RESERVED_POST_SLUGS) {
      const root = ts.mintablePostSlugRoot(reserved);
      expect(ts.RESERVED_POST_SLUGS).not.toContain(root);
      expect(ts.isMintablePostSlug(root)).toBe(true);
    }
  });

  it("falls back for a title with nothing sluggable in it", () => {
    expect(ts.mintablePostSlugRoot("🎬🎬🎬")).toBe(ts.POST_SLUG_FALLBACK_ROOT);
    expect(ts.mintablePostSlugRoot("")).toBe(ts.POST_SLUG_FALLBACK_ROOT);
  });
});

describe("the build accepts what the old writer already stored", () => {
  it("routes a stored reserved slug rather than bricking the build", () => {
    // Migration-safe posture: these could be minted before the contract was
    // shared, and they are reserved forever in cmsPosts. Refusing them at build
    // time is the bug, not the guardrail.
    for (const reserved of ts.RESERVED_POST_SLUGS) {
      expect(isPublicContentSlug(reserved)).toBe(true);
    }
  });

  it("routes a stored slug longer than the mint bound", () => {
    const legacy = "a".repeat(ts.POST_SLUG_MAX + 40);
    expect(ts.isMintablePostSlug(legacy)).toBe(false);
    expect(isPublicContentSlug(legacy)).toBe(true);
  });

  it("still refuses what genuinely cannot be a route", () => {
    for (const unsafe of [
      "",
      "has/slash",
      "../escape",
      "Trenton",
      "two--hyphens",
      "-leading",
      "trailing-",
    ]) {
      expect(isPublicContentSlug(unsafe)).toBe(false);
    }
  });
});
