"use strict";

const { randomUUID } = require("node:crypto");
const { assertStaffAuthority } = require("./live-production-authority");
const { sessionRef, getSession, assertEditable, checkVersion, boundedWrite, audit } = require("./live-production-store");
const { fail, fingerprint } = require("./live-production-requests");
const { sourceRef, snapshotRef } = require("./rundown-source-store");
const { PARSER_VERSION, extractMarkedBanners } = require("./rundown-marker-parser");

const proposalRef = ref => ref.collection("rundownProposals").doc("current");
async function parseRundown(db, request, actor, now) {
  const ref = sessionRef(db, request.sessionId);
  return db.runTransaction(async transaction => {
    await assertStaffAuthority(db, transaction, actor);
    const session = await getSession(transaction, ref);
    assertEditable(session);
    const source = (await transaction.get(sourceRef(ref))).data();
    const snapshot = (await transaction.get(snapshotRef(ref))).data();
    const previous = (await transaction.get(proposalRef(ref))).data();
    if (!source?.config?.enabled || !snapshot || snapshot.expiresAtMs <= now) fail("Refresh the source before extracting proposals.", 409);
    checkVersion(source.generation, request.sourceGeneration);
    if (snapshot.generation !== source.generation || snapshot.configVersion !== source.configVersion) fail("The source configuration changed. Refresh again.", 409);
    const cacheKey = fingerprint([snapshot.hash, snapshot.configVersion, PARSER_VERSION]);
    if (previous?.cacheKey === cacheKey && previous.sourceGeneration === snapshot.generation) {
      const parsed = { ...previous, expiresAtMs: snapshot.expiresAtMs, purgeAt: snapshot.purgeAt };
      boundedWrite(transaction, "set", proposalRef(ref), parsed);
      return { parsed, cached: true };
    }
    const parsed = { ...extractMarkedBanners(snapshot), cacheKey, configVersion: snapshot.configVersion, parsedAtMs: now,
      documentId: snapshot.documentId, expiresAtMs: snapshot.expiresAtMs, purgeAt: snapshot.purgeAt };
    // The same 512 KiB budget covers raw source and the proposal view. No truncation.
    if (Buffer.byteLength(JSON.stringify(parsed)) > 512 * 1024) fail("Proposals exceed the review byte budget.", 413);
    boundedWrite(transaction, "set", proposalRef(ref), parsed);
    audit(transaction, ref, `rundown_parse_${randomUUID()}`, actor.uid, "rundown_parse", now,
      { sourceGeneration: source.generation, sourceHash: snapshot.hash, parserVersion: PARSER_VERSION, count: parsed.proposals.length });
    return { parsed, cached: false };
  });
}
module.exports = { proposalRef, parseRundown };
