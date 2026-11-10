import { readFile } from "node:fs/promises";

interface LaunchContentData {
  source?: unknown;
  checkedAt?: unknown;
  cards?: unknown[];
}

function isIsoInstant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export async function loadLaunchContentData<T extends LaunchContentData>(
  committed: T,
  env: Record<string, string | undefined> = process.env,
): Promise<T> {
  const inputPath = env.LAUNCH_CONTENT_DATA_PATH?.trim();
  if (!inputPath) return committed;

  const generated: unknown = JSON.parse(await readFile(inputPath, "utf8"));
  if (
    typeof generated !== "object" ||
    generated === null ||
    (generated as LaunchContentData).source !== "media-manager" ||
    !isIsoInstant((generated as LaunchContentData).checkedAt) ||
    !Array.isArray((generated as LaunchContentData).cards) ||
    (generated as LaunchContentData).cards!.length === 0
  ) {
    throw new Error("Generated Media Manager launch data is invalid");
  }
  return generated as T;
}
