import type { PairInputRoot } from "../../functions/lib/public-release-pair-input";
import work from "../../functions/lib/public-release-pair-work.js";

export const PAIR_RENDER_PLAN_FILE = "render-plan.json";
export const PAIR_RENDER_ROUTE_LIMIT = 100_000;
export type PairRenderDependency = Readonly<{ name: string; digest: string }>;
export type PairRenderRoute = Readonly<{
  path: string;
  method: "GET";
  renderer: "post" | "page" | "context" | "record" | "json" | "withdrawal" | "redirect";
  inputFile: string;
  dependencies: readonly PairRenderDependency[];
}>;
export type PairRenderOutput = Readonly<{ path: string; status: 200 | 302 | 308 | 410; contentType: string }>;
export type PairRenderPlan = Readonly<{
  schemaVersion: 1;
  pairDigest: string;
  snapshotDigest: string;
  renderedAt: string;
  routes: readonly PairRenderRoute[];
  expectedOutputs: readonly PairRenderOutput[];
}>;
function refuse(): never { throw new work.PairExecutionError("input-unavailable"); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) refuse();
  return value as Record<string, unknown>;
}
function exact(value: unknown, names: string[]) {
  const parsed = object(value);
  if (Object.keys(parsed).sort().join(",") !== names.sort().join(",")) refuse();
  return parsed;
}
function routePath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 1024 &&
    !value.split("/").includes("_pair-compiled") &&
    /^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*$/.test(value) &&
    value.split("/").every(part => part !== "." && part !== "..");
}

/** The caller first validates H's root with parsePublicReleasePairInputRoot.
 * The plan is an entry in that immutable root, never a mutable runtime option.
 * Dependencies name the actual frozen files and their SHA-256 digests. */
export function parsePublicReleasePairRenderPlan(value: unknown, root: PairInputRoot): PairRenderPlan {
  const plan = exact(value, ["schemaVersion", "pairDigest", "snapshotDigest", "renderedAt", "routes", "expectedOutputs"]);
  if (plan.schemaVersion !== 1 || plan.pairDigest !== root.pairDigest || plan.snapshotDigest !== root.scope.snapshotDigest ||
      typeof plan.renderedAt !== "string" || !Number.isFinite(Date.parse(plan.renderedAt)) ||
      new Date(plan.renderedAt).toISOString() !== plan.renderedAt ||
      !root.entryFiles.includes(PAIR_RENDER_PLAN_FILE) ||
      !Array.isArray(plan.routes) || !plan.routes.length || plan.routes.length > PAIR_RENDER_ROUTE_LIMIT ||
      !Array.isArray(plan.expectedOutputs) || plan.expectedOutputs.length !== plan.routes.length) refuse();
  const inventory = new Map(root.files.map(file => [file.name, file]));
  const planFile = inventory.get(PAIR_RENDER_PLAN_FILE);
  if (!planFile) refuse();
  const used = new Set<string>();
  let previous = "";
  const routes = plan.routes.map(raw => {
    const route = exact(raw, ["path", "method", "renderer", "inputFile", "dependencies"]);
    if (!routePath(route.path) || route.path <= previous || route.method !== "GET" ||
        typeof route.renderer !== "string" || !["post", "page", "context", "record", "json", "withdrawal", "redirect"].includes(route.renderer) ||
        typeof route.inputFile !== "string" || route.inputFile === PAIR_RENDER_PLAN_FILE || !inventory.has(route.inputFile) ||
        !Array.isArray(route.dependencies) || !route.dependencies.length || route.dependencies.length > 10_000) refuse();
    previous = route.path;
    let prior = "";
    const dependencies = route.dependencies.map(rawDependency => {
      const dependency = exact(rawDependency, ["name", "digest"]);
      if (typeof dependency.name !== "string" || dependency.name <= prior || dependency.name === PAIR_RENDER_PLAN_FILE ||
          !inventory.has(dependency.name) || dependency.digest !== inventory.get(dependency.name)!.digest) refuse();
      prior = dependency.name;
      used.add(dependency.name);
      return Object.freeze({ name: dependency.name, digest: dependency.digest as string });
    });
    const named = new Set(dependencies.map(dependency => dependency.name));
    if (!named.has(route.inputFile) || !named.has(root.snapshotFile) ||
        dependencies.some(dependency => inventory.get(dependency.name)!.dependencies.some(name => !named.has(name)))) refuse();
    return Object.freeze({ path: route.path, method: "GET" as const, renderer: route.renderer as PairRenderRoute["renderer"],
      inputFile: route.inputFile, dependencies: Object.freeze(dependencies) });
  });
  // H permits bounded dependency groups. Follow that validated acyclic graph
  // rather than requiring a single file to list an arbitrarily large union.
  const reachable = new Set<string>(), pending = [...planFile.dependencies];
  while (pending.length) {
    const name = pending.pop()!;
    if (name === PAIR_RENDER_PLAN_FILE || !inventory.has(name)) refuse();
    if (reachable.has(name)) continue;
    reachable.add(name);
    pending.push(...inventory.get(name)!.dependencies);
  }
  if (reachable.size !== used.size || [...reachable].some(name => !used.has(name))) refuse();
  const expectedOutputs = plan.expectedOutputs.map((raw, index) => {
    const output = exact(raw, ["path", "status", "contentType"]), route = routes[index];
    const contentType = route.renderer === "json" ? "application/json; charset=utf-8" : "text/html; charset=utf-8";
    if (typeof output.status !== "number" || output.path !== route.path || output.contentType !== contentType ||
        (route.renderer === "withdrawal" ? output.status !== 410 :
          route.renderer === "redirect" ? output.status !== 308 :
          route.renderer === "record" ? ![200, 308].includes(output.status) : ["post", "page", "context"].includes(route.renderer) ? ![200, 302].includes(output.status) : output.status !== 200)) refuse();
    return Object.freeze({ path: route.path, status: output.status as PairRenderOutput["status"], contentType });
  });
  return Object.freeze({ schemaVersion: 1, pairDigest: root.pairDigest, snapshotDigest: root.scope.snapshotDigest,
    renderedAt: plan.renderedAt, routes: Object.freeze(routes), expectedOutputs: Object.freeze(expectedOutputs) });
}
