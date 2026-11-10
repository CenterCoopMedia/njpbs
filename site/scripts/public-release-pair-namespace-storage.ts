import { createHash } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairTaskIdentity } from "../../functions/lib/public-release-pair-work";
import type { PairViewOutput } from "../../functions/lib/public-release-pair-view";
import type { PairOutputNamespaceKind } from "../../functions/lib/public-release-pair-namespace-proof";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import views from "../../functions/lib/public-release-pair-view.js";
import proofs from "../../functions/lib/public-release-pair-namespace-proof.js";
import baselineView from "../../functions/lib/public-release-pair-code-pack-view.js";
import search from "../../functions/lib/public-release-pair-search-namespace.js";
import feed from "../../functions/lib/public-release-pair-content-feed-namespace.js";
import { openPublicReleasePairInput } from "./public-release-pair-input-storage";
import { openStagedPublicReleasePairCodePack } from "./public-release-pair-code-pack-executor";
import { openPublicReleasePairViewMetadata, readPublicReleasePairClaimJson, type PairViewStore } from "./public-release-pair-view-storage";
import { assertPublicReleasePairSearchAuthority, PAIR_SEARCH_AUTHORITY_PACK_PATH, publicReleasePairSearchAuthorityBytes, PairSearchAuthorityError } from "./public-release-pair-search-authority";
import { assertPublicReleasePairContentFeedAuthority, PAIR_CONTENT_FEED_AUTHORITY_PACK_PATH, publicReleasePairContentFeedAuthorityBytes, PairContentFeedAuthorityError } from "./public-release-pair-content-feed-authority";
import { parsePublicReleasePairSearchInputs } from "./public-release-pair-search-inputs";
type Owner = { firestore: Firestore; store: PairViewStore; pair: PublicReleasePair; identity: PairTaskIdentity; claimDigest: string; viewManifestDigest: string; signal?: AbortSignal };
type Manifest = ReturnType<typeof search.parsePublicReleasePairSearchNamespace> | ReturnType<typeof feed.parsePublicReleasePairContentFeedNamespace>;
type Output = PairViewOutput & { body: Uint8Array };
const same = (a: unknown, b: unknown) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function refuse(): never { throw new work.PairExecutionError("byte-mismatch"); }
function json(bytes: Uint8Array) { try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return refuse(); } }
const config = (kind: PairOutputNamespaceKind) => kind === "search"
  ? { key: "search" as const, namespace: search.PAIR_SEARCH_NAMESPACE, parse: search.parsePublicReleasePairSearchNamespace,
    rootDigest: search.publicReleasePairSearchNamespaceRootDigest, manifestDigest: search.publicReleasePairSearchNamespaceManifestDigest }
  : { key: "contentFeed" as const, namespace: feed.PAIR_CONTENT_FEED_NAMESPACE, parse: feed.parsePublicReleasePairContentFeedNamespace,
    rootDigest: feed.publicReleasePairContentFeedNamespaceRootDigest, manifestDigest: feed.publicReleasePairContentFeedNamespaceManifestDigest };
async function metadata(owner: Owner) {
  const key = `${views.publicReleasePairViewPrefix(owner.pair, owner.identity, owner.claimDigest)}views/${owner.viewManifestDigest}.json`;
  owner.signal?.throwIfAborted();
  const object = await owner.store.get(key);
  if (!object) refuse();
  const manifestBytes = object.size; void object.body.cancel().catch(() => {});
  return openPublicReleasePairViewMetadata({ ...owner, manifestDigest: owner.viewManifestDigest, manifestBytes });
}
async function openOwnedFrozen(owner: Owner) {
  const scope = { kind: owner.identity.kind, sourceOperationId: owner.identity.sourceOperationId, sourceVersion: owner.identity.sourceVersion,
    snapshotDigest: owner.identity.snapshotDigest, contextSequence: owner.identity.contextSequence };
  const captured = await owner.firestore.runTransaction(transaction => work.assertPublicReleasePairInputOwnerInTransaction({ ...owner, transaction,
    scope, inputManifestDigest: owner.identity.inputManifestDigest }), { readOnly: true });
  if (!captured.receipt) refuse();
  return openPublicReleasePairInput({ ...owner, expectedSource: captured.receipt.source, expectedCursor: captured.receipt.cursor });
}
async function authority(owner: Owner) {
  const frozen = await openOwnedFrozen(owner);
  if (!frozen.root.entryFiles.includes("source-dependencies.json")) refuse();
  const source = json(await frozen.readFile("source-dependencies.json"));
  if (!same(source, { schemaVersion: 1 })) refuse();
  const pack = await openStagedPublicReleasePairCodePack(owner);
  try { assertPublicReleasePairSearchAuthority(pack.manifest, owner.pair); assertPublicReleasePairContentFeedAuthority(pack.manifest, owner.pair); }
  catch (error) { if (error instanceof PairSearchAuthorityError || error instanceof PairContentFeedAuthorityError) refuse(); throw error; }
  const expectedSearch = publicReleasePairSearchAuthorityBytes(owner.pair.commitSha), expectedFeed = publicReleasePairContentFeedAuthorityBytes(owner.pair.commitSha);
  if (hash(await pack.readMember(PAIR_SEARCH_AUTHORITY_PACK_PATH)) !== hash(expectedSearch) ||
      hash(await pack.readMember(PAIR_CONTENT_FEED_AUTHORITY_PACK_PATH)) !== hash(expectedFeed) ||
      !same(json(await frozen.readFile("code-pack-baseline.json")), pack.receipt) ||
      hash(await frozen.readFile("code-pack.json")) !== pack.receipt.codePackManifestDigest) refuse();
  const baseline = json(await frozen.readFile("baseline.json")), census = json(await frozen.readFile("source-census.json"));
  let searchInputs: ReturnType<typeof parsePublicReleasePairSearchInputs>;
  const searchBytes = await frozen.readFile("search-inputs.json");
  try { searchInputs = parsePublicReleasePairSearchInputs(json(searchBytes), {
    cursor: frozen.root.cursor, logBaselineDigest: baseline.logBaselineDigest,
    entryDigest: frozen.root.cursor.sequence === 0 ? null : frozen.root.cursor.lastDigest }); }
  catch { return refuse(); }
  const code = json(await frozen.readFile("code-source.json"));
  const provider = frozen.root.files.some(file => file.name === "provider-inputs.json") ? json(await frozen.readFile("provider-inputs.json")) : null;
  if (census.schemaVersion !== 1 || census.kind !== "pair-public-source-census" || !Array.isArray(census.documents) || !same(census.cursor, frozen.root.cursor) ||
      !same(census.documents.map(({ path, contentDigest }: { path: string; contentDigest: string }) => ({ path, contentDigest })), searchInputs.projection.documents) ||
      !same(searchInputs.projection.codeSource, { sha256: code.sha256, reference: code.reference }) ||
      !same(searchInputs.projection.providerInputs, { externalInputs: provider?.externalInputs ?? null, retainedHome: provider?.retainedHome ?? null,
        files: (provider?.files ?? []).map(({ name, digest, bytes, contentType }: { name: string; digest: string; bytes: number; contentType: string }) => ({ name, digest, bytes, contentType }))
          .sort((a: { name: string }, b: { name: string }) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) })) refuse();
  const censusFile = frozen.root.files.find(file => file.name === "source-census.json"); if (!censusFile) refuse();
  const common = { baselineInputManifestDigest: pack.receipt.inputManifestDigest, baselineCodePackManifestDigest: pack.receipt.codePackManifestDigest,
    baselineViewManifestDigest: pack.record.viewManifestDigest, codeAssetManifestDigest: owner.pair.codeAssetManifestDigest,
    sourceCensusDigest: censusFile.digest, searchInputDigest: searchInputs.searchInputDigest };
  return { frozen, pack, searchInputs, searchAuthority: { ...common, namespaceAuthorityDigest: hash(expectedSearch) },
    contentFeedAuthority: { ...common, namespaceAuthorityDigest: hash(expectedFeed) } };
}
async function openManifest(owner: Owner, meta: Awaited<ReturnType<typeof metadata>>, kind: PairOutputNamespaceKind) {
  const codec = config(kind), link = meta.root.namespaces?.[codec.key];
  if (!link || link.namespace !== codec.namespace) refuse();
  const manifest = codec.parse(await readPublicReleasePairClaimJson({ ...owner, descriptor: link.descriptor, limit: views.BODY_BYTES_LIMIT }), owner.pair, owner.identity, meta.root.cursor);
  if (link.namespaceRootDigest !== codec.rootDigest(manifest.members) || link.descriptor.digest !== codec.manifestDigest(manifest, owner.pair, owner.identity, meta.root.cursor)) refuse();
  return { manifest, link };
}
function rowMatches(output: PairViewOutput, member: Manifest["members"][number], owner: Owner) {
  if (output.path !== member.path || output.status !== 200 || output.bodyDigest !== member.sha256 || output.bytes !== member.size ||
      output.headers["content-type"] !== member.mime || output.headers["x-njpbs-renderer-sha"] !== owner.pair.commitSha) refuse();
}
/** Compose this verifier with the route verifier during G's single full byte
 * pass. Both namespaces are complete replacements at the original H cursor. */
export async function preparePublicReleasePairNamespacesReadback(owner: Owner) {
  const meta = await metadata(owner), source = await authority(owner);
  const selectedSearch = await openManifest(owner, meta, "search"), selectedFeed = await openManifest(owner, meta, "content-feed");
  const searchManifest = selectedSearch.manifest, feedManifest = selectedFeed.manifest as ReturnType<typeof feed.parsePublicReleasePairContentFeedNamespace>;
  let searchIndex = 0, feedIndex = 0, indexSeen = false, complete = false;
  let actualIndex: ReturnType<typeof feed.assertPublicReleasePairContentFeedIndex> | undefined;
  return {
    async output(output: Output) {
      if (output.path.startsWith(search.PAIR_SEARCH_NAMESPACE)) {
        const expected = searchManifest.members[searchIndex++]; if (!expected) refuse(); rowMatches(output, expected, owner);
      } else if (output.path === feed.PAIR_CONTENT_FEED_INDEX) {
        if (indexSeen) refuse(); rowMatches(output, feedManifest.index, owner);
        actualIndex = feed.assertPublicReleasePairContentFeedIndex(output.body, feedManifest); indexSeen = true;
      } else if (output.path.startsWith(feed.PAIR_CONTENT_FEED_NAMESPACE)) {
        const expected = feedManifest.members[feedIndex++]; if (!expected || !actualIndex) refuse(); rowMatches(output, expected, owner);
        feed.assertPublicReleasePairContentFeedPage(output.body, output.path, feedManifest, actualIndex);
      }
    },
    async complete() {
      if (searchIndex !== searchManifest.members.length || feedIndex !== feedManifest.members.length || !indexSeen) refuse(); complete = true;
    },
    async persist(staged: { readbackDigest: string }) {
      if (!complete) refuse();
      const records = (["search", "content-feed"] as const).map(kind => {
        const selected = kind === "search" ? selectedSearch : selectedFeed, codec = config(kind);
        return proofs.parsePublicReleasePairNamespaceProof({ schemaVersion: 1,
          kind: kind === "search" ? "pair-search-namespace-proof" : "pair-content-feed-namespace-proof", status: "staged",
          pairDigest: protocol.publicReleaseDigest(owner.pair), taskId: protocol.publicReleaseDigest(owner.identity), identity: owner.identity,
          claimDigest: owner.claimDigest, viewManifestDigest: owner.viewManifestDigest, viewReadbackDigest: staged.readbackDigest,
          inputManifestDigest: owner.identity.inputManifestDigest, namespace: codec.namespace, cursor: source.frozen.root.cursor,
          namespaceRootDigest: selected.link.namespaceRootDigest, namespaceManifestDigest: selected.link.descriptor.digest,
          descriptor: selected.link.descriptor, memberCount: selected.manifest.members.length,
          memberBytes: selected.manifest.members.reduce((sum, member) => sum + member.size, 0),
          authority: kind === "search" ? source.searchAuthority : source.contentFeedAuthority }, owner.pair, owner.identity, owner.claimDigest, owner.viewManifestDigest, kind);
      });
      await owner.firestore.runTransaction(async transaction => {
        await work.assertPublicReleasePairCompletedReceiptInTransaction({ ...owner, transaction, taskId: protocol.publicReleaseDigest(owner.identity), manifestDigest: owner.viewManifestDigest });
        const viewRow = await transaction.get(owner.firestore.doc(`${work.publicReleasePairPath(owner.pair.pairId)}/views/${owner.viewManifestDigest}`));
        if (viewRow.data()?.readbackDigest !== staged.readbackDigest || viewRow.data()?.status !== "staged" || viewRow.data()?.claimDigest !== owner.claimDigest) refuse();
        const refs = (["search", "content-feed"] as const).map(kind => owner.firestore.doc(proofs.publicReleasePairNamespaceProofPath(owner.pair, owner.viewManifestDigest, kind)));
        const before = await transaction.getAll(...refs);
        const baseline = await baselineView.assertReadPublicReleasePairStagedCodePackInTransaction({ ...owner, transaction });
        if (baseline.viewManifestDigest !== source.pack.record.viewManifestDigest || baseline.inputManifestDigest !== source.pack.receipt.inputManifestDigest) refuse();
        owner.signal?.throwIfAborted();
        for (let index = 0; index < records.length; index++) {
          if (before[index].exists) { if (!same(before[index].data(), records[index])) refuse(); }
          else transaction.create(refs[index], records[index]);
        }
      });
      return records;
    },
  };
}
export type PairNamespaceMemberRead = Readonly<{ kind: "member"; member: Manifest["members"][number]; body: Uint8Array }> |
  Readonly<{ kind: "absent"; path: string; namespace: "/pagefind/" | "/api/v1/content/" }>;
async function openStagedNamespace(owner: Owner, kind: PairOutputNamespaceKind) {
  const proof = proofs.parsePublicReleasePairNamespaceProof((await owner.firestore.doc(proofs.publicReleasePairNamespaceProofPath(owner.pair, owner.viewManifestDigest, kind)).get()).data(),
    owner.pair, owner.identity, owner.claimDigest, owner.viewManifestDigest, kind);
  const meta = await metadata(owner), selected = await openManifest(owner, meta, kind), source = await authority(owner), codec = config(kind);
  if (!same(proof.descriptor, selected.link.descriptor) || proof.namespaceRootDigest !== selected.link.namespaceRootDigest ||
      !same(proof.authority, kind === "search" ? source.searchAuthority : source.contentFeedAuthority)) refuse();
  await owner.firestore.runTransaction(transaction => proofs.assertReadPublicReleasePairNamespaceInTransaction({ ...owner, transaction,
    manifest: selected.manifest, namespaceRootDigest: selected.link.namespaceRootDigest, namespaceManifestDigest: selected.link.descriptor.digest, kind }), { readOnly: true });
  const members = new Map(selected.manifest.members.map(member => [member.path, member]));
  const feedManifest = kind === "content-feed" ? selected.manifest as ReturnType<typeof feed.parsePublicReleasePairContentFeedNamespace> : null;
  let actualIndex: ReturnType<typeof feed.assertPublicReleasePairContentFeedIndex> | undefined;
  if (feedManifest) {
    const index = await meta.readBody(feed.PAIR_CONTENT_FEED_INDEX); rowMatches(index, feedManifest.index, owner);
    actualIndex = feed.assertPublicReleasePairContentFeedIndex(index.body, feedManifest);
  } else {
    const entry = selected.manifest.members.find(member => member.path === "/pagefind/pagefind-entry.json"); if (!entry) refuse();
    const output = await meta.readBody(entry.path); rowMatches(output, entry, owner); json(output.body);
  }
  const readMember = async (path: string): Promise<PairNamespaceMemberRead> => {
    owner.signal?.throwIfAborted();
    if (!views.isPrivatePairArtifactPath(path) || !path.startsWith(codec.namespace) ||
        kind === "content-feed" && !feed.isPublicReleasePairContentFeedPagePath(path)) refuse();
    const member = members.get(path);
    if (!member) return { kind: "absent", path, namespace: codec.namespace };
    const row = await meta.output(path); if (!row) refuse(); rowMatches(row, member, owner);
    const output = await meta.readBody(path);
    if (feedManifest && actualIndex) feed.assertPublicReleasePairContentFeedPage(output.body, path, feedManifest, actualIndex);
    return { kind: "member", member, body: output.body };
  };
  return { proof, record: proof, manifest: selected.manifest, namespaceRootDigest: proof.namespaceRootDigest, namespaceManifestDigest: proof.namespaceManifestDigest,
    readMember, async verifyAll() { for (const member of selected.manifest.members) if ((await readMember(member.path)).kind !== "member") refuse(); } };
}
export async function openStagedPublicReleasePairSearchNamespace(owner: Owner) {
  const opened = await openStagedNamespace(owner, "search");
  const proof = search.parsePublicReleasePairSearchNamespaceProof(opened.proof, owner.pair, owner.identity, owner.claimDigest, owner.viewManifestDigest);
  return { ...opened, proof, record: proof, manifest: search.parsePublicReleasePairSearchNamespace(opened.manifest, owner.pair, owner.identity) };
}
export async function openStagedPublicReleasePairContentFeedNamespace(owner: Owner) {
  const opened = await openStagedNamespace(owner, "content-feed");
  const proof = feed.parsePublicReleasePairContentFeedNamespaceProof(opened.proof, owner.pair, owner.identity, owner.claimDigest, owner.viewManifestDigest);
  return { ...opened, proof, record: proof, manifest: feed.parsePublicReleasePairContentFeedNamespace(opened.manifest, owner.pair, owner.identity) };
}

/** Baseline selections retain their actual code-pack owner and receipt. They
 * do not invent an incremental namespace proof or retag the producing cursor. */
async function openStagedCodePackNamespace(owner: Owner, kind: PairOutputNamespaceKind) {
  const pack = await openStagedPublicReleasePairCodePack(owner), codec = config(kind);
  if (!same(pack.record.identity, owner.identity) || pack.record.claimDigest !== owner.claimDigest || pack.record.viewManifestDigest !== owner.viewManifestDigest) refuse();
  const markerPath = kind === "search" ? PAIR_SEARCH_AUTHORITY_PACK_PATH : PAIR_CONTENT_FEED_AUTHORITY_PACK_PATH;
  const marker = kind === "search" ? publicReleasePairSearchAuthorityBytes(owner.pair.commitSha) : publicReleasePairContentFeedAuthorityBytes(owner.pair.commitSha);
  if (kind === "search") assertPublicReleasePairSearchAuthority(pack.manifest, owner.pair);
  else assertPublicReleasePairContentFeedAuthority(pack.manifest, owner.pair);
  if (hash(await pack.readMember(markerPath)) !== hash(marker)) refuse();
  const members = pack.manifest.members.filter(member => member.path.startsWith(codec.namespace))
    .map(member => ({ path: member.path, mime: member.mime, size: member.size, sha256: member.sha256 }));
  const common = { schemaVersion: 1, pairDigest: protocol.publicReleaseDigest(owner.pair), inputManifestDigest: owner.identity.inputManifestDigest,
    cursor: pack.record.cursor, members };
  let manifest: Manifest, actualIndex: ReturnType<typeof feed.assertPublicReleasePairContentFeedIndex> | undefined;
  if (kind === "search") {
    manifest = search.parsePublicReleasePairSearchNamespace({ ...common, kind: "pair-search-namespace", namespace: codec.namespace }, owner.pair, owner.identity);
    json(await pack.readMember("/pagefind/pagefind-entry.json"));
  } else {
    const index = pack.manifest.members.find(member => member.path === feed.PAIR_CONTENT_FEED_INDEX); if (!index) refuse();
    manifest = feed.parsePublicReleasePairContentFeedNamespace({ ...common, kind: "pair-content-feed-namespace", namespace: codec.namespace,
      index: { path: index.path, mime: index.mime, size: index.size, sha256: index.sha256, pageCount: members.length } }, owner.pair, owner.identity);
    actualIndex = feed.assertPublicReleasePairContentFeedIndex(await pack.readMember(index.path), manifest);
  }
  const selected = new Map(manifest.members.map(member => [member.path, member]));
  const readMember = async (path: string): Promise<PairNamespaceMemberRead> => {
    owner.signal?.throwIfAborted();
    if (!views.isPrivatePairArtifactPath(path) || !path.startsWith(codec.namespace) || kind === "content-feed" && !feed.isPublicReleasePairContentFeedPagePath(path)) refuse();
    const member = selected.get(path); if (!member) return { kind: "absent", path, namespace: codec.namespace };
    const body = await pack.readMember(path);
    if (kind === "content-feed" && actualIndex) feed.assertPublicReleasePairContentFeedPage(body, path, manifest as ReturnType<typeof feed.parsePublicReleasePairContentFeedNamespace>, actualIndex);
    return { kind: "member", member, body };
  };
  return { record: pack.record, baseline: pack.record, manifest, namespaceRootDigest: codec.rootDigest(manifest.members),
    namespaceManifestDigest: codec.manifestDigest(manifest, owner.pair, owner.identity), readMember,
    async verifyAll() { for (const member of manifest.members) if ((await readMember(member.path)).kind !== "member") refuse(); } };
}
export async function openStagedPublicReleasePairCodePackSearchNamespace(owner: Owner) {
  const opened = await openStagedCodePackNamespace(owner, "search");
  return { ...opened, manifest: search.parsePublicReleasePairSearchNamespace(opened.manifest, owner.pair, owner.identity) };
}
export async function openStagedPublicReleasePairCodePackContentFeedNamespace(owner: Owner) {
  const opened = await openStagedCodePackNamespace(owner, "content-feed");
  return { ...opened, manifest: feed.parsePublicReleasePairContentFeedNamespace(opened.manifest, owner.pair, owner.identity) };
}
/** Dispatch only from the verified original H root. A failed descriptor or
 * body read never falls through into a different selection or baseline. */
export async function openPublicReleasePairSearchNamespaceSelection(owner: Owner) {
  const frozen = await openOwnedFrozen(owner);
  return frozen.root.entryFiles.includes("code-pack.json")
    ? { selectionKind: "code-pack" as const, ...await openStagedPublicReleasePairCodePackSearchNamespace(owner) }
    : { selectionKind: "namespace" as const, ...await openStagedPublicReleasePairSearchNamespace(owner) };
}
export async function openPublicReleasePairContentFeedNamespaceSelection(owner: Owner) {
  const frozen = await openOwnedFrozen(owner);
  return frozen.root.entryFiles.includes("code-pack.json")
    ? { selectionKind: "code-pack" as const, ...await openStagedPublicReleasePairCodePackContentFeedNamespace(owner) }
    : { selectionKind: "namespace" as const, ...await openStagedPublicReleasePairContentFeedNamespace(owner) };
}
