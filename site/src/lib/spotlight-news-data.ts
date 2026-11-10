import { readFile } from "node:fs/promises";

interface SpotlightNewsData {
  cards?: unknown[];
}

export async function loadSpotlightNewsData<T extends SpotlightNewsData>(
  committed: T,
  env: Record<string, string | undefined> = process.env,
): Promise<T> {
  const inputPath = env.SPOTLIGHT_NEWS_DATA_PATH?.trim();
  if (!inputPath) return committed;

  const generated: unknown = JSON.parse(await readFile(inputPath, "utf8"));
  if (
    typeof generated !== "object" ||
    generated === null ||
    !Array.isArray((generated as SpotlightNewsData).cards)
  ) {
    throw new Error("Generated NJ Spotlight News data is invalid");
  }
  return generated as T;
}
