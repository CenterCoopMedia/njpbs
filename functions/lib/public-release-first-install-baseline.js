"use strict";
const { isDeepStrictEqual } = require("node:util");
const protocol = require("./public-release-pair");
const enrollment = require("./public-release-change-enrollment");
const baseline = require("./public-release-change-baseline");
const source = require("./public-release-source-body");
const adoption = require("./public-release-bootstrap-adoption");
const { firstInstallPublicationTarget } = require("./public-release-first-install-target");

const refuse = () => { throw new protocol.PublicReleaseProtocolError(); };

/** Before pair registration, only the original enrolled, closed initial
 * boundary may supply a build input. No registry lookup or mutable source
 * fallback, and no writes. Production adoption is a separate future gate. */
async function readPublicReleaseFirstInstallBaseline({ firestore, enrollmentRequestDigest, logBaselineDigest, environment = "development" }) {
  if (firestore.projectId !== firstInstallPublicationTarget(environment).projectId) refuse();
  if (![enrollmentRequestDigest, logBaselineDigest].every(protocol.digest)) refuse();
  return firestore.runTransaction(async transaction => {
    const original = await enrollment.assertReadPublicReleaseChangeEnrollmentInTransaction({
      firestore, transaction, requestDigest: enrollmentRequestDigest });
    if (original.receipt.baseline.logBaselineDigest !== logBaselineDigest ||
        !isDeepStrictEqual(original.head, original.receipt.initialHead)) refuse();
    const [pointer, runtime, producer] = await transaction.getAll(...[
      "system/publicDeployment", "system/cmsPublicationRuntime", "system/publicReleaseChangeLog",
    ].map(path => firestore.doc(path)));
    const expected = original.receipt.request.expected;
    if (producer.exists || protocol.publicReleaseDigest(pointer.data()) !== expected.pointerDigest ||
        protocol.publicReleaseDigest(runtime.data()) !== expected.runtimeDigest) refuse();
    await adoption.assertClosedBootstrapFenceInTransaction({ firestore, transaction, environment,
      before: pointer.data(), operationId: original.receipt.request.operationId });
    const current = await baseline.readPublicReleaseSourceCensusInTransaction({ firestore, transaction });
    if (current.sourceMemberCensusDigest !== expected.publicSourceCensusDigest) refuse();
    const opened = await baseline.assertReadPublicReleaseChangeBaselineInTransaction({ firestore, transaction, logBaselineDigest });
    const documents = new Map(), sourceBodies = new Map();
    for (const member of opened.sourceMembers) {
      const body = await source.readPublicReleaseSourceBody({ firestore, transaction, contentDigest: member.contentDigest });
      if (!body.documents.some(row => row.path === `${member.collection}/${member.id}` && row.data !== null)) refuse();
      sourceBodies.set(member.contentDigest, body);
      for (const row of body.documents) {
        if (row.data === null) documents.delete(row.path);
        else documents.set(row.path, row.data);
      }
    }
    return { ...opened, enrollment: original.receipt, logBaselineDigest, documents, sourceBodies,
      cursor: opened.receipt.baselineCursor, renderedAt: opened.receipt.createdAt };
  }, { readOnly: true });
}

module.exports = { readPublicReleaseFirstInstallBaseline };
