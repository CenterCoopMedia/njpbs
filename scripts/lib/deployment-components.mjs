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
      const [before, after] = await Promise.all([
        fingerprintPaths(baselineSha, [path], deps), fingerprintPaths(sourceSha, [path], deps),
      ]);
      if (before !== after) selected.add(name);
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
    configuration: Object.freeze(component === "functions" ? ["firebase.json", ".firebaserc", "config/functions-deployment.json", "config/functions-configuration.json"]
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
