"use strict";

// CommonJS mirror of packages/content-core/src/story-credits.ts (issue #1040).
// Firebase deploys functions/ alone and cannot import the TypeScript core, so the
// write boundary that actually stores and publishes a byline runs this copy.
// site/tests/story-credits-parity.test.ts runs both implementations over the same
// cases so they cannot fork: a mirror that drifted would let the server store a
// credit shape the model refuses, or freeze a published byline differently from
// what every reader-facing surface expects.
//
// The one thing added here and absent from the pure core is
// `registeredCreditsError`, the server-only check that every registered credit
// names an author identity that exists and is active AT WRITE TIME. It lives on
// this side because it is a statement about stored identities, not about the
// shape of a byline.

const { isAuthorId } = require("./author-profile-contract");

const STORY_CREDIT_KINDS = Object.freeze(["registered", "custom"]);
const STORY_CREDITS_MAX = 12;
const STORY_CREDIT_NAME_MAX = 120;

// Matching control characters is the point of this expression: a byline is a name
// on a page, so a newline, a C1 control, or a bidirectional override in one is
// something to strip, not something to preserve.
const CONTROL_CHARACTERS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

function sanitizeCreditText(value) {
  return value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
}

function normalizeCustomCreditName(value) {
  if (typeof value !== "string") return "";
  return sanitizeCreditText(value).slice(0, STORY_CREDIT_NAME_MAX);
}

function normalizeOne(raw, index, errors) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    errors.push(`Credit ${index + 1} is not a credit`);
    return null;
  }
  if (raw.kind === "registered") {
    if (!isAuthorId(raw.authorId)) {
      errors.push(`Credit ${index + 1} names an author we do not recognize`);
      return null;
    }
    return { kind: "registered", authorId: raw.authorId };
  }
  if (raw.kind === "custom") {
    const name = normalizeCustomCreditName(raw.name);
    if (name.length === 0) return null;
    return { kind: "custom", name };
  }
  errors.push(`Credit ${index + 1} is not a registered or custom byline`);
  return null;
}

function normalizeStoryCredits(value) {
  if (value === undefined || value === null) {
    return { ok: true, credits: [], errors: [] };
  }
  if (!Array.isArray(value)) {
    return { ok: false, credits: [], errors: ["Bylines must be a list"] };
  }
  const errors = [];
  if (value.length > STORY_CREDITS_MAX) {
    return {
      ok: false,
      credits: [],
      errors: [`A story can carry at most ${STORY_CREDITS_MAX} bylines`],
    };
  }
  const credits = [];
  const seenAuthorIds = new Set();
  value.forEach((raw, index) => {
    const credit = normalizeOne(raw, index, errors);
    if (!credit) return;
    if (credit.kind === "registered") {
      if (seenAuthorIds.has(credit.authorId)) return;
      seenAuthorIds.add(credit.authorId);
    }
    credits.push(credit);
  });
  return {
    ok: errors.length === 0,
    credits: errors.length === 0 ? credits : [],
    errors,
  };
}

function creditsFromLegacyAuthor(author) {
  const name = normalizeCustomCreditName(author);
  return name.length === 0 ? [] : [{ kind: "custom", name }];
}

function resolveStoryCredits(record) {
  if (!record) return [];
  if (Array.isArray(record.credits)) {
    return normalizeStoryCredits(record.credits).credits;
  }
  return creditsFromLegacyAuthor(record.author);
}

function defaultStoryCredits(identity) {
  if (!identity || !identity.active || !isAuthorId(identity.authorId)) return [];
  return [{ kind: "registered", authorId: identity.authorId }];
}

function storyCreditKey(credit) {
  return credit.kind === "registered"
    ? `registered:${credit.authorId}`
    : `custom:${credit.name}`;
}

function moveStoryCredit(credits, index, offset) {
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

function freezeStoryCredits(credits, resolve) {
  const frozen = [];
  for (const credit of credits) {
    if (credit.kind === "custom") {
      frozen.push({ kind: "custom", name: credit.name });
      continue;
    }
    const identity = resolve(credit.authorId);
    const displayName = normalizeCustomCreditName(
      (identity && identity.displayName) || credit.displayName || "",
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

function storyCreditNames(credits) {
  return credits
    .map((credit) =>
      credit.kind === "custom" ? credit.name : credit.displayName || "",
    )
    .filter((name) => name.length > 0);
}

function storyCreditsByline(credits) {
  const names = storyCreditNames(credits);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The author ids a credit list references, in order and deduplicated. What the
 * save boundary reads from Firestore before deciding whether the byline may be
 * stored.
 */
function registeredAuthorIds(credits) {
  const ids = [];
  for (const credit of credits) {
    if (credit.kind === "registered" && !ids.includes(credit.authorId)) {
      ids.push(credit.authorId);
    }
  }
  return ids;
}

/**
 * Server-only: reject a byline that credits an author identity which does not
 * exist or is deactivated.
 *
 * `identities` is a Map from authorId to the identity the server read, or to
 * null/undefined when the lookup found nothing. `alreadyCredited` is the set of
 * ids the STORED document already carried, and they are exempt: a story that has
 * always credited someone must stay editable after that person leaves the
 * station. Deactivation withdraws a public profile; it does not rewrite history
 * or freeze the record. Only NEWLY adding a deactivated or unknown author is
 * refused.
 */
function registeredCreditsError(credits, identities, alreadyCredited = new Set()) {
  for (const authorId of registeredAuthorIds(credits)) {
    if (alreadyCredited.has(authorId)) continue;
    const identity = identities.get(authorId);
    if (!identity) return "A byline names an author we do not recognize";
    if (identity.active !== true) {
      return "A byline names an author whose account is no longer active";
    }
  }
  return null;
}

module.exports = {
  STORY_CREDITS_MAX,
  STORY_CREDIT_KINDS,
  STORY_CREDIT_NAME_MAX,
  creditsFromLegacyAuthor,
  defaultStoryCredits,
  freezeStoryCredits,
  moveStoryCredit,
  normalizeCustomCreditName,
  normalizeStoryCredits,
  registeredAuthorIds,
  registeredCreditsError,
  resolveStoryCredits,
  storyCreditKey,
  storyCreditNames,
  storyCreditsByline,
};
