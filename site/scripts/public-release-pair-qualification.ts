import { createHash } from "node:crypto";
import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairInputReceipt } from "../../functions/lib/public-release-pair-input";
import type { ReplayViewReference, ReplayWitness, ReplayNamespaceSelection } from "../../functions/lib/public-release-pair-replay";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import input from "../../functions/lib/public-release-pair-input.js";
import replay from "../../functions/lib/public-release-pair-replay.js";
import view from "../../functions/lib/public-release-pair-view.js";
import catalogCodec from "../../functions/lib/public-release-pair-catalog-images.js";
import inventory from "../../functions/lib/public-release-pair-replay-inventory.js";
import { readPublicReleasePairReplaySelection, type ReplaySelectionMember } from "./public-release-pair-replay-selection-storage";
import { readPairQualificationAuthority, assertPairQualificationAuthorityCurrent, PairQualificationError,
  QUALIFICATION_ROUTE_LIMIT, type QualificationAuthority } from "./public-release-pair-qualification-authority";
import { readQualificationCodePack, openQualificationInput, assertQualificationOwnedSnapshots } from "./public-release-pair-qualification-inputs";
import { verifyPairViewRemoteBytes, verifyPairNamespaceRemoteAbsence, type ExpectedQualifiedOutput, type DeclaredQualifiedOutput } from "./public-release-pair-qualification-bytes";
import { openQualificationCatalogs, assertQualificationCatalogsInTransaction, type QualificationCatalog } from "./public-release-pair-qualification-catalog";
import { openQualificationComposites, assertQualificationCompositesInTransaction, type QualificationComposite } from "./public-release-pair-qualification-composite";
import { prepareQualificationSource, assertPreparedQualificationSource, assertQualificationSourceInTransaction,
  trackQualificationTransactionReads, type PreparedQualificationSource } from "./public-release-pair-qualification-source";
import { bindQualificationNamespaces } from "./public-release-pair-qualification-namespace";
import { PAIR_CONTENT_FEED_NAMESPACE, PAIR_CONTENT_FEED_AUTHORITY_PACK_PATH } from "./public-release-pair-content-feed-authority";
import { assertPublicReleasePairContentFeedIndex, assertPublicReleasePairContentFeedPage } from "./public-release-pair-content-feed-namespace";
import { createQualificationEvidenceWriter, readQualificationEvidence, type QualificationEvidence } from "./public-release-pair-qualification-evidence";
import { parseQualificationReceipt, qualificationReceiptPath, readQualificationReceiptInTransaction,
  type QualificationReceipt } from "./public-release-pair-qualification-receipt";
export { trackQualificationTransactionReads, assertQualificationTransactionReadBudget,
  QUALIFICATION_TRANSACTION_READ_LIMIT } from "./public-release-pair-qualification-source";
export type { QualificationTransactionReadTracker, PreparedQualificationSource } from "./public-release-pair-qualification-source";
import { canonicalPath, same, withinReaderDeadline } from "./public-release-pair-reader-contract";

export const PAIR_QUALIFICATION_DEADLINE_MS = 10 * 60_000;
function coverageMismatch(): never { throw new PairQualificationError("coverage-mismatch"); }
const validDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
async function witnessProofInTransaction(args: { firestore: Firestore; transaction: Transaction; pair: PublicReleasePair;
  headCursor: QualificationAuthority["cursor"]; witnessDigest: string; namespaces: readonly ReplayNamespaceSelection[];
  selectedViews?: readonly ReplayViewReference[]; headView?: ReplayViewReference }) {
  try {
    const proof = await replay.assertReadReplayWitnessProofInTransaction(args);
    return { witness: proof.witness, headView: proof.headView, ...bindQualificationNamespaces(args.pair, proof.witness, proof.namespaces) };
  }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "replay-search-input-evidence-missing") {
      throw new PairQualificationError("replay-search-input-evidence-missing");
    }
    throw new PairQualificationError("replay-unproven");
  }
}
function assertBindings(receipt: QualificationReceipt, witness: ReplayWitness, authority: QualificationAuthority, witnessDigest: string,
  namespaceProofDigest: string, extra: Partial<Pick<QualificationReceipt, "catalogProofDigest" | "compositeProofDigest" | "sourceCensusDigest" | "headViewDigest">> = {}) {
  if (receipt.witnessDigest !== witnessDigest || receipt.contentViewDigest !== witness.contentViewDigest ||
      receipt.codePackOverlayDigest !== witness.codePackOverlayDigest || receipt.authorityDigest !== authority.digest ||
      receipt.sealsDigest !== authority.sealsDigest || receipt.namespaceProofDigest !== namespaceProofDigest ||
      (Object.keys(extra) as (keyof typeof extra)[]).some(key => receipt[key] !== extra[key])) throw new PairQualificationError("stale-qualification");
}
async function originalCapture({ firestore, transaction, pair, reference }: {
  firestore: Firestore; transaction: Transaction; pair: PublicReleasePair; reference: ReplayViewReference;
}): Promise<PairInputReceipt> {
  const identity = reference.identity;
  const scope = input.parsePublicReleasePairInputScope({ kind: identity.kind, sourceOperationId: identity.sourceOperationId,
    sourceVersion: identity.sourceVersion, snapshotDigest: identity.snapshotDigest, contextSequence: identity.contextSequence });
  const row = await transaction.get(firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/inputs/${identity.inputManifestDigest}`));
  const captured = input.parsePublicReleasePairInputReceipt(row.data(), pair, scope, identity.inputManifestDigest);
  const checked = await replay.assertStagedReplayViewInTransaction({ firestore, transaction, pair, reference, cursor: captured.cursor });
  if (!same(captured, checked.captured)) coverageMismatch();
  return checked.captured;
}
function selectedReferences(references: readonly ReplayViewReference[], pair: PublicReleasePair) {
  const refs = new Map<string, ReplayViewReference>();
  for (const raw of references) { const ref = replay.parseReplayViewReference(raw, pair); refs.set(protocol.publicReleaseDigest(ref), ref); }
  return [...refs].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, ref]) => ref);
}
function proofHash(witnessDigest: string) {
  return createHash("sha256").update("private-pair-qualification-v1\n").update(witnessDigest + "\n");
}
async function retainedEvidence({ store, pair, qualificationId, witnessDigest, evidence, signal }: {
  store: Parameters<typeof readQualificationEvidence>[0]["store"]; pair: PublicReleasePair; qualificationId: string; witnessDigest: string;
  evidence: QualificationReceipt["evidence"]; signal: AbortSignal;
}) {
  const hash = proofHash(witnessDigest), coverage = { baseline: 0, content: 0, overlay: 0, absence: 0 };
  let count = 0, bytes = 0;
  for await (const row of readQualificationEvidence({ store, pair, qualificationId, witnessDigest, ...evidence, signal })) {
    // Preserve actual request nonces in immutable pages. The semantic digest is
    // stable on an exact retry and cannot refresh the original qualifiedAt.
    const { requestDigest: _requestDigest, ...semantic } = row;
    hash.update(protocol.publicReleaseDigest(semantic) + "\n"); coverage[row.kind]++; count++; bytes += row.bytes;
  }
  if (count !== evidence.outputCount || bytes !== evidence.outputBytes) coverageMismatch();
  return { byteProofDigest: hash.digest("hex"), coverage };
}

/** Read retained private proof before the future switch transaction. No public
 * exposure, current ownership or selection authority comes from these bytes. */
export async function verifyStoredQualificationEvidence({ firestore, store, pair, witness: rawWitness, namespaces: rawNamespaces, receipt: rawReceipt, signal }: {
  firestore: Firestore; store: Parameters<typeof readQualificationEvidence>[0]["store"]; pair: PublicReleasePair;
  receipt: QualificationReceipt; witness: ReplayWitness; namespaces: readonly ReplayNamespaceSelection[]; signal: AbortSignal;
}) {
  const receipt = parseQualificationReceipt(rawReceipt, pair);
  const witness = replay.parseReplayWitness(rawWitness, pair);
  const namespaceProof = bindQualificationNamespaces(pair, witness, rawNamespaces);
  if (protocol.publicReleaseDigest(witness) !== receipt.witnessDigest || witness.contentViewDigest !== receipt.contentViewDigest ||
      witness.codePackOverlayDigest !== receipt.codePackOverlayDigest || namespaceProof.namespaceProofDigest !== receipt.namespaceProofDigest) coverageMismatch();
  const refs: ReplayViewReference[] = [witness.codePackView, ...namespaceProof.namespaces.map(namespace => namespace.view)];
  for (const [kind, digest] of [["content", witness.contentViewDigest], ["code-pack-overlay", witness.codePackOverlayDigest]] as const) {
    for await (const member of readPublicReleasePairReplaySelection({ store, pair, kind, cursor: witness.headCursor, digest })) {
      signal.throwIfAborted(); refs.push(member.view);
    }
  }
  const selectedViews = selectedReferences(refs, pair);
  if (selectedViews.length !== receipt.selectedViewCount || protocol.publicReleaseDigest(selectedViews) !== receipt.selectedViewsDigest) coverageMismatch();
  const compositeProof = await openQualificationComposites({ firestore, store, pair, witness, references: selectedViews, signal });
  if (compositeProof.compositeProofDigest !== receipt.compositeProofDigest) throw new PairQualificationError("stale-qualification");
  const catalogProof = await openQualificationCatalogs({ firestore, store, pair, witness, references: selectedViews, signal });
  if (catalogProof.catalogProofDigest !== receipt.catalogProofDigest) throw new PairQualificationError("stale-qualification");
  const proof = await retainedEvidence({ store, pair, qualificationId: receipt.qualificationId,
    witnessDigest: receipt.witnessDigest, evidence: receipt.evidence, signal });
  if (proof.byteProofDigest !== receipt.byteProofDigest || !same(proof.coverage, receipt.coverage)) coverageMismatch();
  const expanded = await replay.openPublicReleasePairReplayWitnessProof({ firestore, pair, headCursor: witness.headCursor,
    witnessDigest: receipt.witnessDigest, selectedViews });
  if (!same(expanded.witness, witness) || protocol.publicReleaseDigest(expanded.headView) !== receipt.headViewDigest) coverageMismatch();
  const captured = await firestore.runTransaction(transaction => originalCapture({ firestore, transaction, pair,
    reference: expanded.headView }), { readOnly: true });
  const source = await prepareQualificationSource({ firestore, store, pair, witness, witnessDigest: receipt.witnessDigest,
    headView: expanded.headView, captured, signal });
  assertPreparedQualificationSource(pair, receipt.witnessDigest, source, receipt.sourceCensusDigest, receipt.headViewDigest);
  return { ...proof, selectedViews, namespaces: namespaceProof.namespaces, ...catalogProof, ...compositeProof, source };
}

/** Called inside the later switch owner's own guarded transaction, after its
 * retained proof read. It rechecks live authority, seals and strict replay;
 * it neither selects a pair nor writes capabilities, admission or publication. */
export async function assertPublicReleasePairQualificationCurrentInTransaction({ firestore, transaction, pair,
  qualificationId, receiptDigest, selectedViews: rawViews, namespaces, catalogs, composites, source, readTracker }: { firestore: Firestore; transaction: Transaction; pair: PublicReleasePair;
    qualificationId: string; receiptDigest: string; selectedViews: readonly ReplayViewReference[];
    namespaces: readonly ReplayNamespaceSelection[]; catalogs: readonly QualificationCatalog[]; composites: readonly QualificationComposite[]; source: PreparedQualificationSource;
    readTracker?: ReturnType<typeof trackQualificationTransactionReads> }) {
  const tracker = trackQualificationTransactionReads(transaction, readTracker);
  transaction = tracker.transaction;
  const stored = await readQualificationReceiptInTransaction({ firestore, transaction, pair, qualificationId });
  if (!stored || !validDigest(receiptDigest) || stored.digest !== receiptDigest) throw new PairQualificationError("stale-qualification");
  assertPreparedQualificationSource(pair, stored.receipt.witnessDigest, source, stored.receipt.sourceCensusDigest, stored.receipt.headViewDigest);
  const selectedViews = selectedReferences(rawViews, pair);
  if (selectedViews.length !== rawViews.length || selectedViews.length !== stored.receipt.selectedViewCount ||
      protocol.publicReleaseDigest(selectedViews) !== stored.receipt.selectedViewsDigest) throw new PairQualificationError("stale-qualification");
  const authority = await assertPairQualificationAuthorityCurrent({ firestore, transaction, pair,
    expectedDigest: stored.receipt.authorityDigest, qualifiedAt: stored.receipt.qualifiedAt });
  const proof = await witnessProofInTransaction({ firestore, transaction, pair, headCursor: authority.cursor,
    witnessDigest: stored.receipt.witnessDigest, selectedViews, namespaces, headView: source.headView });
  const catalogProof = await assertQualificationCatalogsInTransaction({ firestore, transaction, pair, witness: proof.witness,
    catalogs, expectedDigest: stored.receipt.catalogProofDigest });
  const compositeProof = await assertQualificationCompositesInTransaction({ firestore, transaction, pair, witness: proof.witness,
    composites, expectedDigest: stored.receipt.compositeProofDigest });
  const sourceValidation = await assertQualificationSourceInTransaction({ firestore, tracker, pair, witness: proof.witness,
    witnessDigest: stored.receipt.witnessDigest, source, sourceCensusDigest: stored.receipt.sourceCensusDigest, headViewDigest: stored.receipt.headViewDigest });
  assertBindings(stored.receipt, proof.witness, authority, stored.receipt.witnessDigest, proof.namespaceProofDigest,
    { catalogProofDigest: catalogProof.catalogProofDigest, compositeProofDigest: compositeProof.compositeProofDigest,
      sourceCensusDigest: source.metadata.digest, headViewDigest: protocol.publicReleaseDigest(source.headView) });
  return { ...stored, authority, ...proof, ...catalogProof, ...compositeProof, sourceValidation };
}

type Group = { kind: Exclude<QualificationEvidence["kind"], "absence">; reference: ReplayViewReference;
  expected: Map<string, ExpectedQualifiedOutput>; inventory?: Map<string, DeclaredQualifiedOutput> };

/** Inert private qualification. The only database write is a create-only
 * qualification receipt after complete original-input, remote-byte and live
 * validator proof. This function does not activate public resources. */
export async function qualifyPublicReleasePair({ firestore, store, pair: rawPair, qualificationId, witnessDigest,
  credentials, signal: callerSignal }: { firestore: Firestore; store: Parameters<typeof readQualificationEvidence>[0]["store"];
  pair: PublicReleasePair; qualificationId: string; witnessDigest: string; credentials: () => Promise<HeadersInit>; signal?: AbortSignal;
}) {
  const pair = protocol.parsePublicReleasePair(rawPair);
  work.assertPrivatePairResources(pair);
  if (!validDigest(witnessDigest)) throw new PairQualificationError("replay-unproven");
  const receiptPath = qualificationReceiptPath(pair, qualificationId);
  const signal = AbortSignal.any([...(callerSignal ? [callerSignal] : []), AbortSignal.timeout(PAIR_QUALIFICATION_DEADLINE_MS)]);
  return withinReaderDeadline(signal, async () => {
    signal.throwIfAborted();
    const authority = await firestore.runTransaction(transaction => readPairQualificationAuthority({ firestore, transaction, pair }), { readOnly: true });
    // Expand immutable namespace inventories outside the transaction. The
    // replay owner's constant-size final capsule guard binds that exact proof.
    let expanded;
    try { expanded = await replay.openPublicReleasePairReplayWitnessProof({ firestore, pair, headCursor: authority.cursor, witnessDigest }); }
    catch { throw new PairQualificationError("replay-unproven"); }
    const before = await firestore.runTransaction(async transaction => {
      const proof = await witnessProofInTransaction({ firestore, transaction, pair, headCursor: authority.cursor,
        witnessDigest, namespaces: expanded.namespaces, headView: expanded.headView });
      const { witness } = proof;
      const baseline = await replay.assertStagedReplayViewInTransaction({ firestore, transaction, pair,
        reference: witness.codePackView, cursor: witness.fromCursor });
      const headCaptured = await originalCapture({ firestore, transaction, pair, reference: proof.headView });
      const old = await readQualificationReceiptInTransaction({ firestore, transaction, pair, qualificationId });
      if (old) {
        assertBindings(old.receipt, witness, authority, witnessDigest, proof.namespaceProofDigest);
        if (authority.capturedAt < old.receipt.qualifiedAt || authority.capturedAt - old.receipt.qualifiedAt > 60_000) throw new PairQualificationError("stale-qualification");
      }
      return { authority, ...proof, captured: baseline.captured, headCaptured, old };
    }, { readOnly: true });
    const { witness, namespaces, namespaceProofDigest } = before;
    const initialSource = await prepareQualificationSource({ firestore, store, pair, witness, witnessDigest,
      headView: before.headView, captured: before.headCaptured, signal });
    const sourceCensusDigest = initialSource.metadata.digest, headViewDigest = protocol.publicReleaseDigest(initialSource.headView);
    if (before.old) assertBindings(before.old.receipt, witness, authority, witnessDigest, namespaceProofDigest, { sourceCensusDigest, headViewDigest });
    const { pack, frozen: baselineInput } = await readQualificationCodePack({ firestore, store, pair, reference: witness.codePackView,
      captured: before.captured, signal });
    if (pack.codeAssetManifestDigest !== witness.codeAssetManifestDigest) throw new PairQualificationError("incomplete-code-pack");
    const members = new Map(pack.members.map(member => [member.path, member]));
    const namespaceMembers = new Map(namespaces.flatMap(namespace => namespace.members.map(member => [member.path, member] as const)));
    const contentSelections: ReplaySelectionMember[] = [], codeSelections: ReplaySelectionMember[] = [];
    for (const [kind, digest, rows] of [["content", witness.contentViewDigest, contentSelections],
      ["code-pack-overlay", witness.codePackOverlayDigest, codeSelections]] as const) {
      for await (const selected of readPublicReleasePairReplaySelection({ store, pair, kind, cursor: witness.headCursor, digest })) {
        signal.throwIfAborted();
        if (rows.length === QUALIFICATION_ROUTE_LIMIT) coverageMismatch();
        rows.push(selected);
      }
    }
    const compositeProof = await openQualificationComposites({ firestore, store, pair, witness, signal,
      references: selectedReferences([witness.codePackView, ...namespaces.map(namespace => namespace.view),
        ...contentSelections.map(selected => selected.view), ...codeSelections.map(selected => selected.view)], pair) });
    const compositeMembers = new Map(compositeProof.composites.map(selected =>
      [protocol.publicReleaseDigest(selected.view), new Map(selected.manifest.members.map(member => [member.path, member]))]));
    const namespaceForPath = (path: string) => namespaces.find(namespace => path.startsWith(namespace.namespace));
    const isOverlayNamespace = (namespace: typeof namespaces[number]) => !same(namespace.view, witness.codePackView);
    const sealedNamespaces = new Set<string>(namespaces.map(namespace => namespace.namespace));
    if (pack.members.some(member => member.path.startsWith("/pagefind/")) !== sealedNamespaces.has("/pagefind/") ||
        members.has(PAIR_CONTENT_FEED_AUTHORITY_PACK_PATH) !== sealedNamespaces.has(PAIR_CONTENT_FEED_NAMESPACE)) {
      throw new PairQualificationError("incomplete-code-pack");
    }
    for (const namespace of namespaces) {
      const prior = new Set(namespace.priorPaths), current = new Set(namespace.members.map(member => member.path));
      for (const member of pack.members) if (member.path.startsWith(namespace.namespace) &&
          (!prior.has(member.path) || !isOverlayNamespace(namespace) && !current.has(member.path))) coverageMismatch();
    }
    const owned = new Map(authority.routes.map(route => [route.path, route]));
    const groups = new Map<string, Group>(), currentPaths = new Set<string>(), overlayPaths = new Set<string>();
    const overlaySelections = new Map<string, { view: ReplayViewReference; bodyDigest: string }>(), pendingCatalogPaths = new Set<string>();
    const counts = { baseline: 0, content: 0, overlay: 0, absence: 0 };
    const group = (kind: Group["kind"], reference: ReplayViewReference) => {
      reference = replay.parseReplayViewReference(reference, pair);
      if (reference.identity.contextSequence < witness.fromCursor.sequence || reference.identity.contextSequence > witness.headCursor.sequence) coverageMismatch();
      const key = `${kind}:${reference.manifestDigest}:${reference.claimDigest}`;
      let existing = groups.get(key);
      if (existing && !same(existing.reference, reference)) coverageMismatch();
      if (!existing) { existing = { kind, reference, expected: new Map() }; groups.set(key, existing); }
      return existing;
    };
    for (const selected of codeSelections) {
      signal.throwIfAborted();
      const closed = compositeMembers.get(protocol.publicReleaseDigest(selected.view))?.get(selected.path);
      if (!closed || closed.sha256 !== selected.bodyDigest) coverageMismatch();
      const baseline = members.get(selected.path), namespaceMember = namespaceMembers.get(selected.path);
      if (overlayPaths.has(selected.path)) coverageMismatch();
      const namespace = namespaceForPath(selected.path);
      if (namespace) {
        if (!isOverlayNamespace(namespace) || !namespaceMember || !same(selected.view, namespace.view) || selected.bodyDigest !== namespaceMember.sha256) coverageMismatch();
      } else if (!baseline?.dynamic) {
        // Exact owner-validated auxiliary rows may introduce only their closed
        // roster. Catalog additions also require their separate proof below.
        if (baseline || !["catalog", "auxiliary"].includes(closed.role)) coverageMismatch();
        if (closed.role === "catalog") pendingCatalogPaths.add(selected.path);
      }
      overlaySelections.set(selected.path, { view: selected.view, bodyDigest: selected.bodyDigest });
      overlayPaths.add(selected.path); currentPaths.add(selected.path); counts.overlay++;
      const owner = owned.get(selected.path);
      group("overlay", selected.view).expected.set(selected.path, { bodyDigest: selected.bodyDigest,
        status: closed.status, mime: closed.mime, bytes: closed.size,
        ...(owner ? { location: owner.location } : closed.status === 200 ? { location: null } : {}) });
    }
    const baselineGroup = group("baseline", witness.codePackView);
    baselineGroup.inventory = new Map();
    for (const member of pack.members) {
      baselineGroup.inventory.set(member.path, { status: 200, mime: member.mime, bytes: member.size, bodyDigest: member.sha256 });
      if (overlayPaths.has(member.path) || namespaces.some(namespace => isOverlayNamespace(namespace) && member.path.startsWith(namespace.namespace))) continue;
      baselineGroup.expected.set(member.path, { bodyDigest: member.sha256, status: 200, mime: member.mime, bytes: member.size, location: null });
      currentPaths.add(member.path); counts.baseline++;
    }
    for (const namespace of namespaces) for (const member of namespace.members) {
      if (!currentPaths.has(member.path) || isOverlayNamespace(namespace) && !overlayPaths.has(member.path)) coverageMismatch();
      if (!isOverlayNamespace(namespace)) {
        const baseline = members.get(member.path);
        if (!baseline || baseline.sha256 !== member.sha256 || baseline.size !== member.size || baseline.mime !== member.mime) coverageMismatch();
      }
    }
    for (const selected of contentSelections) {
      signal.throwIfAborted();
      const closed = compositeMembers.get(protocol.publicReleaseDigest(selected.view))?.get(selected.path);
      if (!closed || closed.sha256 !== selected.bodyDigest || !["route", "auxiliary"].includes(closed.role)) coverageMismatch();
      // Baseline files are never a second content authority. Dynamic members
      // belong exclusively to the overlay lane; static overrides always refuse.
      if (!canonicalPath(selected.path) || !selected.path.endsWith("/") || members.has(selected.path) || currentPaths.has(selected.path)) coverageMismatch();
      const owner = owned.get(selected.path);
      group("content", selected.view).expected.set(selected.path, { bodyDigest: selected.bodyDigest,
        status: closed.status, mime: closed.mime, bytes: closed.size,
        ...(closed.kind === "author" && closed.owner ? { location: closed.status === 308 ? closed.owner.canonicalPath : null }
          : owner ? { location: owner.location } : closed.status === 200 ? { location: null } : {}) });
      currentPaths.add(selected.path); counts.content++;
    }
    if (authority.routes.some(route => !currentPaths.has(route.path))) coverageMismatch();
    // A baseline/overlay path can also be an owned aggregate (Home JSON).
    // Its current source is still one selected output and must preserve status.
    for (const candidate of groups.values()) for (const [path, wanted] of candidate.expected) {
      const owner = owned.get(path);
      if (owner && (wanted.status !== undefined && wanted.status !== owner.status ||
          wanted.location !== undefined && wanted.location !== owner.location)) coverageMismatch();
    }
    for (const namespace of namespaces) if (namespace.namespace === "/api/v1/content/") {
      const candidate = [...groups.values()].find(candidate => same(candidate.reference, namespace.view) && candidate.expected.has(namespace.index.path));
      if (!candidate || isOverlayNamespace(namespace) !== overlayPaths.has(namespace.index.path)) coverageMismatch();
      let index: ReturnType<typeof assertPublicReleasePairContentFeedIndex> | undefined;
      const wanted = candidate.expected.get(namespace.index.path)!;
      if (wanted.bodyDigest !== namespace.index.sha256) coverageMismatch();
      candidate.expected.set(namespace.index.path, { ...wanted, status: 200, mime: namespace.index.mime,
        bytes: namespace.index.size, bodyDigest: namespace.index.sha256,
        verifyBody: bytes => { index = assertPublicReleasePairContentFeedIndex(bytes, namespace.manifest); } });
      for (const member of namespace.members) {
        const page = candidate.expected.get(member.path);
        if (!page) coverageMismatch();
        candidate.expected.set(member.path, { ...page, verifyBody: bytes => {
          if (!index) coverageMismatch();
          assertPublicReleasePairContentFeedPage(bytes, member.path, namespace.manifest, index);
        } });
      }
    }
    const catalogProof = await openQualificationCatalogs({ firestore, store, pair, witness,
      references: selectedReferences([...groups.values()].map(group => group.reference), pair), signal });
    const catalogMembers = new Map(catalogProof.catalogs.map(selected =>
      [protocol.publicReleaseDigest(selected.view), new Map(selected.manifest.members.map(member => [member.path, member]))]));
    for (const path of pendingCatalogPaths) {
      const selected = overlaySelections.get(path)!;
      const member = catalogMembers.get(protocol.publicReleaseDigest(selected.view))?.get(path);
      if (!member || member.sha256 !== selected.bodyDigest) coverageMismatch();
    }
    for (const selected of catalogProof.catalogs) {
      catalogCodec.assertPublicReleasePairCatalogBaseline(selected.manifest, pack);
      if (!selected.manifest.members.length) continue;
      const expected = group("overlay", selected.view).expected;
      for (const member of selected.manifest.members) {
        const baseline = members.get(member.path), serving = overlaySelections.get(member.path);
        if (baseline ? serving !== undefined : !serving || serving.bodyDigest !== member.sha256) coverageMismatch();
        const prior = expected.get(member.path);
        if (prior && prior.bodyDigest !== member.sha256) coverageMismatch();
        if (!prior) counts.overlay++;
        // Even identical baseline copies get actual HTTP evidence for their
        // original catalog G; the replay selection stays on the baseline.
        expected.set(member.path, { bodyDigest: member.sha256, status: 200, mime: member.mime, bytes: member.size, location: null });
      }
    }
    if (before.old) assertBindings(before.old.receipt, witness, authority, witnessDigest, namespaceProofDigest,
      { catalogProofDigest: catalogProof.catalogProofDigest, compositeProofDigest: compositeProof.compositeProofDigest, sourceCensusDigest, headViewDigest });
    const selectedViews = selectedReferences([...groups.values()].map(group => group.reference).concat(namespaces.map(namespace => namespace.view)), pair);
    const checked = await firestore.runTransaction(transaction => witnessProofInTransaction({ firestore, transaction, pair,
      headCursor: authority.cursor, witnessDigest, selectedViews, namespaces }), { readOnly: true });
    if (checked.namespaceProofDigest !== namespaceProofDigest) throw new PairQualificationError("replay-unproven");
    await firestore.runTransaction(transaction => assertQualificationCatalogsInTransaction({ firestore, transaction, pair,
      witness, catalogs: catalogProof.catalogs, expectedDigest: catalogProof.catalogProofDigest }), { readOnly: true });
    await firestore.runTransaction(transaction => assertQualificationCompositesInTransaction({ firestore, transaction, pair,
      witness, composites: compositeProof.composites, expectedDigest: compositeProof.compositeProofDigest }), { readOnly: true });
    const evidenceWriter = createQualificationEvidenceWriter({ store, pair, qualificationId, witnessDigest, signal });
    const readStagedDigest = (reference: ReplayViewReference) => firestore.runTransaction(async transaction => {
      await originalCapture({ firestore, transaction, pair, reference });
      const row = await transaction.get(firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/views/${reference.manifestDigest}`));
      const digest = row.data()?.readbackDigest;
      if (!validDigest(digest)) coverageMismatch(); return digest;
    }, { readOnly: true });
    // Absence rows sort before body rows. Prove all former names, including
    // transient members, against the selected complete namespace over HTTP.
    const absenceNamespaces = namespaces.filter(namespace => namespace.withdrawnPaths.length).sort((a, b) => {
      const key = (value: typeof a) => `${value.view.manifestDigest}:${value.view.claimDigest}:${value.withdrawnPaths[0]}`;
      return view.comparePrivatePairArtifactPaths(key(a), key(b));
    });
    for (const namespace of absenceNamespaces) {
      const proof = await verifyPairNamespaceRemoteAbsence({ pair, selectedView: namespace.view, seals: authority.seals, credentials,
        absence: { namespace: namespace.namespace, namespaceRootDigest: namespace.namespaceRootDigest,
          namespaceManifestDigest: namespace.namespaceManifestDigest, cursor: namespace.cursor, paths: namespace.withdrawnPaths },
        stagedReadbackDigest: await readStagedDigest(namespace.view), signal, evidence: row => evidenceWriter.append(row) });
      counts.absence += proof.absenceCount;
    }
    for (const [, candidate] of [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      signal.throwIfAborted();
      if (!candidate.expected.size) coverageMismatch();
      let frozen = baselineInput;
      if (candidate.kind !== "baseline") {
        const { captured, outputs } = await firestore.runTransaction(async transaction => {
          const captured = await originalCapture({ firestore, transaction, pair, reference: candidate.reference });
          const outputs = await inventory.readReplayOutputInventory({ firestore, transaction, pair, reference: candidate.reference, cursor: captured.cursor });
          return { captured, outputs };
        }, { readOnly: true });
        frozen = await openQualificationInput({ firestore, store, pair, reference: candidate.reference, captured, signal });
        candidate.inventory = new Map(outputs.map(output => [output.path, { status: output.status,
          mime: output.headers["content-type"], bytes: output.bytes, bodyDigest: output.bodyDigest }]));
        const outputsByPath = new Map(outputs.map(output => [output.path, output]));
        for (const [path, wanted] of candidate.expected) {
          const output = outputsByPath.get(path), declared = candidate.inventory.get(path);
          if (!declared || !output || wanted.status !== undefined && wanted.status !== declared.status ||
              wanted.mime !== undefined && wanted.mime !== declared.mime) coverageMismatch();
          if (candidate.kind === "overlay" && declared.status === 200 && declared.mime !==
              compositeMembers.get(protocol.publicReleaseDigest(candidate.reference))?.get(path)?.mime) coverageMismatch();
          const location = output.headers.location ?? null;
          if (wanted.location !== undefined && wanted.location !== location) coverageMismatch();
          candidate.expected.set(path, { ...wanted, status: declared.status, mime: declared.mime, location });
        }
      }
      await assertQualificationOwnedSnapshots(frozen, [...candidate.expected.keys()].flatMap(path => {
        const route = owned.get(path); return route ? [route] : [];
      }));
      const stagedReadbackDigest = await readStagedDigest(candidate.reference);
      await verifyPairViewRemoteBytes({ pair, store, selectedView: candidate.reference, expected: candidate.expected,
        inventory: candidate.inventory, seals: authority.seals, credentials, stagedReadbackDigest, signal,
        evidence: row => evidenceWriter.append({ kind: candidate.kind, ...row }) });
    }
    const evidence = await evidenceWriter.finish();
    const summary = await retainedEvidence({ store, pair, qualificationId, witnessDigest, evidence, signal });
    if (!same(summary.coverage, counts)) coverageMismatch();
    if (before.old) await verifyStoredQualificationEvidence({ firestore, store, pair, receipt: before.old.receipt, witness, namespaces, signal });
    signal.throwIfAborted();
    const finalSource = await prepareQualificationSource({ firestore, store, pair, witness, witnessDigest,
      headView: before.headView, captured: before.headCaptured, signal });
    assertPreparedQualificationSource(pair, witnessDigest, finalSource, sourceCensusDigest, headViewDigest);
    return firestore.runTransaction(async originalTransaction => {
      const tracker = trackQualificationTransactionReads(originalTransaction), transaction = tracker.transaction;
      const live = await readPairQualificationAuthority({ firestore, transaction, pair });
      if (live.digest !== authority.digest || live.sealsDigest !== authority.sealsDigest) throw new PairQualificationError("stale-qualification");
      const finalProof = await witnessProofInTransaction({ firestore, transaction, pair, headCursor: live.cursor, witnessDigest, selectedViews, namespaces, headView: finalSource.headView });
      if (!same(finalProof.witness, witness) || finalProof.namespaceProofDigest !== namespaceProofDigest) throw new PairQualificationError("replay-unproven");
      const finalCatalog = await assertQualificationCatalogsInTransaction({ firestore, transaction, pair, witness,
        catalogs: catalogProof.catalogs, expectedDigest: catalogProof.catalogProofDigest });
      const finalComposite = await assertQualificationCompositesInTransaction({ firestore, transaction, pair, witness,
        composites: compositeProof.composites, expectedDigest: compositeProof.compositeProofDigest });
      const existing = await readQualificationReceiptInTransaction({ firestore, transaction, pair, qualificationId });
      const sourceValidation = await assertQualificationSourceInTransaction({ firestore, tracker, pair, witness,
        witnessDigest, source: finalSource, sourceCensusDigest, headViewDigest });
      signal.throwIfAborted();
      if (existing) {
        assertBindings(existing.receipt, witness, live, witnessDigest, namespaceProofDigest,
          { catalogProofDigest: finalCatalog.catalogProofDigest, compositeProofDigest: finalComposite.compositeProofDigest, sourceCensusDigest, headViewDigest });
        if (existing.receipt.byteProofDigest !== summary.byteProofDigest ||
            existing.receipt.selectedViewCount !== selectedViews.length || existing.receipt.selectedViewsDigest !== protocol.publicReleaseDigest(selectedViews) || !same(existing.receipt.coverage, counts) ||
            existing.receipt.evidence.outputCount !== evidence.outputCount || existing.receipt.evidence.outputBytes !== evidence.outputBytes ||
            live.capturedAt < existing.receipt.qualifiedAt || live.capturedAt - existing.receipt.qualifiedAt > 60_000) throw new PairQualificationError("stale-qualification");
        return { idempotent: true, ...existing };
      }
      const receipt = parseQualificationReceipt({ schemaVersion: 2, kind: "private-pair-qualification", qualificationId,
        pairDigest: protocol.publicReleaseDigest(pair), readerContractDigest: pair.readerContractDigest, readerReceiptDigest: pair.readerReceiptDigest,
        capabilityDigest: pair.capabilityDigest, codeAssetManifestDigest: pack.codeAssetManifestDigest, witnessDigest,
        contentViewDigest: witness.contentViewDigest, codePackOverlayDigest: witness.codePackOverlayDigest,
        authorityDigest: live.digest, sealsDigest: live.sealsDigest, byteProofDigest: summary.byteProofDigest, namespaceProofDigest,
        catalogProofDigest: finalCatalog.catalogProofDigest, compositeProofDigest: finalComposite.compositeProofDigest, sourceCensusDigest, headViewDigest, sourceValidation,
        selectedViewsDigest: protocol.publicReleaseDigest(selectedViews), selectedViewCount: selectedViews.length,
        qualifiedAt: live.capturedAt, coverage: counts, evidence }, pair);
      transaction.create(firestore.doc(receiptPath), receipt);
      return { idempotent: false, receipt, digest: protocol.publicReleaseDigest(receipt) };
    });
  });
}
