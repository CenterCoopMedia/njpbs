// @vitest-environment node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSpotlightNewsData } from "../src/lib/spotlight-news-data";

const temporaryDirectories: string[] = [];
const committed = { cards: [{ title: "Committed story" }] };

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("loadSpotlightNewsData", () => {
  it("uses the generated build data when its path is configured", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "spotlight-news-"));
    temporaryDirectories.push(directory);
    const inputPath = path.join(directory, "spotlight-news.json");
    const generated = { cards: [{ title: "Current story" }] };
    await writeFile(inputPath, JSON.stringify(generated), "utf8");

    await expect(
      loadSpotlightNewsData(committed, {
        SPOTLIGHT_NEWS_DATA_PATH: inputPath,
      }),
    ).resolves.toEqual(generated);
  });

  it("uses committed data when no generated path is configured", async () => {
    await expect(loadSpotlightNewsData(committed, {})).resolves.toBe(committed);
  });

  it("refuses a generated file without a card list", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "spotlight-news-"));
    temporaryDirectories.push(directory);
    const inputPath = path.join(directory, "spotlight-news.json");
    await writeFile(inputPath, JSON.stringify({ cards: null }), "utf8");

    await expect(
      loadSpotlightNewsData(committed, {
        SPOTLIGHT_NEWS_DATA_PATH: inputPath,
      }),
    ).rejects.toThrow("Generated NJ Spotlight News data is invalid");
  });
});
