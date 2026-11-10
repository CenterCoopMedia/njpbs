// @vitest-environment node
//
// Pins the CommonJS mirror in functions/lib/story-credits.js to the canonical
// byline core in packages/content-core/src/story-credits.ts (issue #1040). The
// functions bundle cannot import the TypeScript module, so the deployed save and
// publish paths run a hand-written copy. Without this test the two could fork
// silently and the boundary that actually stores a byline would start accepting a
// credit shape the model refuses, or freeze a published credit differently from
// what every reader-facing surface will render.

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { mintAuthorId } from "../../packages/content-core/src/author-profiles";
import * as ts from "../../packages/content-core/src/story-credits";

const require = createRequire(import.meta.url);
const cjs = require("../../functions/lib/story-credits.js");

const ADA = mintAuthorId("a".repeat(32));
const BEN = mintAuthorId("b".repeat(32));

// Every shape either implementation might meet, including the malformed ones.
const CREDIT_CASES: unknown[] = [
  undefined,
  null,
  "Ada Reporter",
  [],
  [{ kind: "registered", authorId: ADA }],
  [{ kind: "registered", authorId: ADA, displayName: "Someone Else", slug: "x" }],
  [{ kind: "registered", authorId: "not-an-author-id" }],
  [{ kind: "registered", authorId: ADA }, { kind: "registered", authorId: ADA }],
  [{ kind: "custom", name: "  NJ\tPBS \n staff " }],
  [{ kind: "custom", name: "   " }],
  [{ kind: "custom", name: "x".repeat(400) }],
  [{ kind: "custom", name: "Ada‮Reporter" }],
  [{ kind: "custom", name: "Staff report" }, { kind: "custom", name: "Staff report" }],
  [{ kind: "registered", authorId: ADA }, { kind: "custom", name: "NJ PBS staff" }],
  [{ name: "Ada" }],
  [null],
  ["Ada"],
  Array.from({ length: 13 }, (_unused, index) => ({
    kind: "custom",
    name: `Contributor ${index}`,
  })),
];

describe("constants", () => {
  it("agrees on every bound", () => {
    expect(cjs.STORY_CREDITS_MAX).toBe(ts.STORY_CREDITS_MAX);
    expect(cjs.STORY_CREDIT_NAME_MAX).toBe(ts.STORY_CREDIT_NAME_MAX);
    expect([...cjs.STORY_CREDIT_KINDS]).toEqual([...ts.STORY_CREDIT_KINDS]);
  });
});

describe("normalizeStoryCredits", () => {
  it.each(CREDIT_CASES.map((value, index) => [index, value] as const))(
    "agrees on case %i",
    (_index, value) => {
      expect(cjs.normalizeStoryCredits(value)).toEqual(
        ts.normalizeStoryCredits(value),
      );
    },
  );
});

describe("normalizeCustomCreditName", () => {
  it.each([
    "  NJ\tPBS \n staff ",
    "Ada‮Reporter",
    "x".repeat(400),
    "ada@example.org",
    "",
    42 as unknown as string,
  ])("agrees on %p", (value) => {
    expect(cjs.normalizeCustomCreditName(value)).toBe(
      ts.normalizeCustomCreditName(value),
    );
  });
});

describe("legacy conversion and reading", () => {
  it.each(["Ada Reporter", "", "   ", undefined, null, 7])(
    "agrees converting legacy author %p",
    (author) => {
      expect(cjs.creditsFromLegacyAuthor(author)).toEqual(
        ts.creditsFromLegacyAuthor(author),
      );
    },
  );

  it.each([
    { author: "Ada Reporter" },
    { author: "Ada Reporter", credits: [] },
    { author: "Ada Reporter", credits: [{ kind: "registered", authorId: BEN }] },
    {},
  ])("agrees resolving %p", (record) => {
    expect(cjs.resolveStoryCredits(record)).toEqual(ts.resolveStoryCredits(record));
  });
});

describe("defaulting", () => {
  it.each([
    null,
    { authorId: ADA, displayName: "Ada", active: true },
    { authorId: ADA, displayName: "Ada", active: false },
    { authorId: "uid", displayName: "Ada", active: true },
  ])("agrees on %p", (identity) => {
    expect(cjs.defaultStoryCredits(identity)).toEqual(
      ts.defaultStoryCredits(identity as never),
    );
  });
});

describe("reordering", () => {
  const credits = [
    { kind: "registered" as const, authorId: ADA },
    { kind: "custom" as const, name: "NJ PBS staff" },
    { kind: "registered" as const, authorId: BEN },
  ];

  it.each([
    [0, 1],
    [2, -1],
    [0, -1],
    [2, 1],
    [9, 1],
    [0, 2],
  ])("agrees moving index %i by %i", (index, offset) => {
    expect(cjs.moveStoryCredit(credits, index, offset)).toEqual(
      ts.moveStoryCredit(credits, index, offset),
    );
  });
});

describe("publish freezing and reading", () => {
  const directory = new Map([
    [ADA, { authorId: ADA, displayName: "Ada Reporter", active: true, slug: "ada" }],
    [BEN, { authorId: BEN, displayName: "Ben Producer", active: false, slug: null }],
  ]);
  const resolve = (authorId: string) => directory.get(authorId) ?? null;

  const frozenCases = [
    [{ kind: "registered", authorId: ADA }],
    [{ kind: "registered", authorId: BEN }],
    [{ kind: "registered", authorId: mintAuthorId("c".repeat(32)) }],
    [
      {
        kind: "registered",
        authorId: mintAuthorId("d".repeat(32)),
        displayName: "Gone Reporter",
      },
    ],
    [
      { kind: "custom", name: "NJ PBS staff" },
      { kind: "registered", authorId: ADA },
    ],
    [],
  ];

  it.each(frozenCases.map((value, index) => [index, value] as const))(
    "freezes case %i identically",
    (_index, credits) => {
      expect(cjs.freezeStoryCredits(credits, resolve)).toEqual(
        ts.freezeStoryCredits(credits as never, resolve as never),
      );
    },
  );

  it.each(frozenCases.map((value, index) => [index, value] as const))(
    "reads case %i identically",
    (_index, credits) => {
      const frozen = ts.freezeStoryCredits(credits as never, resolve as never);
      expect(cjs.storyCreditNames(frozen)).toEqual(ts.storyCreditNames(frozen));
      expect(cjs.storyCreditsByline(frozen)).toBe(ts.storyCreditsByline(frozen));
      expect(frozen.map(cjs.storyCreditKey)).toEqual(frozen.map(ts.storyCreditKey));
    },
  );
});

// The server-only half. It has no TypeScript twin because it is a statement about
// stored identities rather than about a byline's shape, so it is specified here.
describe("registeredCreditsError", () => {
  const identities = new Map([
    [ADA, { authorId: ADA, displayName: "Ada Reporter", active: true }],
    [BEN, { authorId: BEN, displayName: "Ben Producer", active: false }],
  ]);

  it("accepts a byline crediting an active author", () => {
    expect(
      cjs.registeredCreditsError([{ kind: "registered", authorId: ADA }], identities),
    ).toBeNull();
  });

  it("accepts a byline of custom credits with nothing to look up", () => {
    expect(
      cjs.registeredCreditsError(
        [{ kind: "custom", name: "NJ PBS staff" }],
        new Map(),
      ),
    ).toBeNull();
  });

  it("refuses newly crediting an author that does not exist", () => {
    expect(
      cjs.registeredCreditsError(
        [{ kind: "registered", authorId: mintAuthorId("e".repeat(32)) }],
        identities,
      ),
    ).toMatch(/do not recognize/);
  });

  it("refuses newly crediting a deactivated author", () => {
    expect(
      cjs.registeredCreditsError([{ kind: "registered", authorId: BEN }], identities),
    ).toMatch(/no longer active/);
  });

  it("keeps a story editable when it already credited the author who left", () => {
    expect(
      cjs.registeredCreditsError(
        [{ kind: "registered", authorId: BEN }],
        identities,
        new Set([BEN]),
      ),
    ).toBeNull();
  });
});
