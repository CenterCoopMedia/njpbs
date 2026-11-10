"use strict";
const p = require("./public-release-pair");
const work = require("./public-release-pair-work");
const outbox = require("./public-release-routing-mirror-outbox");
const mirrors = require("./public-release-routing-mirrors");
const { assertPublicationDatabase, publicationTarget } = require("./publication-target");
/** No timer, scheduler, credential lookup or SDK read is armed by import.
 * The private host calls tick every30s only after the adoption gate installs
 * this reviewed collector. Default-off is independent of the public router. */
function createPublicReleaseRoutingMirrorRunner({ enabled = false, firestore, environment, getStore, now = Date.now }) {
  return { async tick({ signal } = {}) {
    if (enabled !== true) return { state: "disabled" };
    assertPublicationDatabase(firestore, publicationTarget(environment));
    if (typeof getStore !== "function") throw new p.PublicReleaseProtocolError();
    signal?.throwIfAborted(); const store = await getStore();
    const jobs = await outbox.drainDuePublicReleaseRoutingMirrorOutbox({ firestore, environment, store,
      now, signal, sync: mirrors.syncPublicReleaseRoutingMirrors });
    // Heartbeat only renews identical current mirrored source. A withdrawal
    // can have acknowledged its tombstones while positive bodies still lag;
    // reconciliation below keeps that work live after the outbox is done.
    const selector = p.parseStoredPublicReleaseSelector((await firestore.doc("system/publicDeployment").get()).data());
    const refs = [selector.selectedPair, selector.recoveryPair];
    const rows = await firestore.getAll(...refs.map(ref => firestore.doc(work.publicReleasePairPath(ref.pairId))));
    const pairs = rows.map((row, index) => {
      const pair = p.parsePublicReleasePair(row.data());
      if (pair.environment !== environment || p.publicReleaseDigest(p.publicReleasePairReference(pair)) !== p.publicReleaseDigest(refs[index])) throw new p.PublicReleaseProtocolError();
      return pair;
    });
    const leases = await mirrors.renewPublicReleaseRoutingMirrorLeases({ firestore, store, pairs, now, signal });
    const reconciliation = leases.state === "pending" ? await mirrors.syncPublicReleaseRoutingMirrors({ firestore, store, pairs,
      operationId: "routing-mirror-reconcile", minimumSequence: 0, dryRun: false, now, signal }) : null;
    return { state: "polled", jobs, leases, reconciliation };
  } };
}
module.exports = { createPublicReleaseRoutingMirrorRunner };
