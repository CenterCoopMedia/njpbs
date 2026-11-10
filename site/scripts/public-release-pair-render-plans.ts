import type { PairInputRoot } from "../../functions/lib/public-release-pair-input";
import work from "../../functions/lib/public-release-pair-work.js";
import { PAIR_RENDER_PLAN_FILE, parsePublicReleasePairRenderPlan, type PairRenderPlan } from "./public-release-pair-render-plan";
import { PAIR_AGGREGATE_RENDER_PLAN_FILE, parsePublicReleasePairAggregateRenderPlan } from "./public-release-pair-aggregate-render-plan";
function refuse(): never { throw new work.PairExecutionError("input-unavailable"); }
function json(bytes: Uint8Array) { try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return refuse(); } }
/** Each source plan keeps its own verified H dependency closure. A combined
 * route set is a render/ownership view, never a substituted H root or snapshot. */
export async function openPublicReleasePairRenderPlans(root: PairInputRoot, readFile: (name: string) => Promise<Uint8Array>) {
  const ordinaryPlan = parsePublicReleasePairRenderPlan(json(await readFile(PAIR_RENDER_PLAN_FILE)), root);
  const file = root.files.find(file => file.name === PAIR_AGGREGATE_RENDER_PLAN_FILE);
  if (!file && root.files.some(file => file.name === "code-pack.json")) refuse();
  const aggregatePlan = file ? parsePublicReleasePairAggregateRenderPlan(await readFile(file.name), root, ordinaryPlan) : null;
  const routes = new Map(ordinaryPlan.routes.map((route, index) => [route.path, { route, output: ordinaryPlan.expectedOutputs[index],
    filePrefix: "", index }]));
  const overlaps: Array<{ path: string; ordinaryIndex: number; aggregateIndex: number }> = [];
  aggregatePlan?.routes.forEach((route, index) => {
    const before = routes.get(route.path), output = aggregatePlan.expectedOutputs[index];
    if (before) {
      if (before.output.status !== output.status || before.output.contentType !== output.contentType) refuse();
      overlaps.push({ path: route.path, ordinaryIndex: before.index, aggregateIndex: index });
    } else routes.set(route.path, { route, output, filePrefix: "aggregate-", index });
  });
  const selected = [...routes.values()].sort((a, b) => a.route.path < b.route.path ? -1 : 1);
  const plan: PairRenderPlan = Object.freeze({ ...ordinaryPlan, routes: Object.freeze(selected.map(value => value.route)),
    expectedOutputs: Object.freeze(selected.map(value => value.output)) });
  return { ordinaryPlan, aggregatePlan, plan, selected, overlaps: Object.freeze(overlaps) };
}
