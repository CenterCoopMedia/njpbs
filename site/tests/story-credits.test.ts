// The ordered-byline contract (issue #1040). These cases are the acceptance
// criteria, not incidental coverage: defaulting, multiple credits, custom
// credits, reordering, deactivation, snapshot stability, and legacy conversion.

import { describe, expect, it } from "vitest";
import { mintAuthorId } from "../../packages/content-core/src/author-profiles";
import {
  STORY_CREDITS_MAX,
  STORY_CREDIT_NAME_MAX,
  creditsFromLegacyAuthor,
  defaultStoryCredits,
  freezeStoryCredits,
  moveStoryCredit,
  normalizeCustomCreditName,
  normalizeStoryCredits,
  resolveStoryCredits,
  storyCreditKey,
  storyCreditNames,
  storyCreditsByline,
  type AuthorIdentitySummary,
  type StoryCredit,
} from "../../packages/content-core/src/story-credits";

const ADA = mintAuthorId("a".repeat(32));
const BEN = mintAuthorId("b".repeat(32));
const CAM = mintAuthorId("c".repeat(32));

function identity(
  authorId: string,
  displayName: string,
  overrides: Partial<AuthorIdentitySummary> = {},
): AuthorIdentitySummary {
  return { authorId, displayName, active: true, slug: null, ...overrides };
}

function directory(
  ...people: AuthorIdentitySummary[]
): (authorId: string) => AuthorIdentitySummary | null {
  const byId = new Map(people.map((person) => [person.authorId, person]));
  return (authorId) => byId.get(authorId) ?? null;
}

describe("normalizeStoryCredits", () => {
  it("keeps an ordered mix of registered and custom credits", () => {
    const result = normalizeStoryCredits([
      { kind: "registered", authorId: ADA },
      { kind: "custom", name: "NJ PBS staff" },
      { kind: "registered", authorId: BEN },
    ]);
    expect(result.ok).toBe(true);
    expect(result.credits).toEqual([
      { kind: "registered", authorId: ADA },
      { kind: "custom", name: "NJ PBS staff" },
      { kind: "registered", authorId: BEN },
    ]);
  });

  it("treats an absent byline as an empty list rather than an error", () => {
    expect(normalizeStoryCredits(undefined)).toEqual({
      ok: true,
      credits: [],
      errors: [],
    });
  });

  it("refuses a byline that is not a list", () => {
    const result = normalizeStoryCredits("Ada Reporter");
    expect(result.ok).toBe(false);
    expect(result.credits).toEqual([]);
  });

  it("refuses a credit whose author id is not a minted id", () => {
    const result = normalizeStoryCredits([
      { kind: "registered", authorId: "uid-from-firebase-auth" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it("refuses a credit with no recognized kind", () => {
    expect(normalizeStoryCredits([{ name: "Ada" }]).ok).toBe(false);
    expect(normalizeStoryCredits([null]).ok).toBe(false);
  });

  it("refuses more credits than a byline may carry", () => {
    const many = Array.from({ length: STORY_CREDITS_MAX + 1 }, (_unused, index) => ({
      kind: "custom" as const,
      name: `Contributor ${index}`,
    }));
    expect(normalizeStoryCredits(many).ok).toBe(false);
    expect(normalizeStoryCredits(many.slice(0, STORY_CREDITS_MAX)).ok).toBe(true);
  });

  it("drops a client-supplied display name from a working credit", () => {
    const result = normalizeStoryCredits([
      { kind: "registered", authorId: ADA, displayName: "Someone Else", slug: "someone" },
    ]);
    expect(result.credits).toEqual([{ kind: "registered", authorId: ADA }]);
  });

  it("collapses a repeated author to its first position", () => {
    const result = normalizeStoryCredits([
      { kind: "registered", authorId: ADA },
      { kind: "registered", authorId: BEN },
      { kind: "registered", authorId: ADA },
    ]);
    expect(result.credits).toEqual([
      { kind: "registered", authorId: ADA },
      { kind: "registered", authorId: BEN },
    ]);
  });

  it("drops a blank custom row instead of failing the save", () => {
    const result = normalizeStoryCredits([
      { kind: "custom", name: "   " },
      { kind: "custom", name: "NJ PBS staff" },
    ]);
    expect(result.ok).toBe(true);
    expect(result.credits).toEqual([{ kind: "custom", name: "NJ PBS staff" }]);
  });

  it("keeps two identical custom credits, because text is not identity", () => {
    const result = normalizeStoryCredits([
      { kind: "custom", name: "Staff report" },
      { kind: "custom", name: "Staff report" },
    ]);
    expect(result.credits).toHaveLength(2);
  });
});

describe("normalizeCustomCreditName", () => {
  it("collapses whitespace and strips control characters", () => {
    expect(normalizeCustomCreditName("  NJ\tPBS \n staff ")).toBe("NJ PBS staff");
    expect(normalizeCustomCreditName("Ada‮Reporter")).toBe("Ada Reporter");
  });

  it("bounds the stored length", () => {
    expect(normalizeCustomCreditName("x".repeat(400))).toHaveLength(
      STORY_CREDIT_NAME_MAX,
    );
  });

  it("never treats text as an identity", () => {
    // An email or a uid typed into a custom credit is text and stays text: this
    // module does not detect identities, so nothing is resolved or rejected.
    expect(normalizeCustomCreditName("ada@example.org")).toBe("ada@example.org");
    expect(normalizeCustomCreditName(ADA)).toBe(ADA);
  });
});

describe("legacy conversion", () => {
  it("converts one free-text author into exactly one custom credit", () => {
    expect(creditsFromLegacyAuthor("Ada Reporter")).toEqual([
      { kind: "custom", name: "Ada Reporter" },
    ]);
  });

  it("never guesses a registered identity from matching text", () => {
    const credits = creditsFromLegacyAuthor("Ada Reporter");
    expect(credits.every((credit) => credit.kind === "custom")).toBe(true);
  });

  it("converts a blank or missing author into no byline", () => {
    expect(creditsFromLegacyAuthor("")).toEqual([]);
    expect(creditsFromLegacyAuthor(undefined)).toEqual([]);
  });

  it("reads a legacy record through resolveStoryCredits", () => {
    expect(resolveStoryCredits({ author: "Ada Reporter" })).toEqual([
      { kind: "custom", name: "Ada Reporter" },
    ]);
  });

  it("prefers stored credits over a stale legacy author", () => {
    expect(
      resolveStoryCredits({
        author: "Ada Reporter",
        credits: [{ kind: "registered", authorId: BEN }],
      }),
    ).toEqual([{ kind: "registered", authorId: BEN }]);
  });

  it("treats a deliberately emptied byline as empty, not as legacy", () => {
    expect(resolveStoryCredits({ author: "Ada Reporter", credits: [] })).toEqual([]);
  });
});

describe("defaultStoryCredits", () => {
  it("credits the signed-in author when their identity is active", () => {
    expect(defaultStoryCredits(identity(ADA, "Ada Reporter"))).toEqual([
      { kind: "registered", authorId: ADA },
    ]);
  });

  it("defaults to no byline for an account with no linked identity", () => {
    expect(defaultStoryCredits(null)).toEqual([]);
  });

  it("defaults to no byline for a deactivated identity", () => {
    expect(
      defaultStoryCredits(identity(ADA, "Ada Reporter", { active: false })),
    ).toEqual([]);
  });
});

describe("moveStoryCredit", () => {
  const credits: StoryCredit[] = [
    { kind: "registered", authorId: ADA },
    { kind: "custom", name: "NJ PBS staff" },
    { kind: "registered", authorId: BEN },
  ];

  it("moves a credit down and keeps the rest in order", () => {
    expect(moveStoryCredit(credits, 0, 1)).toEqual([
      { kind: "custom", name: "NJ PBS staff" },
      { kind: "registered", authorId: ADA },
      { kind: "registered", authorId: BEN },
    ]);
  });

  it("moves a credit up", () => {
    expect(moveStoryCredit(credits, 2, -1)[1]).toEqual({
      kind: "registered",
      authorId: BEN,
    });
  });

  it("leaves the list unchanged at either end", () => {
    expect(moveStoryCredit(credits, 0, -1)).toEqual(credits);
    expect(moveStoryCredit(credits, 2, 1)).toEqual(credits);
    expect(moveStoryCredit(credits, 9, 1)).toEqual(credits);
  });

  it("returns a new list rather than reordering in place", () => {
    const moved = moveStoryCredit(credits, 0, 1);
    expect(moved).not.toBe(credits);
    expect(credits[0]).toEqual({ kind: "registered", authorId: ADA });
  });

  it("gives each credit a stable key across a reorder", () => {
    const before = credits.map(storyCreditKey);
    const after = moveStoryCredit(credits, 0, 2).map(storyCreditKey);
    expect([...after].sort()).toEqual([...before].sort());
  });
});

describe("freezeStoryCredits", () => {
  it("freezes the display name and public slug at publish time", () => {
    const frozen = freezeStoryCredits(
      [{ kind: "registered", authorId: ADA }],
      directory(identity(ADA, "Ada Reporter", { slug: "ada-reporter" })),
    );
    expect(frozen).toEqual([
      {
        kind: "registered",
        authorId: ADA,
        displayName: "Ada Reporter",
        slug: "ada-reporter",
      },
    ]);
  });

  it("freezes the name without a slug when the profile is not public", () => {
    const frozen = freezeStoryCredits(
      [{ kind: "registered", authorId: ADA }],
      directory(identity(ADA, "Ada Reporter", { slug: null })),
    );
    expect(frozen[0]).toEqual({
      kind: "registered",
      authorId: ADA,
      displayName: "Ada Reporter",
    });
  });

  it("keeps a deactivated author's byline readable and unlinked", () => {
    const frozen = freezeStoryCredits(
      [{ kind: "registered", authorId: ADA }],
      directory(identity(ADA, "Ada Reporter", { active: false, slug: null })),
    );
    expect(storyCreditNames(frozen)).toEqual(["Ada Reporter"]);
    expect(frozen[0]).not.toHaveProperty("slug");
  });

  it("keeps a name already frozen by an earlier publish when the profile is gone", () => {
    const frozen = freezeStoryCredits(
      [{ kind: "registered", authorId: ADA, displayName: "Ada Reporter" }],
      directory(),
    );
    expect(frozen).toEqual([
      { kind: "registered", authorId: ADA, displayName: "Ada Reporter" },
    ]);
  });

  it("drops a credit that has no readable name rather than publishing an id", () => {
    const frozen = freezeStoryCredits(
      [
        { kind: "registered", authorId: ADA },
        { kind: "custom", name: "NJ PBS staff" },
      ],
      directory(),
    );
    expect(frozen).toEqual([{ kind: "custom", name: "NJ PBS staff" }]);
  });

  it("passes custom credits through untouched and in order", () => {
    const frozen = freezeStoryCredits(
      [
        { kind: "custom", name: "NJ PBS staff" },
        { kind: "registered", authorId: BEN },
      ],
      directory(identity(BEN, "Ben Producer", { slug: "ben-producer" })),
    );
    expect(frozen.map(storyCreditKey)).toEqual([
      "custom:NJ PBS staff",
      `registered:${BEN}`,
    ]);
  });

  it("keeps a published byline stable after a later rename", () => {
    // The snapshot is frozen once. Renaming the author afterwards changes the
    // working directory, never the revision that already went out.
    const published = freezeStoryCredits(
      [{ kind: "registered", authorId: ADA }],
      directory(identity(ADA, "Ada Reporter", { slug: "ada-reporter" })),
    );
    const afterRename = directory(
      identity(ADA, "Ada Newname", { slug: "ada-newname" }),
    );
    expect(afterRename(ADA)?.displayName).toBe("Ada Newname");
    expect(storyCreditNames(published)).toEqual(["Ada Reporter"]);
  });
});

describe("reading a byline", () => {
  it("lists names in credit order", () => {
    const credits = freezeStoryCredits(
      [
        { kind: "registered", authorId: ADA },
        { kind: "custom", name: "NJ PBS staff" },
        { kind: "registered", authorId: CAM },
      ],
      directory(identity(ADA, "Ada Reporter"), identity(CAM, "Cam Editor")),
    );
    expect(storyCreditNames(credits)).toEqual([
      "Ada Reporter",
      "NJ PBS staff",
      "Cam Editor",
    ]);
  });

  it("joins one, two, and three credits in AP style", () => {
    expect(storyCreditsByline([{ kind: "custom", name: "Ada" }])).toBe("Ada");
    expect(
      storyCreditsByline([
        { kind: "custom", name: "Ada" },
        { kind: "custom", name: "Ben" },
      ]),
    ).toBe("Ada and Ben");
    expect(
      storyCreditsByline([
        { kind: "custom", name: "Ada" },
        { kind: "custom", name: "Ben" },
        { kind: "custom", name: "Cam" },
      ]),
    ).toBe("Ada, Ben and Cam");
  });

  it("reads as no byline when there are no credits", () => {
    expect(storyCreditsByline([])).toBe("");
  });
});
