"use strict";

const { createHash, randomBytes } = require("node:crypto");
const { Timestamp } = require("firebase-admin/firestore");

const CURSOR_COLLECTION = "mediaDiscoveryCursors";
const CURSOR_LIFETIME_MS = 30 * 60 * 1000;

class MediaDiscoveryError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function discoveryDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function readCursor(firestore, token, binding) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(token)) {
    throw new MediaDiscoveryError(400, "Invalid media continuation.");
  }
  const ref = firestore.collection(CURSOR_COLLECTION).doc(discoveryDigest(token));
  const document = await ref.get();
  const data = document.data();
  if (!data || data.expireAt.toMillis() <= Date.now()) {
    throw new MediaDiscoveryError(410, "Media continuation expired. Return to the first page.");
  }
  if (data.binding !== binding) {
    throw new MediaDiscoveryError(409, "The media library or access changed. Return to the first page.");
  }
  return data;
}

async function writeCursor(firestore, binding, after, matched = 0) {
  const token = randomBytes(24).toString("base64url");
  await firestore.collection(CURSOR_COLLECTION).doc(discoveryDigest(token)).create({
    binding, after, matched, expireAt: Timestamp.fromMillis(Date.now() + CURSOR_LIFETIME_MS),
  });
  return token;
}

module.exports = {
  CURSOR_COLLECTION, CURSOR_LIFETIME_MS, MediaDiscoveryError, discoveryDigest, readCursor, writeCursor,
};
