"use strict";

const { MediaLibraryValidationError } = require("./media-library");

// Shared with the ordinary list scan, which can retain all summaries in one call.
const MAX_ACTIVE_MEDIA_SCAN = 5000;
const MAX_MEDIA_CORPUS_BATCH = 500;
const INDEX_REQUIRED_MESSAGE =
  "The media library needs indexed media search before it can list more assets.";

function parseMediaCorpusRequest(body, uid) {
  if (!body || typeof body !== "object" || Array.isArray(body) || body.corpus !== true ||
      Object.keys(body).some(key => !["corpus", "cursor", "limit"].includes(key))) {
    throw new MediaLibraryValidationError("Corpus requests accept only corpus, cursor and limit");
  }
  const limit = body.limit === undefined ? MAX_MEDIA_CORPUS_BATCH : body.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MEDIA_CORPUS_BATCH) {
    throw new MediaLibraryValidationError("Corpus limit must be a whole number from 1 through 500");
  }
  if (body.cursor === undefined) return { limit, after: null };
  try {
    if (typeof body.cursor !== "string" || body.cursor.length > 12288 ||
        !/^[A-Za-z0-9_-]+$/.test(body.cursor)) throw new Error();
    const bytes = Buffer.from(body.cursor, "base64url");
    if (bytes.toString("base64url") !== body.cursor) throw new Error();
    const cursor = JSON.parse(bytes.toString("utf8"));
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor) ||
        Object.keys(cursor).some(key => !["v", "uid", "after"].includes(key)) ||
        cursor.v !== 1 || cursor.uid !== uid || typeof cursor.after !== "string" ||
        !cursor.after || Buffer.byteLength(cursor.after, "utf8") > 1500 ||
        cursor.after.includes("/") || [".", ".."].includes(cursor.after)) throw new Error();
    return { limit, after: cursor.after };
  } catch {
    throw new MediaLibraryValidationError("Media corpus cursor is invalid");
  }
}

// A cursor is only a location hint. Every batch still checks current permissions.
function encodeMediaCorpusCursor(uid, after) {
  return Buffer.from(JSON.stringify({ v: 1, uid, after }), "utf8").toString("base64url");
}

module.exports = {
  INDEX_REQUIRED_MESSAGE,
  MAX_ACTIVE_MEDIA_SCAN,
  MAX_MEDIA_CORPUS_BATCH,
  encodeMediaCorpusCursor,
  parseMediaCorpusRequest,
};
