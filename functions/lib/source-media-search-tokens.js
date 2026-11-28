"use strict";

// Word search for shared videos. Each video asset stores `searchTokens`: the lowercase NFKC
// words of its name, tags and description, in that order, without repeats. A search reads one
// word through `array-contains` and checks the other words in memory.

const MAX_SEARCH_TOKENS = 100;
const MAX_SEARCH_TOKEN_LENGTH = 40;
const WORD_PATTERN = /[\p{L}\p{M}\p{N}]+/gu;

function boundedWord(word) {
  const characters = Array.from(word);
  return characters.length > MAX_SEARCH_TOKEN_LENGTH
    ? characters.slice(0, MAX_SEARCH_TOKEN_LENGTH).join("")
    : word;
}

/** The normalized words of one text, bounded in length. Other values give no words. */
function searchWords(text) {
  if (typeof text !== "string") return [];
  const normalized = text.toWellFormed().normalize("NFKC").toLocaleLowerCase("en-US");
  return (normalized.match(WORD_PATTERN) ?? []).map(boundedWord);
}

/** The stored token list for a video asset. Name words come first so they always fit. */
function sourceMediaSearchTokens({ name, description, tags } = {}) {
  const tokens = new Set();
  for (const text of [name, ...(Array.isArray(tags) ? tags : []), description]) {
    for (const word of searchWords(text)) {
      tokens.add(word);
      if (tokens.size >= MAX_SEARCH_TOKENS) return [...tokens];
    }
  }
  return [...tokens];
}

/**
 * The query plan for search text: the longest word goes to Firestore and the rest match in
 * memory as the start of a stored word. Returns null when the text has no words.
 */
function sourceMediaSearchPlan(q) {
  const words = [...new Set(searchWords(q))];
  if (words.length === 0) return null;
  const indexed = words.reduce((longest, word) =>
    (Array.from(word).length > Array.from(longest).length ? word : longest));
  return { indexed, rest: words.filter((word) => word !== indexed), words };
}

function matchesSourceMediaSearch(tokens, plan) {
  if (!Array.isArray(tokens) || !tokens.includes(plan.indexed)) return false;
  return plan.rest.every((word) =>
    tokens.some((token) => typeof token === "string" && token.startsWith(word)));
}

module.exports = {
  MAX_SEARCH_TOKENS,
  MAX_SEARCH_TOKEN_LENGTH,
  matchesSourceMediaSearch,
  searchWords,
  sourceMediaSearchPlan,
  sourceMediaSearchTokens,
};
