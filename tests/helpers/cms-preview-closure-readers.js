import { createRequire } from "node:module";
import { bridgeFixture } from "./cms-reader-bridge.js";
const require = createRequire(import.meta.url), pairs = require("../../functions/lib/cms-preview-pair.js");
const sessions = require("../../functions/lib/cms-reader-session.js"), proofs = require("../../functions/lib/cms-reader-bridge-proof.js");

// Installed proof fixture uses the real proof parser and the real deployed
// session implementation. No source-only contract list mints the window stamp.
export async function recordInstalledClosureReaders(db, now, overrides) {
  const fixture = bridgeFixture(now), readers = overrides ?? fixture.request.readers;
  const proof = { schemaVersion: 2, operationId: "reader-install", requestDigest: pairs.digest({ ...fixture.request, readers }),
    stateDigest: pairs.digest(fixture.state), readers,
    readerIdentities: Object.fromEntries(Object.entries(readers).map(([key, value]) => [key, sessions.readerSessionDigest(value)])),
    results: ["functions", "cmsApi"].flatMap(component => fixture.request.cases.map(row => ({ component,
      scope: row.scope, version: row.version, feature: row.feature, pairDigest: row.pairDigest, ...row.expected }))),
    verifiedAt: new Date(now).toISOString() };
  const value = { schemaVersion: 2, proof, readerDigests: Object.fromEntries(Object.entries(readers).map(([key, reader]) => [key, pairs.digest(reader)])) };
  proofs.parseInstalledCmsReaderProof(value, proof.operationId);
  await db.doc(`cmsReaderBridgeInstalledProofs/${proofs.cmsReaderBridgeProofKey(readers)}`).set(value);
  await db.doc(`cmsReaderBridgeInstalledProofs/${proof.operationId}`).set(value);
  return readers;
}
export async function installClosureReaders(db, now, overrides) {
  const readers = await recordInstalledClosureReaders(db, now, overrides);
  for (const [component, reader] of Object.entries(readers)) {
    await db.doc(`${pairs.READER_RECEIPTS}/${component}`).set({ schemaVersion: 2, component, state: "complete", lastComplete: reader });
    await sessions.openSession(db, { reader, principalId: "installed-reader-preflight", ttlMs: 1 }, now - 2);
  }
  return readers;
}
