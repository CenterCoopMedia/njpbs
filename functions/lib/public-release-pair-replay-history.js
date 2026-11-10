"use strict";
const protocol = require("./public-release-pair");
const work = require("./public-release-pair-work");
const { exact, digest, publicReleaseDigest: hash, freeze } = protocol;
const REPLAY_HISTORY_PAGE_SIZE = 128;
class ReplayHistoryError extends Error {
  constructor() {
    super("replay-history-invalid");
    this.name = "ReplayHistoryError";
    this.code = "replay-history-invalid";
  }
}
function refuse() {
  throw new ReplayHistoryError();
}
function same(a, b) {
  return hash(a) === hash(b);
}
function parseReplayHistoryCursor(value) {
  exact(value, ["baselineDigest", "sequence", "lastDigest"]);
  if (
    !digest(value.baselineDigest) ||
    !digest(value.lastDigest) ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 0 ||
    (value.sequence === 0 && value.lastDigest !== value.baselineDigest)
  )
    refuse();
  return Object.freeze({ ...value });
}
function emptyRoot(pair, fromCursor) {
  return hash({ schemaVersion: 2, kind: "pair-replay-history-empty", pairDigest: hash(pair), fromCursor });
}
function emptyReplayHistory(pair, rawCursor) {
  const fromCursor = parseReplayHistoryCursor(rawCursor);
  return freeze({ fromCursor, headCursor: fromCursor, pageCount: 0, logPagesRootDigest: emptyRoot(pair, fromCursor) });
}
function parseReplayHistoryDescriptor(value, pair) {
  exact(value, ["fromCursor", "headCursor", "pageCount", "logPagesRootDigest"]);
  const fromCursor = parseReplayHistoryCursor(value.fromCursor),
    headCursor = parseReplayHistoryCursor(value.headCursor);
  if (
    !Number.isSafeInteger(value.pageCount) ||
    value.pageCount < 0 ||
    !digest(value.logPagesRootDigest) ||
    fromCursor.baselineDigest !== headCursor.baselineDigest ||
    fromCursor.sequence > headCursor.sequence ||
    value.pageCount > headCursor.sequence - fromCursor.sequence ||
    (value.pageCount === 0) !== same(fromCursor, headCursor) ||
    (value.pageCount === 0 && value.logPagesRootDigest !== emptyRoot(pair, fromCursor))
  )
    refuse();
  return freeze({ fromCursor, headCursor, pageCount: value.pageCount, logPagesRootDigest: value.logPagesRootDigest });
}
function historyPage(value, pair, fromCursor, count) {
  exact(value, ["schemaVersion", "kind", "pairDigest", "fromCursor", "startIndex", "prevPageDigest", "logPageDigests"]);
  if (
    value.schemaVersion !== 2 ||
    value.kind !== "pair-replay-history" ||
    value.pairDigest !== hash(pair) ||
    !same(value.fromCursor, fromCursor) ||
    !Number.isSafeInteger(value.startIndex) ||
    value.startIndex < 0 ||
    value.startIndex % REPLAY_HISTORY_PAGE_SIZE !== 0 ||
    !Array.isArray(value.logPageDigests) ||
    !value.logPageDigests.length ||
    value.logPageDigests.length > REPLAY_HISTORY_PAGE_SIZE ||
    value.startIndex + value.logPageDigests.length !== count ||
    !value.logPageDigests.every(digest) ||
    new Set(value.logPageDigests).size !== value.logPageDigests.length ||
    (value.startIndex === 0 ? value.prevPageDigest !== null : !digest(value.prevPageDigest))
  )
    refuse();
  return value;
}
function path(pair, pageDigest) {
  return `${work.publicReleasePairPath(pair.pairId)}/replayHistory/${pageDigest}`;
}
async function readPage({ firestore, transaction, pair, fromCursor, count, pageDigest }) {
  const row = await transaction.get(firestore.doc(path(pair, pageDigest)));
  if (!row.exists || hash(row.data()) !== pageDigest) refuse();
  return historyPage(row.data(), pair, fromCursor, count);
}
async function readReplayHistoryTailInTransaction({ firestore, transaction, pair, history: raw }) {
  const history = parseReplayHistoryDescriptor(raw, pair);
  return history.pageCount
    ? readPage({
        firestore,
        transaction,
        pair,
        fromCursor: history.fromCursor,
        count: history.pageCount,
        pageDigest: history.logPagesRootDigest,
      })
    : null;
}
/** Expand the entire immutable chain. An orphan, missing predecessor, repeated
 * log page, wrong order or truncated prefix never stands in for full history. */
async function readReplayHistoryInTransaction({ firestore, transaction, pair, history: raw }) {
  const history = parseReplayHistoryDescriptor(raw, pair),
    pages = [],
    seen = new Set();
  let count = history.pageCount,
    pageDigest = history.logPagesRootDigest;
  while (count) {
    const page = await readPage({ firestore, transaction, pair, fromCursor: history.fromCursor, count, pageDigest });
    for (const digest of page.logPageDigests) {
      if (seen.has(digest)) refuse();
      seen.add(digest);
    }
    pages.push(page.logPageDigests);
    count = page.startIndex;
    pageDigest = page.prevPageDigest;
  }
  return pages.reverse().flat();
}
/** Copy on write only the bounded tail index page. Its predecessor chain is
 * unchanged, and the new index root and replay cursor commit in one transaction. */
async function appendReplayHistoryInTransaction({
  firestore,
  transaction,
  pair,
  history: raw,
  pageDigest,
  headCursor: rawCursor,
}) {
  const history = parseReplayHistoryDescriptor(raw, pair),
    headCursor = parseReplayHistoryCursor(rawCursor);
  if (
    !digest(pageDigest) ||
    headCursor.baselineDigest !== history.headCursor.baselineDigest ||
    headCursor.sequence <= history.headCursor.sequence ||
    !Number.isSafeInteger(history.pageCount + 1)
  )
    refuse();
  let tail = { startIndex: 0, prevPageDigest: null, logPageDigests: [] };
  if (history.pageCount) {
    tail = await readPage({
      firestore,
      transaction,
      pair,
      fromCursor: history.fromCursor,
      count: history.pageCount,
      pageDigest: history.logPagesRootDigest,
    });
    if (tail.logPageDigests.length === REPLAY_HISTORY_PAGE_SIZE)
      tail = {
        startIndex: history.pageCount,
        prevPageDigest: history.logPagesRootDigest,
        logPageDigests: [],
      };
  }
  const value = {
    schemaVersion: 2,
    kind: "pair-replay-history",
    pairDigest: hash(pair),
    fromCursor: history.fromCursor,
    startIndex: tail.startIndex,
    prevPageDigest: tail.prevPageDigest,
    logPageDigests: [...tail.logPageDigests, pageDigest],
  };
  historyPage(value, pair, history.fromCursor, history.pageCount + 1);
  const root = hash(value),
    ref = firestore.doc(path(pair, root)),
    row = await transaction.get(ref);
  if (row.exists && !same(row.data(), value)) refuse();
  return {
    history: parseReplayHistoryDescriptor(
      { ...history, headCursor, pageCount: history.pageCount + 1, logPagesRootDigest: root },
      pair,
    ),
    write: () => {
      if (!row.exists) transaction.create(ref, value);
    },
  };
}
module.exports = {
  REPLAY_HISTORY_PAGE_SIZE,
  ReplayHistoryError,
  parseReplayHistoryCursor,
  emptyReplayHistory,
  parseReplayHistoryDescriptor,
  readReplayHistoryTailInTransaction,
  readReplayHistoryInTransaction,
  appendReplayHistoryInTransaction,
};
