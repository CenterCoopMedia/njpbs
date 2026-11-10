import { PAIR_STATIC_SOURCE_FILE } from "./public-release-pair-static-source";
import { openPublicReleasePairStaticSourceInputs } from "./public-release-pair-static-source-storage";
import { readPublicReleasePairStaticTargetClaim, preparePublicReleasePairStaticTargetReadback } from "./public-release-pair-static-target-storage";
import { createHash } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairTaskIdentity } from "../../functions/lib/public-release-pair-work";
import type { PairInputRoot } from "../../functions/lib/public-release-pair-input";
import { derivePublicReleasePairAuthors, assertPublicReleasePairAuthorRoster } from "./public-release-pair-author";
import type { PairViewOutput } from "../../functions/lib/public-release-pair-view";
import type { PairCompositeMember, PairCompositeAuthority, PairCompositeManifest } from "../../functions/lib/public-release-pair-composite-view";
import codec from "../../functions/lib/public-release-pair-composite-view.js";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import view from "../../functions/lib/public-release-pair-view.js";
import { openPublicReleasePairReplayContext, preparePublicReleasePairReplayReadback } from "./public-release-pair-replay-storage";
import { preparePublicReleasePairNamespacesReadback } from "./public-release-pair-namespace-storage";
import { preparePublicReleasePairCatalogImagesReadback } from "./public-release-pair-catalog-image-storage";
import { openStagedPublicReleasePairCodePack } from "./public-release-pair-code-pack-executor";
import { openPublicReleasePairViewMetadata, readPublicReleasePairClaimJson, type PairViewStore } from "./public-release-pair-view-storage";
import { parsePublicReleasePairSearchInputs } from "./public-release-pair-search-inputs";
import { stagePublicReleasePairView } from "./public-release-pair-view-staging";
type Owner = { firestore: Firestore; store: PairViewStore; pair: PublicReleasePair; identity: PairTaskIdentity;
  claimDigest: string; viewManifestDigest: string; signal?: AbortSignal };
type Output = PairViewOutput & { body: Uint8Array };
const same = (a: unknown, b: unknown) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
function refuse(): never { throw new work.PairExecutionError("byte-mismatch"); }
const json = (bytes: Uint8Array) => { try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return refuse(); } };
export const publicReleasePairCompositeSourceDependencyDigest = (root: PairInputRoot) => protocol.publicReleaseDigest(root.files.map(file => ({ name: file.name, digest: file.digest, bytes: file.bytes })));
// Each opener owns its own read-only snapshot. Neither value feeds the other.
// Await both and preserve the former sequential error precedence.
async function independentReads<A, B>(first: Promise<A>, second: Promise<B>) {
  const results = await Promise.allSettled([first, second] as const);
  if (results[0].status === "rejected") throw results[0].reason;
  if (results[1].status === "rejected") throw results[1].reason;
  return [results[0].value, results[1].value] as const;
}
/** Actual original H and staged NEW baseline, shared by executor and consumers. */
export async function openPublicReleasePairCompositeAuthority(owner: Pick<Owner, "firestore" | "store" | "pair" | "identity" | "signal">) {
  const [captured, baseline] = await independentReads(openPublicReleasePairReplayContext(owner), openStagedPublicReleasePairCodePack(owner));
  const sourceCensus = captured.frozen.root.files.find(file => file.name === "source-census.json");
  if (!sourceCensus || !captured.frozen.root.entryFiles.includes("source-dependencies.json") ||
      !same(json(await captured.frozen.readFile("source-dependencies.json")), { schemaVersion: 1 }) ||
      !same(json(await captured.frozen.readFile("code-pack-baseline.json")), baseline.receipt) ||
      createHash("sha256").update(await captured.frozen.readFile("code-pack.json")).digest("hex") !== baseline.receipt.codePackManifestDigest) refuse();
  const census = json(await captured.frozen.readFile("source-census.json")), search = parsePublicReleasePairSearchInputs(json(await captured.frozen.readFile("search-inputs.json")),
    { cursor: captured.frozen.root.cursor, logBaselineDigest: census.baseline?.logBaselineDigest,
      entryDigest: captured.frozen.root.cursor.sequence === 0 ? null : captured.frozen.root.cursor.lastDigest });
  const authority: PairCompositeAuthority = { baselineInputManifestDigest: baseline.receipt.inputManifestDigest,
    baselineCodePackManifestDigest: baseline.receipt.codePackManifestDigest, baselineViewManifestDigest: baseline.record.viewManifestDigest,
    codeAssetManifestDigest: owner.pair.codeAssetManifestDigest, sourceDependencyDigest: publicReleasePairCompositeSourceDependencyDigest(captured.frozen.root),
    sourceCensusDigest: sourceCensus.digest, searchInputDigest: search.searchInputDigest };
  const staticSource = captured.frozen.root.files.some(file => file.name === PAIR_STATIC_SOURCE_FILE)
    ? await openPublicReleasePairStaticSourceInputs(captured.frozen.root, captured.frozen.readFile) : null;
  if (staticSource && !staticSource.source) refuse();
  return { ...captured, baseline, authority, staticSource };
}
async function metadata(owner: Owner) {
  const object = await owner.store.get(`${view.publicReleasePairViewPrefix(owner.pair, owner.identity, owner.claimDigest)}views/${owner.viewManifestDigest}.json`);
  if (!object) refuse(); const bytes = object.size; void object.body.cancel().catch(() => {});
  return openPublicReleasePairViewMetadata({ ...owner, manifestDigest: owner.viewManifestDigest, manifestBytes: bytes });
}
function checkOutput(output: PairViewOutput, member: PairCompositeMember, owner: Owner) {
  if (output.path !== member.path || output.status !== member.status || output.headers["content-type"] !== member.mime ||
      output.headers["x-njpbs-renderer-sha"] !== owner.pair.commitSha || output.bytes !== member.size || output.bodyDigest !== member.sha256) refuse();
  if (member.kind === "author" && member.role === "auxiliary" && (output.status === 308
    ? output.headers.location !== member.owner!.canonicalPath : output.headers.location !== undefined)) refuse();
}
async function openManifest(owner: Owner, verifyAuthorSource = false) {
  const [meta, source] = await independentReads(metadata(owner), openPublicReleasePairCompositeAuthority(owner));
  const link = meta.root.composite;
  if (!link) refuse();
  const manifest = codec.parsePublicReleasePairCompositeManifest(await readPublicReleasePairClaimJson({ ...owner, descriptor: link.descriptor, limit: view.BODY_BYTES_LIMIT }),
    owner.pair, owner.identity, source.frozen.root.cursor);
  const { staticTargetDigest, ...sourceAuthority } = manifest.authority;
  if (!same(sourceAuthority, source.authority)) refuse();
  if (source.staticSource?.source) {
    if (!staticTargetDigest) refuse();
    const target = await readPublicReleasePairStaticTargetClaim(owner, source.staticSource.source, staticTargetDigest);
    for (const alias of target.aliases) await alias.read();
  } else if (staticTargetDigest !== undefined) refuse();
  if (link.memberCount !== manifest.members.length || link.memberBytes !== manifest.members.reduce((sum, member) => sum + member.size, 0) ||
      meta.root.outputCount !== link.memberCount || meta.root.outputBytes !== link.memberBytes) refuse();
  const routes = new Map(source.plan.routes.map((route, index) => [route.path, { route, output: source.plan.expectedOutputs[index] }]));
  const baseline = new Map(source.baseline.manifest.members.map(member => [member.path, member]));
  let routeCount = 0;
  for (const member of manifest.members) {
    const expected = routes.get(member.path);
    if (member.role === "route") {
      if (!expected || member.kind !== expected.route.renderer || member.status !== expected.output.status || member.mime !== expected.output.contentType) refuse();
      routeCount++;
    } else {
      if (expected) refuse();
      if (member.role === "auxiliary") {
        if (member.kind === "author") {
          if (!member.owner || member.owner.sourceCensusDigest !== source.authority.sourceCensusDigest ||
              member.owner.readerProvenanceDigest !== source.frozen.root.files.find(file => file.name === "reader-provenance.json")?.digest) refuse();
          continue;
        }
        const original = baseline.get(member.path);
        if (!original || !original.dynamic || original.source !== "aggregate" || codec.publicReleasePairCompositeAuxiliaryKind(member.path) !== member.kind) refuse();
      }
    }
  }
  // Full raw-H reconstruction happens once during staging. Subsequent private
  // readers require the immutable staged proof for this exact manifest; they
  // do not repeat every source-body read for each requested author page.
  if (verifyAuthorSource) {
    const authors = await derivePublicReleasePairAuthors({ pair: owner.pair, identity: owner.identity, root: source.frozen.root, readFrozenFile: source.frozen.readFile });
    assertPublicReleasePairAuthorRoster(manifest.members.filter(member => member.role === "auxiliary" && member.kind === "author"), authors.routes);
  }
  const declared = new Map(manifest.members.map(member => [member.path, member]));
  for (const original of baseline.values()) if (original.dynamic && !original.path.startsWith("/pagefind/") && !original.path.startsWith("/api/v1/content/")) {
    const expected = declared.get(original.path);
    if (!expected || (routes.has(original.path) ? expected.role !== "route" :
      expected.role !== "auxiliary" || codec.publicReleasePairCompositeAuxiliaryKind(original.path) !== expected.kind)) refuse();
  }
  if (routeCount !== routes.size || !meta.root.namespaces || !meta.root.catalogImages) refuse();
  return { meta, source, manifest, link, routeCount };
}
/** Single G body pass: every row has one explicit role. Extra, missing,
 * duplicate or misclassified outputs refuse before any final proof persists. */
export async function preparePublicReleasePairCompositeReadback(owner: Owner) {
  // These independent read-only openers each retain their original authority
  // checks. Await all of them, even on failure, before returning or cleanup.
  const [[selected, routes], [namespaces, catalog]] = await independentReads(
    independentReads(openManifest(owner, true), preparePublicReleasePairReplayReadback(owner)),
    independentReads(preparePublicReleasePairNamespacesReadback(owner), preparePublicReleasePairCatalogImagesReadback(owner)));
  const staticProof = selected.source.staticSource ? await preparePublicReleasePairStaticTargetReadback(owner,
    selected.source.frozen, selected.source.baseline, selected.source.plan.renderedAt, selected.manifest.authority.staticTargetDigest) : null;
  let index = 0, complete = false, semanticBytes: Uint8Array | undefined;
  return {
    manifest: selected.manifest,
    async output(output: Output) {
      const member = selected.manifest.members[index++]; if (!member) refuse(); checkOutput(output, member, owner);
      if (member.kind === "semantic") semanticBytes = new Uint8Array(output.body);
      if (member.role === "route") await routes.output(output);
      await namespaces.output(output); await catalog.output(output); await staticProof?.output(output);
    },
    async complete() {
      if (index !== selected.manifest.members.length) refuse();
      await routes.complete(); await namespaces.complete(); await catalog.complete(); await staticProof?.complete(); complete = true;
    },
    async persist(staged: { readbackDigest: string; outputCount: number; outputBytes: number }) {
      if (!complete || staged.outputCount !== selected.manifest.members.length || staged.outputBytes !== selected.link.memberBytes) refuse();
      await staticProof?.persist(staged);
      const proof = codec.parsePublicReleasePairCompositeProof({ schemaVersion: 1, kind: "pair-composite-proof", status: "staged",
        pairDigest: protocol.publicReleaseDigest(owner.pair), taskId: protocol.publicReleaseDigest(owner.identity), identity: owner.identity, claimDigest: owner.claimDigest,
        viewManifestDigest: owner.viewManifestDigest, viewReadbackDigest: staged.readbackDigest, inputManifestDigest: owner.identity.inputManifestDigest,
        snapshotDigest: owner.identity.snapshotDigest, cursor: selected.manifest.cursor, descriptor: selected.link.descriptor,
        outputCount: staged.outputCount, outputBytes: staged.outputBytes, routeCount: selected.routeCount, authority: selected.manifest.authority },
      owner.pair, owner.identity, owner.claimDigest, owner.viewManifestDigest);
      await owner.firestore.runTransaction(async transaction => {
        await work.assertPublicReleasePairCompletedReceiptInTransaction({ ...owner, transaction, taskId: proof.taskId, manifestDigest: owner.viewManifestDigest });
        const ref = owner.firestore.doc(codec.publicReleasePairCompositeProofPath(owner.pair, owner.viewManifestDigest));
        const [before, actual] = await transaction.getAll(ref, owner.firestore.doc(`${work.publicReleasePairPath(owner.pair.pairId)}/views/${owner.viewManifestDigest}`));
        const row = actual.data();
        if (row?.status !== "staged" || row.readbackDigest !== proof.viewReadbackDigest || row.claimDigest !== owner.claimDigest || !same(row.identity, owner.identity) ||
            row.outputCount !== proof.outputCount || row.outputBytes !== proof.outputBytes) refuse();
        owner.signal?.throwIfAborted();
        if (before.exists) { if (!same(before.data(), proof)) refuse(); } else transaction.create(ref, proof);
      });
      await namespaces.persist(staged); await catalog.persist(staged); await routes.persist();
      return proof;
    },
    dispose: async () => { await staticProof?.dispose(); },
    get semanticBytes() { if (!complete) refuse(); return semanticBytes; },
  };
}
/** Original completion receipt is mandatory. Retrying resumes this readback;
 * it does not claim, render, settle, or relabel the immutable pack again. */
export async function stagePublicReleasePairComposite(owner: Owner) {
  const verifier = await preparePublicReleasePairCompositeReadback(owner);
  try {
    const staged = await stagePublicReleasePairView({ ...owner, manifestDigest: owner.viewManifestDigest, verify: verifier });
    return { staged, proof: await verifier.persist(staged.record), semanticBytes: verifier.semanticBytes };
  } finally { await verifier.dispose(); }
}
/** Metadata/opened ownership is not a new full-byte observation. Only listed
 * outputs may be read; missing/corrupt declared bodies always throw. */
export async function openStagedPublicReleasePairComposite(owner: Owner) {
  const selected = await openManifest(owner);
  const proof = await owner.firestore.runTransaction(transaction => codec.assertReadPublicReleasePairCompositeInTransaction({ ...owner, transaction,
    manifest: selected.manifest, manifestDigest: selected.link.descriptor.digest }), { readOnly: true });
  const members = new Map(selected.manifest.members.map(member => [member.path, member]));
  const readMember = async (path: string) => {
    const member = members.get(path); if (!member) refuse();
    const row = await selected.meta.readBody(path); checkOutput(row, member, owner);
    return { member, body: row.body };
  };
  return { record: proof, proof, manifest: selected.manifest, ordinaryPlan: selected.source.ordinaryPlan,
    aggregatePlan: selected.source.aggregatePlan, plan: selected.source.plan, readMember,
    async verifyAll() { for (const member of selected.manifest.members) await readMember(member.path); } };
}
