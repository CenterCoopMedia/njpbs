import { readFile } from "node:fs/promises";
import path from "node:path";
import { createPublicBuildSettings, assertPreparedPublicBuildSettings,
  type PublicBuildValues } from "../../functions/lib/public-build-settings.js";
import { publicPostRenderEnvironment } from "./public-post-render-environment";

export function expectedPublicBuildValues(commitSha: string, environment: Record<string, string | undefined>) {
  return assertPreparedPublicBuildSettings(createPublicBuildSettings(commitSha,
    publicPostRenderEnvironment(environment), environment), commitSha).values;
}

export async function readPreparedPublicBuildSettings(directory: string, commitSha: string, expectedValues: PublicBuildValues) {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path.join(directory, "renderer/public-build-settings.json"), "utf8"));
  } catch {
    // Missing and malformed files use the same controlled native refusal.
  }
  return assertPreparedPublicBuildSettings(value, commitSha, expectedValues);
}
