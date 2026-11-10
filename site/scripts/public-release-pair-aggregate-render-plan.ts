import { createHash } from "node:crypto";
import type { PairInputRoot } from "../../functions/lib/public-release-pair-input";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import { PAIR_RENDER_PLAN_FILE, parsePublicReleasePairRenderPlan, type PairRenderPlan } from "./public-release-pair-render-plan";
export const PAIR_AGGREGATE_RENDER_PLAN_FILE = "aggregate-render-plan.json";
function refuse(): never { throw new work.PairExecutionError("input-unavailable"); }
function exact(value: any, fields: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== fields.sort().join()) refuse();
}
/** Parse the source-owned complete route inventory using the same strict DTO
 * grammar. This synthetic parser view neither replaces H nor changes its
 * snapshot; actual bytes and the aggregate dependency closure remain sealed. */
export function parsePublicReleasePairAggregateRenderPlan(bytes: Uint8Array, root: PairInputRoot, ordinary: PairRenderPlan): PairRenderPlan {
  const file = root.files.find(file => file.name === PAIR_AGGREGATE_RENDER_PLAN_FILE);
  if (!file || ordinary.pairDigest !== root.pairDigest || ordinary.snapshotDigest !== root.scope.snapshotDigest ||
      !root.entryFiles.includes("source-dependencies.json") || file.bytes !== bytes.length ||
      file.digest !== createHash("sha256").update(bytes).digest("hex")) refuse();
  let value: any;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return refuse(); }
  exact(value, ["schemaVersion", "kind", "pairDigest", "cursor", "renderedAt", "routes", "expectedOutputs"]);
  if (value.schemaVersion !== 1 || value.kind !== "pair-aggregate-render-plan" || value.pairDigest !== root.pairDigest || value.renderedAt !== ordinary.renderedAt ||
      protocol.publicReleaseDigest(value.cursor) !== protocol.publicReleaseDigest(root.cursor)) refuse();
  const shadow = { ...root, files: root.files.filter(row => row.name !== PAIR_RENDER_PLAN_FILE && row.name !== PAIR_AGGREGATE_RENDER_PLAN_FILE)
    .concat({ ...file, name: PAIR_RENDER_PLAN_FILE }) };
  return parsePublicReleasePairRenderPlan({ schemaVersion: 1, pairDigest: root.pairDigest, snapshotDigest: root.scope.snapshotDigest,
    renderedAt: value.renderedAt, routes: value.routes, expectedOutputs: value.expectedOutputs }, shadow);
}
