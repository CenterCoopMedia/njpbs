// The paths whose last change names the commit that the Functions and the preview renderer carry.
// deploy-cms.mjs labels each deploy with it; check-release-drift.mjs compares the live label with it.
const contract = ["scripts/functions-contract-sources.json", "scripts/lib/functions-contracts.mjs", "scripts/compile-functions-contracts.mjs", "packages", "package.json", "package-lock.json"];
export const functionsPaths = ["functions"];
export const rendererPaths = ["preview-renderer", "site", "functions", "config/development-inputs.json",
  "scripts/render-development-config.mjs", "scripts/prepare-preview-renderer.mjs", ...contract];
