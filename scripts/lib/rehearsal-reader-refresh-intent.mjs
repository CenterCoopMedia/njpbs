import protocol from '../../functions/lib/public-release-pair.js';
import preview from '../../functions/lib/cms-preview-pair.js';
import sessions from '../../functions/lib/cms-reader-session.js';
import { parseRehearsalPacket, rehearsalSourceCommit } from './public-release-rehearsal.mjs';
import { assertDemoRehearsalEnvironment, assertDevelopmentRehearsalEnvironment } from './development-rehearsal-credentials.mjs';
import { assertNativeRehearsalDatabase } from './rehearsal-sdk-identity.mjs';
import { parseCmsReaderBridgeRequest } from './cms-reader-bridge-install.mjs';

const refuse = () => { throw new Error('Original rehearsal reader request refused'); };
const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
const identities = readers => Object.fromEntries(['functions', 'cmsApi'].map(component => {
  const reader = preview.parseReader(readers?.[component]);
  if (reader.component !== component) refuse(); return [component, sessions.readerSessionDigest(reader)];
}));

/** Source intent only; never a bridge proof or readiness receipt. Preserve the
 * exact request before native installation legitimately refreshes verifiedAt.
 * Recovery reuses that original request, not a newly derived timestamp/digest.
 */
export async function originalRehearsalReaderRequest({ firestore, packet: raw, sourceSha, configurationDigest,
  observed, request: supplied, authorized = false }) {
  if (authorized !== true) refuse();
  const packet = parseRehearsalPacket(raw);
  if (packet.schemaVersion === 1) assertDemoRehearsalEnvironment(packet); else assertDevelopmentRehearsalEnvironment();
  assertNativeRehearsalDatabase(firestore, packet.projectId);
  if (rehearsalSourceCommit() !== sourceSha || !protocol.digest(configurationDigest) ||
      !protocol.digest(observed?.baselineDigest) || !Number.isSafeInteger(observed?.baselineVersion?.seconds) ||
      observed.baselineVersion.seconds < 0 || !Number.isInteger(observed?.baselineVersion?.nanoseconds) ||
      observed.baselineVersion.nanoseconds < 0 || observed.baselineVersion.nanoseconds >= 1_000_000_000) refuse();
  const state = protocol.freeze(structuredClone(observed.state)), readerIdentities = identities(observed.readers);
  const operationId = `reader-rnp-${protocol.publicReleaseDigest({ runId: packet.runId, state }).slice(0, 32)}`;
  const binding = { schemaVersion: 1, sourceSha, packetDigest: protocol.publicReleaseDigest(packet), configurationDigest,
    baselineDigest: observed.baselineDigest, baselineVersion: observed.baselineVersion, state, readerIdentities };
  const validate = raw => {
    const request = parseCmsReaderBridgeRequest(raw);
    if (request.operationId !== operationId || request.expectedStateDigest !== preview.digest(state) ||
        !same(identities(request.readers), readerIdentities)) refuse();
    return request;
  };
  const proposed = supplied === undefined ? undefined : validate(supplied);
  const root = firestore.doc(`publicReleaseRehearsalRuns/${packet.runId}`), ref = firestore.doc(`${root.path}/readerRefresh/original`);
  return firestore.runTransaction(async transaction => {
    const [run, row] = await transaction.getAll(root, ref);
    if (!run.exists || !run.createTime.isEqual(run.updateTime) || run.data().sourceSha !== sourceSha ||
        run.data().packetDigest !== binding.packetDigest) refuse();
    if (row.exists) {
      const value = row.data(); protocol.exact(value, [...Object.keys(binding), 'request', 'requestDigest']);
      if (!row.createTime.isEqual(row.updateTime) ||
          !same(Object.fromEntries(Object.keys(binding).map(key => [key, value[key]])), binding) ||
          value.requestDigest !== protocol.publicReleaseDigest(validate(value.request)) ||
          proposed && !same(proposed, value.request)) refuse();
      return protocol.freeze({ state: value.state, request: value.request });
    }
    if (!proposed) return null;
    const value = { ...binding, request: proposed, requestDigest: protocol.publicReleaseDigest(proposed) };
    if (Buffer.byteLength(JSON.stringify(value)) > 750_000) refuse();
    transaction.create(ref, value); return protocol.freeze({ state, request: proposed });
  });
}
