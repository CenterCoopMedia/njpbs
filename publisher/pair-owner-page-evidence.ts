import type { PublicReleasePair } from "../packages/content-core/src/public-release";
import protocol from "../functions/lib/public-release-pair.js";
import views from "../functions/lib/public-release-pair-view.js";
import work from "../functions/lib/public-release-pair-work.js";

export type OwnerReplayPageEvidence = Readonly<{ schemaVersion: 2; kind: "owner-replay-page"; pairDigest: string;
  pageDigest: string; cursor: { baselineDigest: string; sequence: number; lastDigest: string }; index: number;
  count: number; firstPath: string; lastPath: string; evidenceDigest: string }>;
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function refuse(): never { throw new protocol.PublicReleaseProtocolError(); }
export const ownerReplayPageEvidencePath = (pair: PublicReleasePair, pageDigest: string) => {
  if (!digest(pageDigest)) refuse();
  return `${work.publicReleasePairPath(pair.pairId)}/ownerReplayPages/${pageDigest}`;
};
export function parseOwnerReplayPageEvidence(raw: any, pair: PublicReleasePair): OwnerReplayPageEvidence {
  if (!raw || Object.keys(raw).sort().join(",") !== "count,cursor,evidenceDigest,firstPath,index,kind,lastPath,pageDigest,pairDigest,schemaVersion" ||
      raw.schemaVersion !== 2 || raw.kind !== "owner-replay-page" || raw.pairDigest !== protocol.publicReleaseDigest(pair) ||
      !digest(raw.pageDigest) || !digest(raw.evidenceDigest) || !raw.cursor ||
      Object.keys(raw.cursor).sort().join(",") !== "baselineDigest,lastDigest,sequence" ||
      !digest(raw.cursor.baselineDigest) || !digest(raw.cursor.lastDigest) || !Number.isSafeInteger(raw.cursor.sequence) || raw.cursor.sequence < 0 ||
      raw.cursor.sequence === 0 && raw.cursor.lastDigest !== raw.cursor.baselineDigest ||
      !Number.isSafeInteger(raw.index) || raw.index < 0 || raw.index >= Math.ceil(views.VIEW_OUTPUT_LIMIT / 256) ||
      !Number.isSafeInteger(raw.count) || raw.count < 1 || raw.count > 256 ||
      ![raw.firstPath, raw.lastPath].every(path => typeof path === "string" && (path === "/" ||
        views.isPrivatePairArtifactPath(path.endsWith("/") ? path.slice(0, -1) : path))) ||
      views.comparePrivatePairArtifactPaths(raw.firstPath, raw.lastPath) > 0 ||
      (raw.count === 1) !== (raw.firstPath === raw.lastPath)) refuse();
  return Object.freeze({ ...raw, cursor: Object.freeze({ ...raw.cursor }) });
}
