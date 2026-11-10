"use strict";

const { STORY_CREDITS_MAX, STORY_CREDIT_NAME_MAX, normalizeCustomCreditName } = require("./story-credits");
const { isAuthorId, isValidAuthorSlug } = require("./author-profile-contract");

// Published names were frozen by the writer. The working-credit normalizer
// deliberately discards them, so validate and select their public fields here.
function selectPublishedStoryCredits(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > STORY_CREDITS_MAX) throw new Error("Invalid published story credits");
  const seen = new Set();
  return value.map(credit => {
    if (!credit || typeof credit !== "object" || Array.isArray(credit)) throw new Error("Invalid published story credits");
    const name = credit.kind === "custom" ? credit.name : credit.displayName;
    if (typeof name !== "string" || !name || name.length > STORY_CREDIT_NAME_MAX || normalizeCustomCreditName(name) !== name) {
      throw new Error("Invalid published story credits");
    }
    if (credit.kind === "custom") return { kind: "custom", name: credit.name };
    if (credit.kind !== "registered") throw new Error("Invalid published story credits");
    if (!isAuthorId(credit.authorId) || credit.authorId.length !== 35 || seen.has(credit.authorId) ||
        (credit.slug !== undefined && (!isValidAuthorSlug(credit.slug) || credit.slug.trim() !== credit.slug))) {
      throw new Error("Invalid published story credits");
    }
    seen.add(credit.authorId);
    return { kind: "registered", authorId: credit.authorId, displayName: credit.displayName,
      ...(credit.slug === undefined ? {} : { slug: credit.slug }) };
  });
}

module.exports = { selectPublishedStoryCredits };
