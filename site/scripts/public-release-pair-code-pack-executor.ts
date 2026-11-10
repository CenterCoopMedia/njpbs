import type { Firestore } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairTaskIdentity } from "../../functions/lib/public-release-pair-work";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import views from "../../functions/lib/public-release-pair-view.js";
import baselineView from "../../functions/lib/public-release-pair-code-pack-view.js";
import { openFrozenPublicReleasePairCodePack } from "./public-release-pair-code-pack-storage";
import { openPublicReleasePairInput } from "./public-release-pair-input-storage";
import { writePublicReleasePairView, openPublicReleasePairViewMetadata, type PairViewStore } from "./public-release-pair-view-storage";
import { stagePublicReleasePairView } from "./public-release-pair-view-staging";
import { PairSourceInputsError } from "./public-release-pair-source-inputs";
import { PairSearchAuthorityError } from "./public-release-pair-search-authority";
import { PairContentFeedAuthorityError } from "./public-release-pair-content-feed-authority";
import { PAIR_CODE_PACK_FILE, PairCodePackError } from "./public-release-pair-code-pack";
const same = (a: unknown, b: unknown) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
function refuse(): never { throw new work.PairExecutionError("byte-mismatch"); }
type Owner = { firestore: Firestore; store: PairViewStore; pair: PublicReleasePair; identity: PairTaskIdentity; claimDigest: string; signal?: AbortSignal };
export const publicReleasePairStagedCodePackPath = baselineView.publicReleasePairStagedCodePackPath;
function normalize(error: unknown): never {
  if (error instanceof PairCodePackError || error instanceof PairSourceInputsError || error instanceof PairSearchAuthorityError || error instanceof PairContentFeedAuthorityError) refuse();
  throw error;
}
async function openPack(options: Parameters<typeof openFrozenPublicReleasePairCodePack>[0]) {
  try { return await openFrozenPublicReleasePairCodePack(options); }
  catch (error) { return normalize(error); }
}
async function exactPack(owner: Owner) {
  const pack = await openPack(owner);
  const scope = { kind: owner.identity.kind, sourceOperationId: owner.identity.sourceOperationId, sourceVersion: owner.identity.sourceVersion,
    snapshotDigest: owner.identity.snapshotDigest, contextSequence: owner.identity.contextSequence };
  if (pack.receipt.inputManifestDigest !== owner.identity.inputManifestDigest || !same(pack.root.scope, scope) ||
      !pack.root.entryFiles.includes(PAIR_CODE_PACK_FILE) || !same(pack.root.cursor, views.parsePublicReleasePairViewCursor(pack.root.cursor, owner.identity))) refuse();
  return pack;
}
/** The dedicated baseline claim copies every sealed member, bounded to one
 * source member at a time; it never reads local dist or mutable provider data. */
export async function executePublicReleasePairCodePack(owner: Owner & {
  frozen: Awaited<ReturnType<typeof openPublicReleasePairInput>>; renew(): Promise<unknown>;
}) {
  const pack = await exactPack(owner);
  if (!same(pack.root, owner.frozen.root)) refuse();
  // Code chunks are read by readMember. Verify every other frozen dependency
  // before any output, including graph groups, original source and CODE bytes.
  for (const file of pack.root.files) if (file.name !== PAIR_CODE_PACK_FILE && !file.name.startsWith("code-pack/")) {
    await owner.frozen.readFile(file.name); await owner.renew();
  }
  async function* outputs() {
    for (const member of pack.manifest.members) {
      owner.signal?.throwIfAborted();
      const bytes = await pack.readMember(member.path).catch(normalize);
      await owner.renew();
      const headers: Record<string, string> = { "content-type": member.mime, "cache-control": "no-store", "x-njpbs-renderer-sha": owner.pair.commitSha };
      if (member.mime.startsWith("text/html")) headers["x-njpbs-html-sha256"] = member.sha256;
      yield { path: member.path, status: 200 as const, headers, bytes };
    }
  }
  return writePublicReleasePairView({ ...owner, cursor: pack.root.cursor, outputs: outputs() });
}
/** Full actual byte readback first; the immutable link never substitutes for G. */
export async function stagePublicReleasePairCodePack(owner: Owner & { viewManifestDigest: string }) {
  const pack = await exactPack(owner);
  let index = 0;
  const staged = await stagePublicReleasePairView({ ...owner, manifestDigest: owner.viewManifestDigest, verify: {
    async output(output) {
      const expected = pack.manifest.members[index++];
      if (!expected || output.path !== expected.path || output.status !== 200 || output.bodyDigest !== expected.sha256 ||
          output.bytes !== expected.size || output.headers["content-type"] !== expected.mime || output.headers["x-njpbs-renderer-sha"] !== owner.pair.commitSha) refuse();
    },
    async complete() { if (index !== pack.manifest.members.length) refuse(); },
  } });
  const record = baselineView.parsePublicReleasePairStagedCodePack({ schemaVersion: 1 as const, kind: "pair-code-pack-staged-baseline" as const, status: "staged" as const,
    pairDigest: protocol.publicReleaseDigest(owner.pair), taskId: protocol.publicReleaseDigest(owner.identity), identity: owner.identity,
    claimDigest: owner.claimDigest, viewManifestDigest: owner.viewManifestDigest, inputManifestDigest: owner.identity.inputManifestDigest,
    codePackManifestDigest: pack.receipt.codePackManifestDigest, codeAssetManifestDigest: owner.pair.codeAssetManifestDigest,
    cursor: pack.root.cursor, memberCount: index, memberBytes: staged.record.outputBytes, readbackDigest: staged.record.readbackDigest }, owner.pair);
  await owner.firestore.runTransaction(async transaction => {
    await work.assertPublicReleasePairCompletedReceiptInTransaction({ ...owner, transaction, taskId: record.taskId, manifestDigest: owner.viewManifestDigest });
    const ref = owner.firestore.doc(publicReleasePairStagedCodePackPath(owner.pair)), before = await transaction.get(ref);
    owner.signal?.throwIfAborted();
    if (before.exists) { if (!same(before.data(), record)) refuse(); }
    else transaction.create(ref, record);
  });
  return record;
}
/** Metadata/ownership open. Requested body reads remain bounded; use verifyAll
 * explicitly when a caller needs a fresh full baseline byte observation. */
export async function openStagedPublicReleasePairCodePack(options: { firestore: Firestore; store: PairViewStore; pair: PublicReleasePair; signal?: AbortSignal }) {
  const pack = await openPack(options);
  const raw = await options.firestore.runTransaction(transaction => baselineView.assertReadPublicReleasePairStagedCodePackInTransaction({ ...options, transaction }), { readOnly: true });
  if (
      raw.codePackManifestDigest !== pack.receipt.codePackManifestDigest || raw.inputManifestDigest !== pack.receipt.inputManifestDigest ||
      !same(raw.cursor, pack.root.cursor) || raw.memberCount !== pack.manifest.members.length ||
      raw.memberBytes !== pack.manifest.members.reduce((sum, member) => sum + member.size, 0)) refuse();
  const identity = views.parseViewIdentity(raw.identity, options.pair), taskId = protocol.publicReleaseDigest(identity);
  if (raw.taskId !== taskId || identity.inputManifestDigest !== pack.receipt.inputManifestDigest) refuse();
  const staged = (await options.firestore.doc(`${work.publicReleasePairPath(options.pair.pairId)}/views/${raw.viewManifestDigest}`).get()).data();
  if (staged?.status !== "staged" || staged.claimDigest !== raw.claimDigest || staged.manifestDigest !== raw.viewManifestDigest ||
      staged.readbackDigest !== raw.readbackDigest || !same(staged.identity, identity) || !same(staged.cursor, pack.root.cursor) ||
      staged.outputCount !== raw.memberCount || staged.outputBytes !== raw.memberBytes) refuse();
  const metadata = await openPublicReleasePairViewMetadata({ ...options, identity, claimDigest: raw.claimDigest,
    manifestDigest: raw.viewManifestDigest, manifestBytes: staged.manifestBytes });
  if (!same(metadata.root.cursor, pack.root.cursor) || metadata.root.outputCount !== raw.memberCount || metadata.root.outputBytes !== raw.memberBytes) refuse();
  const expected = new Map(pack.manifest.members.map(member => [member.path, member]));
  const readMember = async (path: string) => {
    const member = expected.get(path); if (!member) refuse();
    const row = await metadata.output(path);
    if (!row || row.status !== 200 || row.bodyDigest !== member.sha256 || row.bytes !== member.size || row.headers["content-type"] !== member.mime) refuse();
    return (await metadata.readBody(path)).body;
  };
  return {
    record: raw, receipt: pack.receipt, manifest: pack.manifest, root: pack.root, readMember,
    async verifyAll() { for (const member of pack.manifest.members) await readMember(member.path); },
  };
}
