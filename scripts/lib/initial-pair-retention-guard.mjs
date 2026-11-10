import { initialPairNative } from './initial-pair-native.mjs';
import protocol from '../../functions/lib/public-release-pair.js';
import baseline from '../../functions/lib/public-release-change-baseline.js';
import enrollment from '../../functions/lib/public-release-change-enrollment.js';
import replay from '../../functions/lib/public-release-pair-replay.js';
import retention from '../../functions/lib/public-release-bootstrap-pairs.js';
const native = filename => initialPairNative(filename, import.meta.url);
const bytes = native('../../site/scripts/public-release-pair-log-replay.ts');
const census = native('../../site/scripts/public-release-pair-source-census.ts');
const { readPairQualificationAuthority } = native('../../site/scripts/public-release-pair-qualification-authority.ts');
const { trackQualificationTransactionReads, assertQualificationTransactionReadBudget, QUALIFICATION_TRANSACTION_READ_LIMIT } =
  native('../../site/scripts/public-release-pair-qualification-source.ts');
const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
const refuse = () => { throw new Error('Initial pair retention proof refused'); };

/** Full native H/G readback, with no replay baseline or qualification record.
 * This opaque guard never accepts serialized success flags or caller hashes. */
export async function prepareInitialPairRetentionGuard({ firestore, attempt: raw, store, signal }) {
  const attempt = retention.parseInitialPairRetentionAttempt(raw), pairs = [attempt.currentPair, attempt.recoveryPair];
  const original = await firestore.runTransaction(transaction => enrollment.assertReadPublicReleaseChangeEnrollmentInTransaction({
    firestore, transaction, requestDigest: attempt.enrollmentRequestDigest }), { readOnly: true });
  const global = await firestore.runTransaction(transaction => baseline.assertReadPublicReleaseChangeBaselineInTransaction({
    firestore, transaction, logBaselineDigest: original.receipt.baseline.logBaselineDigest }), { readOnly: true });
  const cursor = global.receipt.baselineCursor, prepared = [];
  for (const [index, pair] of pairs.entries()) {
    signal?.throwIfAborted();
    const views = attempt.views[index], options = { firestore, store, pair, cursor, signal };
    const code = await bytes.verifyPublicReleasePairReplayCodePack({ ...options, reference: views.codePackView });
    const content = await bytes.verifyPublicReleasePairReplayView({ ...options, reference: views.contentView,
      sourceBodyDigests: new Set(global.sourceMembers.map(member => member.contentDigest)) });
    const expected = JSON.parse(new TextDecoder().decode(content.files.get(census.PAIR_SOURCE_METADATA_FILE)));
    const source = await census.preparePublicReleasePairSourceCensus({ firestore, expected, cursor, signal });
    const authority = await firestore.runTransaction(transaction => readPairQualificationAuthority({ firestore, transaction, pair }), { readOnly: true });
    prepared.push({ code: code.proof, content: content.proof, source, authority, summary: {
      pairDigest: protocol.publicReleaseDigest(pair), views, cursor, codeProofDigest: protocol.publicReleaseDigest(code.proof),
      contentProofDigest: protocol.publicReleaseDigest(content.proof), sourceCensusDigest: source.metadata.digest } });
  }
  return { begin(originalTransaction) {
    const tracker = trackQualificationTransactionReads(originalTransaction), transaction = tracker.transaction;
    return { transaction, async verify() {
      for (const [index, pair] of pairs.entries()) {
        signal?.throwIfAborted(); const before = prepared[index], views = attempt.views[index];
        for (const [reference, expected] of [[views.codePackView, before.code], [views.contentView, before.content]]) {
          const actual = await replay.assertStagedReplayViewInTransaction({ firestore, transaction, pair, reference, cursor });
          if (!same(actual, expected)) refuse();
        }
        const current = await readPairQualificationAuthority({ firestore, transaction, pair });
        if (current.digest !== before.authority.digest) refuse();
        const remaining = QUALIFICATION_TRANSACTION_READ_LIMIT - assertQualificationTransactionReadBudget(tracker);
        if (before.source.readCount <= remaining) await census.assertPublicReleasePairSourceCensusInTransaction({ firestore, transaction,
          expected: before.source.metadata, cursor, maxDocuments: remaining });
        else {
          // Same native split contract as qualification: the fresh complete
          // outside census plus current owned routes/head and author roster.
          const rows = await transaction.get(firestore.collection('cmsAuthorProfilesPublic').limit(remaining + 1));
          assertQualificationTransactionReadBudget(tracker);
          const actual = rows.empty ? [] : census.projectPublicReleasePairSourceCensusDocuments(new Map(rows.docs.map(row => [row.ref.path, row.data()]))).members;
          if (!same(actual, before.source.metadata.members.filter(member => member.path.startsWith('cmsAuthorProfilesPublic/')))) refuse();
        }
      }
      return prepared.map(value => value.summary);
    }, finish() { signal?.throwIfAborted(); assertQualificationTransactionReadBudget(tracker); } };
  } };
}
