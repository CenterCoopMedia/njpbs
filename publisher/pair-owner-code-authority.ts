import type { PublicReleasePair } from "../packages/content-core/src/public-release";
import p from "../functions/lib/public-release-pair.js";
import work from "../functions/lib/public-release-pair-work.js";
import owner from "../functions/lib/public-release-switch-code-owner.js";
import recovery from "../functions/lib/public-release-switch-code-recovery.js";
import inputs from "../functions/lib/public-release-pair-input.js";
import targets from "../functions/lib/publication-target.js";
import type { PairCodeSnapshotRead } from "./pair-owner-code-reader";

export type PairCodeSnapshot = <T>(run: (read: PairCodeSnapshotRead) => Promise<T>) => Promise<T>;
const hash = p.publicReleaseDigest, same = (a: unknown, b: unknown) => hash(a) === hash(b);
function refuse(): never { throw new p.PublicReleaseProtocolError(); }
/** All CODE authority comes from one server-created read-only transaction.
 * Its caller supplies only operation/lease identifiers, never source evidence. */
export async function pairOwnerCodeAuthority({ pair, operationId, leaseToken, capturing, now, snapshot }: {
  pair: PublicReleasePair; operationId: string; leaseToken: string | null; capturing: boolean; now: number;
  snapshot?: PairCodeSnapshot;
}) {
  if (!snapshot || capturing && typeof leaseToken !== "string") refuse();
  return snapshot(async read => {
    const doc = (path: string): any => ({ path, collection: (name: string) => ({ doc: (id: string) => doc(`${path}/${name}/${id}`) }) });
    const get = async (ref: { path: string }) => { const value = await read(ref.path); return { ref, exists: value !== null, data: () => value }; };
    const firestore = { projectId: targets.publicationTarget(pair.environment).projectId, doc } as any;
    const transaction = { get, getAll: (...refs: { path: string }[]) => Promise.all(refs.map(get)) } as any;
    const current = capturing
      ? (await owner.assertSelectedSwitchCodeCaptureLeaseInTransaction({ firestore, transaction, pair, operationId, token: leaseToken!, now })).owner
      : await owner.readSelectedSwitchCodeSourceInTransaction({ firestore, transaction, pair, operationId });
    if (!current) refuse();
    const base = work.publicReleasePairPath(pair.pairId);
    const head = await read("system/publicReleaseChanges");
    if (capturing) {
      const row = await read(owner.codePendingPath(pair, operationId));
      // H is bound to the immutable CODE event cursor. An unrelated staff
      // append may advance the live head while these same bytes are written.
      return { code: current, baselineDigest: head?.baselineDigest, lease: row!.lease as { token: string; until: number } };
    }
    const cursor = { baselineDigest: head?.baselineDigest, sequence: head?.sequence, lastDigest: head?.lastDigest };
    const binding = await read(`${base}/sourceInputs/${hash({ kind: "recovery", sourceOperationId: operationId })}`);
    if (!binding) refuse();
    if (typeof binding.inputManifestDigest !== "string") refuse();
    const scope = inputs.parsePublicReleasePairInputScope(binding.scope);
    if (binding.schemaVersion !== 2 || binding.pairDigest !== hash(pair) || !same(scope, current.scope) ||
        !same(binding.source, { kind: current.source.source.kind, id: current.source.source.id }) || !same(binding.cursor, current.source.cursor)) refuse();
    await recovery.assertSwitchCodeRecoveryInTransaction({ firestore, transaction, pair, scope, inputManifestDigest: binding.inputManifestDigest });
    const captured = await work.assertPublicReleasePairInputOwnerInTransaction({ firestore, transaction, pair, scope,
      inputManifestDigest: binding.inputManifestDigest });
    if (!captured.receipt || !same(captured.receipt.source, binding.source) || !same(captured.receipt.cursor, binding.cursor)) refuse();
    const identity = { schemaVersion: 2, pair: p.publicReleasePairReference(pair), ...scope, inputManifestDigest: binding.inputManifestDigest };
    const taskId = hash(identity), receipt = await read(`${base}/receipts/${taskId}`);
    if (!receipt || typeof receipt.claimDigest !== "string" || typeof receipt.manifestDigest !== "string") refuse();
    const completed = await work.assertPublicReleasePairCompletedReceiptInTransaction({ firestore, transaction, pair,
      taskId, claimDigest: receipt.claimDigest, manifestDigest: receipt.manifestDigest });
    const staged = await read(`${base}/views/${completed.manifestDigest}`);
    if (!same(completed.identity, identity) || staged?.schemaVersion !== 2 || staged.status !== "staged" ||
        staged.pairDigest !== hash(pair) || staged.taskId !== taskId || staged.claimDigest !== completed.claimDigest ||
        staged.manifestDigest !== completed.manifestDigest || !same(staged.identity, identity) ||
        !/^[a-f0-9]{64}$/.test(String(staged.readbackDigest))) refuse();
    return { code: current, cursor, target: { identity, claimDigest: completed.claimDigest,
      manifestDigest: completed.manifestDigest, manifestBytes: staged.manifestBytes } };
  });
}
