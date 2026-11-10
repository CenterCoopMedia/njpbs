// Ordered story bylines (issue #1040, on the #1044 author-identity architecture).
//
// A post used to carry one free-text `author` string. That is wrong three ways at
// once: two reporters cannot share a byline, a renamed staffer's old stories keep
// the old spelling forever, and there is nothing a future author page could ever
// link to because the credit is prose, not a reference.
//
// A byline is therefore an ORDERED LIST of credits, and a credit is one of exactly
// two things:
//
// - `registered` — a person who has an author identity in the CMS. It stores the
//   stable opaque `authorId` minted by #1044 and NOTHING ELSE on the working
//   document. The name is deliberately not stored there: the whole point of the
//   identity spine is that a rename fixes every draft at once. At PUBLISH time the
//   name IS frozen into the published snapshot, because a published page must keep
//   reading correctly after the author is renamed, deactivated, or has their public
//   profile withdrawn.
// - `custom` — bounded, sanitized display text: "NJ PBS staff", "The Associated
//   Press", a guest contributor who will never have an account. A custom credit
//   creates no account, no profile, and no identity. It is text.
//
// Two rules hold this together and are enforced here rather than left to callers:
//
// 1. **No fuzzy identity matching, ever.** Legacy free-text `author` converts to
//    exactly one custom credit, deterministically. Nothing in this module looks at
//    a custom credit's text and tries to decide which staff member it "probably"
//    means. Guessing wrong attributes a story to the wrong journalist.
// 2. **A published credit stays readable.** Freezing happens once, at publish, and
//    a later withdrawal or missing profile never blanks a byline; the frozen name
//    remains and only the LINK to a public author page goes away.
//
// Everything here is pure: no clock, no network, no Firestore. The server resolves
// identities and passes them in. Cloud Functions cannot import TypeScript from
// their deploy bundle, so functions/lib/story-credits.js mirrors this contract in
// CommonJS and site/tests/story-credits-parity.test.ts holds the two together.

import { isAuthorId } from "./author-profiles.ts";

export const STORY_CREDIT_KINDS = ["registered", "custom"] as const;

/** The most credits one story may carry. A byline, not a masthead. */
export const STORY_CREDITS_MAX = 12;

/** Character bound on any credit's display text, matching `AUTHOR_NAME_MAX`. */
export const STORY_CREDIT_NAME_MAX = 120;

/**
 * A credit naming someone with a CMS author identity.
 *
 * `authorId` is the only field an editor's save may set. `displayName` and `slug`
 * are frozen by the server at publish time and are absent on a working document —
 * a client that sends them is not trusted, it is corrected.
 */
export interface RegisteredStoryCredit {
  kind: "registered";
  /** Stable opaque author id (`au_…`), the join key to the author profile. */
  authorId: string;
  /**
   * The name as it read when this revision published. Present only in a published
   * snapshot. This is what keeps an old story's byline honest after a rename: the
   * page says who was credited then, and `authorId` still points at who that is now.
   */
  displayName?: string;
  /**
   * The author's public profile slug when this revision published, if the author
   * had a public profile then. Absent means the byline renders as plain text with
   * no link — the correct result for a private, withdrawn, or deactivated author.
   */
  slug?: string;
}

/** A credit that is display text and nothing more. */
export interface CustomStoryCredit {
  kind: "custom";
  /** Bounded, sanitized display text. Never resolved against any identity. */
  name: string;
}

export type StoryCredit = RegisteredStoryCredit | CustomStoryCredit;

/** What a caller may hand `normalizeStoryCredits`. */
export interface StoryCreditsNormalization {
  ok: boolean;
  credits: StoryCredit[];
  errors: string[];
}

/** One resolved author identity, as the server reads it at the write boundary. */
export interface AuthorIdentitySummary {
  authorId: string;
  displayName: string;
  /** False for a deactivated account. A deactivated author may not be newly credited. */
  active: boolean;
  /** The public profile slug, or null when the profile is private or withdrawn. */
  slug?: string | null;
}

// -- sanitization -------------------------------------------------------------

// Control characters (including the bidirectional overrides that can make a name
// render as something else entirely) are removed rather than escaped, and runs of
// whitespace collapse. A credit is a name on a page, so it has no legitimate use
// for a newline, a tab, or U+202E.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

function sanitizeCreditText(value: string): string {
  return value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
}

/**
 * Clean one custom credit's text to exactly what may be stored: control characters
 * stripped, whitespace collapsed, bounded length. Exported because the admin control
 * shows the editor the same value the server will keep, rather than silently
 * rewriting their typing after the save.
 */
export function normalizeCustomCreditName(value: unknown): string {
  if (typeof value !== "string") return "";
  return sanitizeCreditText(value).slice(0, STORY_CREDIT_NAME_MAX);
}

// -- normalization ------------------------------------------------------------

function normalizeOne(
  raw: unknown,
  index: number,
  errors: string[],
): StoryCredit | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    errors.push(`Credit ${index + 1} is not a credit`);
    return null;
  }
  const value = raw as Record<string, unknown>;
  const kind = value.kind;
  if (kind === "registered") {
    if (!isAuthorId(value.authorId)) {
      errors.push(`Credit ${index + 1} names an author we do not recognize`);
      return null;
    }
    // Only the id survives from a client. A submitted display name is dropped, not
    // rejected: RecordForm round-trips a loaded published credit, and refusing that
    // would make an ordinary re-save of a published post impossible.
    return { kind: "registered", authorId: value.authorId };
  }
  if (kind === "custom") {
    const name = normalizeCustomCreditName(value.name);
    if (name.length === 0) {
      // A blank row is the half-finished state of the admin control, not an error
      // worth refusing a save over. Drop it.
      return null;
    }
    return { kind: "custom", name };
  }
  errors.push(`Credit ${index + 1} is not a registered or custom byline`);
  return null;
}

/**
 * Validate and clean an untrusted credit list into exactly what may be stored.
 *
 * Order is preserved — it is editorial meaning, not incidental. Duplicate
 * registered ids collapse to their FIRST position, so crediting the same person
 * twice cannot double a byline; duplicate custom text is left alone, because two
 * identical strings can legitimately be two different outside contributors and
 * this module does not decide who someone is.
 */
export function normalizeStoryCredits(value: unknown): StoryCreditsNormalization {
  if (value === undefined || value === null) {
    return { ok: true, credits: [], errors: [] };
  }
  if (!Array.isArray(value)) {
    return { ok: false, credits: [], errors: ["Bylines must be a list"] };
  }
  const errors: string[] = [];
  if (value.length > STORY_CREDITS_MAX) {
    return {
      ok: false,
      credits: [],
      errors: [`A story can carry at most ${STORY_CREDITS_MAX} bylines`],
    };
  }
  const credits: StoryCredit[] = [];
  const seenAuthorIds = new Set<string>();
  value.forEach((raw, index) => {
    const credit = normalizeOne(raw, index, errors);
    if (!credit) return;
    if (credit.kind === "registered") {
      if (seenAuthorIds.has(credit.authorId)) return;
      seenAuthorIds.add(credit.authorId);
    }
    credits.push(credit);
  });
  return { ok: errors.length === 0, credits: errors.length === 0 ? credits : [], errors };
}

// -- legacy conversion --------------------------------------------------------

/**
 * Convert a pre-#1040 free-text `author` into the one credit it deterministically
 * is: a custom credit holding that exact text.
 *
 * This is the whole migration. It never consults the staff directory, never
 * matches on name, and never produces a registered credit — a string that happens
 * to read "Joe Amditis" is not evidence that the Joe Amditis account wrote the
 * story, and treating it as such would silently attach one journalist's identity
 * to work that may not be theirs. An editor promotes a legacy byline to a
 * registered one by picking the person, which is a human decision with a human
 * behind it.
 */
export function creditsFromLegacyAuthor(author: unknown): StoryCredit[] {
  const name = normalizeCustomCreditName(author);
  return name.length === 0 ? [] : [{ kind: "custom", name }];
}

/**
 * The credits to display for any record, new or legacy.
 *
 * A record saved under this contract answers from `credits`. One that predates it
 * answers from its `author` string through the deterministic conversion above. A
 * record holding an EMPTY `credits` array has been edited under this contract and
 * deliberately has no byline, so its legacy `author` is not resurrected.
 */
export function resolveStoryCredits(
  record: { credits?: unknown; author?: unknown } | null | undefined,
): StoryCredit[] {
  if (!record) return [];
  if (Array.isArray(record.credits)) {
    return normalizeStoryCredits(record.credits).credits;
  }
  return creditsFromLegacyAuthor(record.author);
}

// -- defaulting ---------------------------------------------------------------

/**
 * The byline a brand-new post starts with.
 *
 * Only an account with a linked ACTIVE author identity defaults to itself. An
 * account with no identity, or a deactivated one, starts with no byline rather
 * than a guess — an empty byline an editor must fill is a visible gap, while a
 * wrong one looks finished and ships.
 */
export function defaultStoryCredits(
  identity: AuthorIdentitySummary | null | undefined,
): StoryCredit[] {
  if (!identity || !identity.active || !isAuthorId(identity.authorId)) return [];
  return [{ kind: "registered", authorId: identity.authorId }];
}

// -- ordering -----------------------------------------------------------------

/** A stable credit key for React rows and reorder assertions. */
export function storyCreditKey(credit: StoryCredit): string {
  return credit.kind === "registered"
    ? `registered:${credit.authorId}`
    : `custom:${credit.name}`;
}

/**
 * Move one credit by `offset` positions, returning a new list. Out-of-range moves
 * return the list unchanged rather than clamping, so a reorder control's disabled
 * end state and its behaviour cannot disagree.
 */
export function moveStoryCredit(
  credits: readonly StoryCredit[],
  index: number,
  offset: number,
): StoryCredit[] {
  const target = index + offset;
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= credits.length ||
    target < 0 ||
    target >= credits.length
  ) {
    return [...credits];
  }
  const next = [...credits];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return next;
}

// -- publish freezing ---------------------------------------------------------

/**
 * Freeze the display names into the credits going into a published snapshot.
 *
 * A registered credit keeps its `authorId` (so a future author page can still link
 * the story to the person) and gains the name and public slug as they read at this
 * instant. Cases the resolver may report, and what each does:
 *
 * - identity found, public profile → name and slug frozen; the byline links.
 * - identity found, private/withdrawn profile → name frozen, no slug; the byline
 *   reads correctly and does not link to a page that is not there.
 * - identity deactivated → same as above. Deactivation withdraws a public profile;
 *   it does not un-write the story or erase who wrote it.
 * - identity missing entirely → any name already frozen by an earlier publish is
 *   kept; failing that the credit is DROPPED rather than published as a raw
 *   `au_…` id, which is machine noise on a public page.
 *
 * Custom credits pass through untouched: there is nothing to resolve.
 */
export function freezeStoryCredits(
  credits: readonly StoryCredit[],
  resolve: (authorId: string) => AuthorIdentitySummary | null | undefined,
): StoryCredit[] {
  const frozen: StoryCredit[] = [];
  for (const credit of credits) {
    if (credit.kind === "custom") {
      frozen.push({ kind: "custom", name: credit.name });
      continue;
    }
    const identity = resolve(credit.authorId);
    const displayName = normalizeCustomCreditName(
      identity?.displayName ?? credit.displayName ?? "",
    );
    if (displayName.length === 0) continue;
    const slug =
      identity && typeof identity.slug === "string" && identity.slug.length > 0
        ? identity.slug
        : undefined;
    frozen.push({
      kind: "registered",
      authorId: credit.authorId,
      displayName,
      ...(slug === undefined ? {} : { slug }),
    });
  }
  return frozen;
}

// -- reading ------------------------------------------------------------------

/**
 * The display names of a credit list, in order, for a byline line, a search
 * document, or structured data. A registered credit that was never frozen has no
 * readable name and is omitted rather than rendered as its id.
 */
export function storyCreditNames(credits: readonly StoryCredit[]): string[] {
  return credits
    .map((credit) =>
      credit.kind === "custom" ? credit.name : (credit.displayName ?? ""),
    )
    .filter((name) => name.length > 0);
}

/**
 * The credits joined the way a reader sees them: "A", "A and B", "A, B and C".
 * Serial-comma-free per AP style, which is the house style for this site's copy.
 */
export function storyCreditsByline(credits: readonly StoryCredit[]): string {
  const names = storyCreditNames(credits);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
