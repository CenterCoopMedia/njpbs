import { chmod, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
const require = createRequire(import.meta.url);
const { publicationTarget } = require("../functions/lib/publication-target.js");
const { DEPLOYMENT_PATH } = require("../functions/lib/cloud-publication-wake-deployment.js");

export async function prepareCloudPublicationWake({ environment, enabled, path: output = DEPLOYMENT_PATH }) {
  if (!["production", "development"].includes(environment)) throw new Error("An explicit cloud wake target is required");
  const target = publicationTarget(environment);
  if (typeof enabled !== "boolean") throw new Error("An explicit cloud wake deployment decision is required");
  await writeFile(output, `${JSON.stringify({ schemaVersion: 1, environment: target.environment, enabled })}\n`, { mode: 0o644 });
  // This is public deployment metadata. The packaged runtime may use another
  // UID, and rewrites must also repair a prior owner-only artifact.
  await chmod(output, 0o644);
  return { environment: target.environment, enabled, path: output };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [environment, enabled, ...extra] = process.argv.slice(2);
  if (extra.length || !["true", "false"].includes(enabled) || !["production", "development"].includes(environment)) {
    throw new Error("Usage: prepare-cloud-publication-wake <production|development> <true|false>");
  }
  console.log(JSON.stringify(await prepareCloudPublicationWake({ environment, enabled: enabled === "true" })));
}
