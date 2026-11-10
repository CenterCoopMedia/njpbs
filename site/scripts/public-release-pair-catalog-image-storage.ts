import type { Firestore } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairTaskIdentity } from "../../functions/lib/public-release-pair-work";
import type { PairViewOutput } from "../../functions/lib/public-release-pair-view";
import codec from "../../functions/lib/public-release-pair-catalog-images.js";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import view from "../../functions/lib/public-release-pair-view.js";
import baselineView from "../../functions/lib/public-release-pair-code-pack-view.js";
import { openPublicReleasePairReplayContext } from "./public-release-pair-replay-storage";
import { parsePublicReleasePairReplayProvenance } from "./public-release-pair-replay";
import { derivePublicReleasePairCatalogImages } from "./public-release-pair-catalog-images";
import { openStagedPublicReleasePairCodePack } from "./public-release-pair-code-pack-executor";
import { openPublicReleasePairViewMetadata, readPublicReleasePairClaimJson, type PairViewStore } from "./public-release-pair-view-storage";
type Owner = { firestore: Firestore; store: PairViewStore; pair: PublicReleasePair; identity: PairTaskIdentity; claimDigest: string; viewManifestDigest: string; signal?: AbortSignal };
const same = (a: unknown, b: unknown) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
function refuse(): never { throw new codec.PairCatalogImageError(); }
const json = (bytes: Uint8Array) => { try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return refuse(); } };
export async function openFrozenPublicReleasePairCatalogImages(owner: Pick<Owner, "firestore" | "store" | "pair" | "identity" | "signal">) {
  const captured = await openPublicReleasePairReplayContext(owner);
  return deriveFrozenPublicReleasePairCatalogImages(owner, captured);
}
/** Reuse an already opened exact H context within this operation. Body reads
 * still verify storage bytes; no source authority or cross-task cache is kept. */
export async function deriveFrozenPublicReleasePairCatalogImages(owner: Pick<Owner, "pair" | "identity" | "signal">,
  captured: Awaited<ReturnType<typeof openPublicReleasePairReplayContext>>) {
  if (captured.frozen.root.pairDigest !== protocol.publicReleaseDigest(owner.pair) ||
      captured.frozen.receipt.inputManifestDigest !== owner.identity.inputManifestDigest ||
      !same(captured.frozen.root.scope, { kind: owner.identity.kind, sourceOperationId: owner.identity.sourceOperationId,
        sourceVersion: owner.identity.sourceVersion, snapshotDigest: owner.identity.snapshotDigest, contextSequence: owner.identity.contextSequence })) refuse();
  async function* contexts() { for (const route of captured.plan.routes) if (route.renderer === "record") yield await captured.context(route); }
  return { ...await derivePublicReleasePairCatalogImages({ ...owner, root: captured.frozen.root, contexts: contexts() }), frozen: captured.frozen };
}
async function metadata(owner: Owner) {
  const object = await owner.store.get(`${view.publicReleasePairViewPrefix(owner.pair, owner.identity, owner.claimDigest)}views/${owner.viewManifestDigest}.json`);
  if (!object) refuse(); const manifestBytes = object.size; void object.body.cancel().catch(() => {});
  return openPublicReleasePairViewMetadata({ ...owner, manifestDigest: owner.viewManifestDigest, manifestBytes });
}
async function openManifest(owner: Owner, meta: Awaited<ReturnType<typeof metadata>>) {
  const link = meta.root.catalogImages; if (!link) refuse();
  const manifest = codec.parsePublicReleasePairCatalogImages(await readPublicReleasePairClaimJson({ ...owner, descriptor: link.descriptor, limit: view.BODY_BYTES_LIMIT }),
    owner.pair, owner.identity, meta.root.cursor);
  if (link.memberCount !== manifest.members.length || link.memberBytes !== manifest.members.reduce((sum, row) => sum + row.size, 0)) refuse();
  return { link, manifest };
}
function checkRow(row: PairViewOutput, member: ReturnType<typeof codec.parsePublicReleasePairCatalogImages>["members"][number], owner: Owner) {
  if (row.status !== 200 || row.path !== member.path || row.headers["content-type"] !== member.mime || row.bytes !== member.size ||
      row.bodyDigest !== member.sha256 || row.headers["x-njpbs-renderer-sha"] !== owner.pair.commitSha) refuse();
}
/** Validates the original catalog again, then composes with G's full byte pass.
 * New file authority is exact and cannot take over any mismatched baseline. */
export async function preparePublicReleasePairCatalogImagesReadback(owner: Owner) {
  const meta = await metadata(owner), selected = await openManifest(owner, meta), source = await openFrozenPublicReleasePairCatalogImages(owner);
  if (!same(source.manifest, selected.manifest)) refuse();
  const pack = await openStagedPublicReleasePairCodePack(owner);
  codec.assertPublicReleasePairCatalogBaseline(selected.manifest, pack.manifest);
  let count = 0, complete = false;
  return {
    async output(row: PairViewOutput & { body: Uint8Array }) {
      if (!row.path.startsWith("/_astro/")) return;
      const expected = selected.manifest.members[count++]; if (!expected) refuse(); checkRow(row, expected, owner);
    },
    async complete() { if (count !== selected.manifest.members.length) refuse(); complete = true; },
    async persist(staged: { readbackDigest: string }) {
      if (!complete) refuse();
      const proof = codec.parsePublicReleasePairCatalogImagesProof({ schemaVersion: 1, kind: "pair-catalog-images-proof", status: "staged",
        pairDigest: protocol.publicReleaseDigest(owner.pair), taskId: protocol.publicReleaseDigest(owner.identity), identity: owner.identity, claimDigest: owner.claimDigest,
        viewManifestDigest: owner.viewManifestDigest, viewReadbackDigest: staged.readbackDigest, inputManifestDigest: owner.identity.inputManifestDigest,
        cursor: source.frozen.root.cursor, descriptor: selected.link.descriptor, memberCount: selected.link.memberCount, memberBytes: selected.link.memberBytes,
        authority: { baselineInputManifestDigest: pack.receipt.inputManifestDigest, baselineCodePackManifestDigest: pack.receipt.codePackManifestDigest,
          baselineViewManifestDigest: pack.record.viewManifestDigest, codeAssetManifestDigest: owner.pair.codeAssetManifestDigest } },
      owner.pair, owner.identity, owner.claimDigest, owner.viewManifestDigest);
      await owner.firestore.runTransaction(async transaction => {
        await work.assertPublicReleasePairCompletedReceiptInTransaction({ ...owner, transaction, taskId: proof.taskId, manifestDigest: owner.viewManifestDigest });
        const baseline = await baselineView.assertReadPublicReleasePairStagedCodePackInTransaction({ ...owner, transaction });
        const ref = owner.firestore.doc(codec.publicReleasePairCatalogImagesProofPath(owner.pair, owner.viewManifestDigest));
        const [before, actual] = await transaction.getAll(ref, owner.firestore.doc(`${work.publicReleasePairPath(owner.pair.pairId)}/views/${owner.viewManifestDigest}`));
        const stagedView = actual.data();
        if (baseline.viewManifestDigest !== proof.authority.baselineViewManifestDigest || stagedView?.status !== "staged" ||
            stagedView.readbackDigest !== proof.viewReadbackDigest || stagedView.claimDigest !== owner.claimDigest || !same(stagedView.identity, owner.identity)) refuse();
        owner.signal?.throwIfAborted();
        if (before.exists) { if (!same(before.data(), proof)) refuse(); } else transaction.create(ref, proof);
      });
      return proof;
    },
  };
}
/** Metadata/opened ownership is not a new whole-body proof. Every requested
 * member is checked against G's immutable row and actual bytes; unlisted paths
 * never gain an image wildcard or an absence certificate. */
export async function openStagedPublicReleasePairCatalogImages(owner: Owner) {
  const proof = codec.parsePublicReleasePairCatalogImagesProof((await owner.firestore.doc(codec.publicReleasePairCatalogImagesProofPath(owner.pair, owner.viewManifestDigest)).get()).data(),
    owner.pair, owner.identity, owner.claimDigest, owner.viewManifestDigest);
  const meta = await metadata(owner), selected = await openManifest(owner, meta), captured = await openPublicReleasePairReplayContext(owner);
  if (!same(proof.descriptor, selected.link.descriptor)) refuse();
  const provenance = parsePublicReleasePairReplayProvenance(json(await captured.frozen.readFile("reader-provenance.json")));
  const files = new Map(captured.frozen.root.files.map(file => [file.name, file]));
  for (const authority of selected.manifest.catalogs) {
    if (files.get(authority.inputFile)?.digest !== authority.inputDigest || files.get("reader-provenance.json")?.digest !== authority.provenanceDigest ||
        authority.originalPairDigest !== protocol.publicReleaseDigest(provenance.pair) || authority.rendererSha !== provenance.rendererSha ||
        authority.readerContractDigest !== provenance.readerContractDigest || authority.readerReceiptDigest !== provenance.readerReceiptDigest) refuse();
  }
  const pack = await openStagedPublicReleasePairCodePack(owner);
  codec.assertPublicReleasePairCatalogBaseline(selected.manifest, pack.manifest);
  await owner.firestore.runTransaction(transaction => codec.assertReadPublicReleasePairCatalogImagesInTransaction({ ...owner, transaction,
    manifest: selected.manifest, manifestDigest: selected.link.descriptor.digest }), { readOnly: true });
  const members = new Map(selected.manifest.members.map(member => [member.path, member]));
  const readMember = async (path: string) => {
    const member = members.get(path); if (!member) throw new codec.PairCatalogImageError("catalog-unlisted");
    const row = await meta.output(path); if (!row) refuse(); checkRow(row, member, owner);
    return { member, body: (await meta.readBody(path)).body };
  };
  return { proof, record: proof, manifest: selected.manifest, readMember,
    async verifyAll() { for (const member of selected.manifest.members) await readMember(member.path); } };
}
