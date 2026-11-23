// One selection/operation table. Provider and original-attempt state stay in
// their existing adapters. Pair installation remains an explicit separate task.
import { ComponentReceiptError, fingerprintPaths, RECEIPT_INPUT_PATHS as INPUT_PATHS } from "./cms-component-receipt.mjs";

// Policy changes and explicit repairs have their own immutable input identities.
// Their current deploy/readiness and migration order remain workflow-owned.
export const MIGRATION_INPUTS = Object.freeze({
  "page-seed-media": "scripts/backfill-page-seed-media.mjs",
  "media-thumbnails": "scripts/backfill-media-thumbnails.mjs",
  "media-categories": "scripts/seed-media-categories.mjs",
  "media-category-assignments": "scripts/backfill-media-category-assignments.mjs",
  "author-profiles": "scripts/backfill-author-profiles.mjs",
  "content-sections": "scripts/seed-content-sections.mjs",
  "byline-projections": "scripts/backfill-byline-projections.mjs",
  "media-discovery": "scripts/backfill-media-discovery.mjs",
});
// The registry scripts read these CommonJS tables and the locked SDK. An
// ordinary Functions rollout can skip seeding only after proving live readiness.
const REGISTRY_DEPENDENCIES = {
  "media-categories": ["functions/lib/media-categories.js", "functions/lib/media-contract.js", "functions/lib/rbac.js"],
  "content-sections": ["functions/lib/content-sections.js", "functions/lib/public-page-contract.js"],
};
export function parseMigrationSelection(value = "") {
  if (value === "") return [];
  if (typeof value !== "string") throw new ComponentReceiptError("Migration selection is invalid");
  const names = value.split(",");
  if (new Set(names).size !== names.length || names.some(name => !Object.hasOwn(MIGRATION_INPUTS, name))) {
    throw new ComponentReceiptError("Migration selection is invalid");
  }
  return names;
}
// The existing complete Functions source is a conservative applied baseline.
// A repair-only release does not advance it: repeats remain idempotent until
// a completed code release advances the baseline. Do not infer data completion.
export async function selectMigrations(baselineSha, sourceSha, requested = [], deps = {}) {
  const selected = new Set(parseMigrationSelection(requested.join(",")));
  if (baselineSha !== sourceSha) {
    for (const [name, path] of Object.entries(MIGRATION_INPUTS)) {
      const registry = REGISTRY_DEPENDENCIES[name];
      // The other migrations still run on every Functions rollout.
      if (selected.has(name) || (deps.functionsMutated && !registry)) continue;
      const paths = registry ? [path, ...registry, "package.json", "package-lock.json", "functions/package.json"] : [path];
      try {
        const [before, after] = await Promise.all([
          fingerprintPaths(baselineSha, paths, deps), fingerprintPaths(sourceSha, paths, deps),
        ]);
        if (before !== after) selected.add(name);
      } catch (error) {
        // A Functions rollout already runs the registry seed when the source
        // comparison is unknown. Repair-only runs keep their source requirement.
        if (!deps.functionsMutated) throw error;
        selected.add(name);
      }
    }
  }
  return Object.keys(MIGRATION_INPUTS).filter(name => selected.has(name));
}
export const INDEPENDENT_INPUTS = Object.freeze({
  firestoreRules: Object.freeze(["firestore.rules"]),
  firestoreIndexes: Object.freeze(["firestore.indexes.json"]),
  storageRules: Object.freeze(["storage.rules"]),
  migrations: Object.freeze(Object.values(MIGRATION_INPUTS)),
});

const receiptOperations = component => Object.fromEntries(["start", "complete", "confirm", "read", "abandon"]
  .map(operation => [operation, { module: "cms-component-receipt.mjs", args: [operation, "--component", component] }]));

export const DEPLOYMENT_COMPONENTS = Object.freeze(Object.fromEntries(
  Object.entries({ ...INPUT_PATHS, ...INDEPENDENT_INPUTS }).map(([component, inputPaths]) => [component, Object.freeze({
    inputPaths,
    selection: component === "migrations" ? "explicit" : "routine",
    configuration: Object.freeze(component === "functions" ? ["firebase.json", "firebase.dev.json", ".firebaserc", "config/functions-deployment.json",
      "config/functions-deployment.development.json", "config/functions-configuration.json"]
      : component === "renderer" ? ["preview-renderer/wrangler.jsonc", "preview-renderer/wrangler.dev.jsonc"]
      : component === "cmsApi" ? ["cms-api/wrangler.jsonc", "cms-api/wrangler.dev.jsonc"] : []),
    operations: Object.freeze(Object.fromEntries(Object.entries({
      inputs: { args: [] },
      ...(Object.hasOwn(INPUT_PATHS, component) ? receiptOperations(component) : {}),
      ...(component === "functions" ? {
        configure: { module: "configure-cms-functions.mjs", args: ["configure"] },
        "verify-config": { module: "configure-cms-functions.mjs", args: ["verify"] },
        "verify-deployed-config": { module: "configure-cms-functions.mjs", args: ["verify-deployed"] },
        "provision-config": { module: "configure-cms-functions.mjs", args: ["provision"] },
        protocol: { module: "cms-component-receipt.mjs", args: ["protocol"] },
        plan: { module: "cms-release-plan.mjs", args: [] },
        deploy: { module: "retire-cms-functions.mjs", args: ["deploy"] },
        prepare: { module: "retire-cms-functions.mjs", args: ["prepare"] },
        verify: { module: "retire-cms-functions.mjs", args: ["verify"] },
        manifest: { module: "smoke-cms-functions.mjs", args: ["--manifest-only", "--index", "functions/index.js"] },
        smoke: { module: "smoke-cms-functions.mjs", args: ["--live-only", "--index", "functions/index.js"] },
      } : component === "cmsApi" ? {
        plan: { module: "cms-component-receipt.mjs", args: ["plan", "--component", component] },
      } : {}),
    }).map(([operation, adapter]) => [operation, Object.freeze({ ...adapter, args: Object.freeze(adapter.args) })]))),
  })]),
));

export { RECEIPT_INPUT_PATHS } from "./cms-component-receipt.mjs";
