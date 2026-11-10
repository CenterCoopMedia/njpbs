"use strict";
const p = require("./public-release-pair");
// Stored roots may contain validated operational metadata; wire selectors stay strict.
const parseStoredSelector = p.parseStoredPublicReleaseSelector;
/** Same authoritative transaction, actual schema-two selector and exact media
 * counters. No legacy projection, reservation, exemption or enable operation. */
async function assertPairMediaFenceInTransaction({ firestore, transaction, selector: raw }) {
  const selector = parseStoredSelector(raw);
  const [live, media] = await transaction.getAll(firestore.doc("system/publicDeployment"),
    firestore.doc("system/publicDeployment/pairMedia/current"));
  if (p.publicReleaseDigest(parseStoredSelector(live.data())) !== p.publicReleaseDigest(selector)) throw new p.PublicReleaseProtocolError();
  require("./public-release-pair-media").parsePairMedia(media.data(), selector);
  return selector;
}
module.exports = { parseStoredSelector, assertPairMediaFenceInTransaction };
