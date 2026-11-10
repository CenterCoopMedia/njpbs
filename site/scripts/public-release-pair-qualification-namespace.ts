import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { ReplayWitness, ReplayNamespaceSelection } from "../../functions/lib/public-release-pair-replay";
import protocol from "../../functions/lib/public-release-pair.js";
import replay from "../../functions/lib/public-release-pair-replay.js";
import view from "../../functions/lib/public-release-pair-view.js";
import { parsePublicReleasePairSearchNamespace, publicReleasePairSearchNamespaceRootDigest,
  publicReleasePairSearchNamespaceManifestDigest } from "./public-release-pair-search-namespace";
import { parsePublicReleasePairContentFeedNamespace, publicReleasePairContentFeedNamespaceRootDigest,
  publicReleasePairContentFeedNamespaceManifestDigest } from "./public-release-pair-content-feed-namespace";
import { PairQualificationError, QUALIFICATION_ROUTE_LIMIT } from "./public-release-pair-qualification-authority";
import { same, isReaderNamespacePath } from "./public-release-pair-reader-contract";

/** Bind the replay owner's freshly reconstructed proof. This cannot establish
 * freshness from caller hints, select a namespace or grant publication. */
export function bindQualificationNamespaces(pair: PublicReleasePair, witness: Pick<ReplayWitness, "fromCursor" | "headCursor">,
  selections: readonly ReplayNamespaceSelection[]) {
  const refuse = (): never => { throw new PairQualificationError("replay-unproven"); };
  if (!Array.isArray(selections) || selections.length > 2) refuse();
  const seen = new Set<string>();
  const namespaces = selections.map(selection => {
    if (!selection || seen.has(selection.namespace)) refuse();
    seen.add(selection.namespace);
    const reference = replay.parseReplayViewReference(selection.view, pair);
    let normalized: ReplayNamespaceSelection;
    if (selection.namespace === "/pagefind/") {
      const manifest = parsePublicReleasePairSearchNamespace(selection.manifest, pair, reference.identity, selection.cursor);
      if (publicReleasePairSearchNamespaceRootDigest(manifest.members) !== selection.namespaceRootDigest ||
          publicReleasePairSearchNamespaceManifestDigest(manifest, pair, reference.identity, selection.cursor) !== selection.namespaceManifestDigest) refuse();
      normalized = { ...selection, view: reference, manifest, members: manifest.members, cursor: manifest.cursor };
    } else if (selection.namespace === "/api/v1/content/") {
      const manifest = parsePublicReleasePairContentFeedNamespace(selection.manifest, pair, reference.identity, selection.cursor);
      if (publicReleasePairContentFeedNamespaceRootDigest(manifest.members) !== selection.namespaceRootDigest ||
          publicReleasePairContentFeedNamespaceManifestDigest(manifest, pair, reference.identity, selection.cursor) !== selection.namespaceManifestDigest ||
          !same(selection.index, { ...manifest.index, view: reference, cursor: manifest.cursor })) refuse();
      normalized = { ...selection, view: reference, manifest, members: manifest.members, cursor: manifest.cursor,
        index: Object.freeze({ ...manifest.index, view: reference, cursor: manifest.cursor }) };
    } else return refuse();
    const cursor = normalized.cursor, headCursor = replay.parseReplayCursor(selection.headCursor);
    if (!same(headCursor, witness.headCursor) || cursor.baselineDigest !== witness.fromCursor.baselineDigest ||
        cursor.sequence < witness.fromCursor.sequence || cursor.sequence > headCursor.sequence ||
        !same(selection.members, normalized.members)) refuse();
    const priorPaths = selection.priorPaths;
    if (!Array.isArray(priorPaths) || priorPaths.length > QUALIFICATION_ROUTE_LIMIT ||
        priorPaths.some((path, index) => !isReaderNamespacePath(selection.namespace, path) ||
          index > 0 && view.comparePrivatePairArtifactPaths(priorPaths[index - 1], path) >= 0)) refuse();
    const prior = new Set(priorPaths), current = new Set(normalized.members.map(member => member.path));
    if (normalized.members.some(member => !prior.has(member.path))) refuse();
    const withdrawnPaths = priorPaths.filter(path => !current.has(path));
    if (!same(withdrawnPaths, selection.withdrawnPaths)) refuse();
    const common = { namespaceRootDigest: normalized.namespaceRootDigest, namespaceManifestDigest: normalized.namespaceManifestDigest,
      cursor, headCursor, view: reference, priorPaths: Object.freeze([...priorPaths]), withdrawnPaths: Object.freeze(withdrawnPaths) };
    return normalized.namespace === "/api/v1/content/"
      ? Object.freeze({ ...common, namespace: normalized.namespace, manifest: normalized.manifest, members: normalized.members, index: normalized.index })
      : Object.freeze({ ...common, namespace: normalized.namespace, manifest: normalized.manifest, members: normalized.members });
  });
  return Object.freeze({ namespaces: Object.freeze(namespaces), namespaceProofDigest: protocol.publicReleaseDigest(namespaces) });
}
