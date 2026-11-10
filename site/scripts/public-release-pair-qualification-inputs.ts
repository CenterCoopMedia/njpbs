import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { Firestore } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairInputReceipt } from "../../functions/lib/public-release-pair-input";
import protocol from "../../functions/lib/public-release-pair.js";
import input from "../../functions/lib/public-release-pair-input.js";
import view from "../../functions/lib/public-release-pair-view.js";
import { openPublicReleasePairInput } from "./public-release-pair-input-storage";
import { PAIR_CODE_PACK_FILE, PAIR_COMPILED_PREFIX, parsePublicReleasePairCodePack } from "./public-release-pair-code-pack";
import { canonicalPath } from "./public-release-pair-reader-contract";
import { PairQualificationError, type QualificationRoute, QUALIFICATION_ROUTE_LIMIT } from "./public-release-pair-qualification-authority";
import type { QualificationView } from "./public-release-pair-qualification-bytes";
import type { PairViewStore } from "./public-release-pair-view-storage";

/** The replay owner supplies the original receipt it revalidated against the
 * immutable baseline/member proof. Never derive expected source/cursor from a
 * new root's self-claims, or recover missing input from mutable latest data. */
export async function openQualificationInput({ firestore, store, pair, reference, captured, signal }: {
  firestore: Firestore; store: PairViewStore; pair: PublicReleasePair; reference: QualificationView;
  captured: PairInputReceipt; signal: AbortSignal;
}) {
  const identity = view.parseViewIdentity(reference.identity, pair);
  const scope = input.parsePublicReleasePairInputScope({ kind: identity.kind, sourceOperationId: identity.sourceOperationId,
    sourceVersion: identity.sourceVersion, snapshotDigest: identity.snapshotDigest, contextSequence: identity.contextSequence });
  const receipt = input.parsePublicReleasePairInputReceipt(captured, pair, scope, identity.inputManifestDigest);
  const frozen = await openPublicReleasePairInput({ firestore, store, pair, identity, expectedSource: receipt.source, expectedCursor: receipt.cursor, signal });
  // A retained receipt cannot substitute for missing immutable dependencies.
  // Exhaust the original closure without retaining all file bodies in memory.
  for (let offset = 0; offset < frozen.root.files.length; offset += 4) {
    signal.throwIfAborted();
    const batch = await Promise.allSettled(frozen.root.files.slice(offset, offset + 4).map(file => frozen.readFile(file.name)));
    const failure = batch.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
  return frozen;
}
export async function readQualificationCodePack(options: Parameters<typeof openQualificationInput>[0]) {
  const frozen = await openQualificationInput(options);
  if (!frozen.root.files.some(file => file.name === PAIR_CODE_PACK_FILE)) throw new PairQualificationError("incomplete-code-pack");
  const bytes = await frozen.readFile(PAIR_CODE_PACK_FILE);
  const pack = parsePublicReleasePairCodePack(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), options.pair);
  if (pack.members.find(member => member.path === `${PAIR_COMPILED_PREFIX}pair-renderer-release.json`)?.sha256 !== options.pair.rendererDigest) {
    throw new PairQualificationError("incomplete-code-pack");
  }
  // Require the full inventory to fit both the actual G codec and private
  // transport. This follows codec upgrades without silently dropping a member.
  try {
    for (const member of pack.members) {
      if (!canonicalPath(member.path)) throw new Error("Unsupported private path");
      view.parsePublicReleasePairViewOutput({ path: member.path, status: 200,
        headers: { "content-type": member.mime, "cache-control": "no-store" }, bodyDigest: member.sha256, bytes: member.size,
        objectKey: view.publicReleasePairViewObjectKey(options.pair, options.reference.identity, options.reference.claimDigest, member.sha256) },
        options.pair, options.reference.identity, options.reference.claimDigest);
    }
  } catch { throw new PairQualificationError("incomplete-code-pack"); }
  return Object.freeze({ pack, frozen });
}

/** The live census is also a backstop for an omitted producer. Bind each owned
 * route to the original published snapshot in this selected view's H, rather
 * than accepting a matching path/status under a stale source version. */
export async function assertQualificationOwnedSnapshots(frozen: Awaited<ReturnType<typeof openQualificationInput>>,
  routes: readonly QualificationRoute[]) {
  const wanted = new Map(routes.filter(route => route.snapshotDigest !== null).map(route =>
    [`${route.kind === "page" ? "cmsPages" : "cmsPosts"}/${route.ownerId}`, route]));
  if (!wanted.size) return;
  const refuse = (): never => { throw new PairQualificationError("coverage-mismatch"); };
  const census = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await frozen.readFile("source-census.json")));
  if (census?.schemaVersion !== 1 || census.kind !== "pair-public-source-census" ||
      !Array.isArray(census.documents) || census.documents.length > QUALIFICATION_ROUTE_LIMIT ||
      protocol.publicReleaseDigest(census.cursor) !== protocol.publicReleaseDigest(frozen.root.cursor)) refuse();
  const members = new Map<string, { contentDigest: string; bodyFile: string }>();
  for (const member of census.documents) {
    if (!member || typeof member.path !== "string" || members.has(member.path) || !/^[a-f0-9]{64}$/.test(member.contentDigest) ||
        member.bodyFile !== `sources/${member.contentDigest}.json`) refuse();
    members.set(member.path, member);
  }
  const require = createRequire(import.meta.url), { digest } = require("../../functions/lib/no-build-page-ownership.js"),
    { publiclyVisible } = require("../../functions/lib/public-video-references.js");
  const check = async ([path, route]: [string, QualificationRoute]) => {
    const member = members.get(path) ?? refuse();
    const bytes = await frozen.readFile(member.bodyFile);
    if (createHash("sha256").update(bytes).digest("hex") !== member.contentDigest) refuse();
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (body?.schemaVersion !== 2 || !Array.isArray(body.documents)) refuse();
    const matches = body.documents.filter((row: { path: string }) => row.path === path);
    const document = matches.length === 1 && matches[0].data;
    if (!document?.published || digest(document.published) !== route.snapshotDigest ||
        document.published.sourceVersion !== route.sourceVersion || publiclyVisible(document) !== (route.status !== 410)) refuse();
  };
  const entries = [...wanted];
  for (let offset = 0; offset < entries.length; offset += 4) {
    const batch = await Promise.allSettled(entries.slice(offset, offset + 4).map(check));
    const failure = batch.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}
