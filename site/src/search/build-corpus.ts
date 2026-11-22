import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  DIMENSIONS,
  MAX_DOCUMENTS,
  MODEL_ID,
  MODEL_REVISION,
} from "../../../packages/browser-search/contracts";
import { loadSearchEncoder } from "./model";
import { lstat, readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { AstroIntegration } from "astro";
import { fileURLToPath } from "node:url";

export { extractPassages, type SearchPassage } from "./passages";
import { extractPassages, type SearchPassage } from "./passages";

const searchIndexPath = "search/meaning-index.json";
const encoderInput = ({ title, text }: Pick<SearchPassage, "title" | "text">) => `${title}\n${text}`;

async function previousVectors(output: URL, inventoryPath: string, commitSha: string) {
  const empty = new Map<string, number[]>();
  try {
    // The background sandbox owns both files. The inventory is finalized only
    // after the renderer writes the index and is cleared with the same dist tree.
    const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
    if (inventory?.commitSha !== commitSha) return empty;
    const file = new URL(searchIndexPath, output);
    const status = await lstat(file);
    if (!status.isFile() || status.size > 16 * 1024 * 1024) return empty;
    const index = JSON.parse(await readFile(file, "utf8"));
    if (index?.version !== 1 || index.model !== MODEL_ID || index.revision !== MODEL_REVISION ||
      !Array.isArray(index.passages) || index.passages.length > MAX_DOCUMENTS) return empty;
    const vectors = new Map<string, number[]>();
    for (const passage of index.passages) {
      if (typeof passage?.title !== "string" || typeof passage.text !== "string" || !Array.isArray(passage.vector) ||
        passage.vector.length !== DIMENSIONS || !passage.vector.every(Number.isFinite)) return empty;
      const key = encoderInput(passage);
      const prior = vectors.get(key);
      if (prior?.some((value, position) => value !== passage.vector[position])) return empty;
      vectors.set(key, passage.vector);
    }
    return vectors;
  } catch {
    // Cold starts and unusable prior indexes take the full encoding path.
    return empty;
  }
}

async function htmlFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      ["wiki", "prototype", "design-system"].includes(
        entry.name,
      )
    )
      continue;
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await htmlFiles(name)));
    else if (entry.name.endsWith(".html")) result.push(name);
  }
  return result;
}
export function meaningSearchIndex(): AstroIntegration {
  let baseline: Map<string, number[]> | undefined;
  let baselineReadMs = 0;
  return {
    name: "meaning-search-index",
    hooks: {
      "astro:config:done": async ({ config }) => {
        baseline = undefined;
        baselineReadMs = 0;
        // config-input: CMS_OFFLINE_BUILD, PUBLIC_ARTIFACT_BATCH_MODE, PUBLIC_ARTIFACT_RETAINED_BUNDLE_PATH, PUBLIC_ARTIFACT_INVENTORY_PATH, PUBLIC_BUILD_COMMIT_SHA
        const { CMS_OFFLINE_BUILD, PUBLIC_ARTIFACT_BATCH_MODE, PUBLIC_ARTIFACT_RETAINED_BUNDLE_PATH,
          PUBLIC_ARTIFACT_INVENTORY_PATH, PUBLIC_BUILD_COMMIT_SHA } = process.env;
        if (CMS_OFFLINE_BUILD === "1" && PUBLIC_ARTIFACT_BATCH_MODE === "background" &&
          PUBLIC_ARTIFACT_RETAINED_BUNDLE_PATH && PUBLIC_ARTIFACT_INVENTORY_PATH && PUBLIC_BUILD_COMMIT_SHA) {
          // Astro empties outDir during the build. Read the previous render first.
          const started = performance.now();
          baseline = await previousVectors(config.outDir, PUBLIC_ARTIFACT_INVENTORY_PATH, PUBLIC_BUILD_COMMIT_SHA);
          baselineReadMs = performance.now() - started;
        }
      },
      "astro:build:done": async ({ dir }) => {
        if (
          ["1", "true", "yes", "on"].includes(
            (process.env.PUBLIC_ONLY ?? "").toLowerCase(),
          ) ||
          process.env.CMS_PREVIEW_INPUT_PATH
        ) {
          // Direct Astro rollback/preview builds skip both indexers too.
          await rm(new URL("search/content-links.json", dir), { force: true });
          return;
        }
        const started = performance.now();
        const directory = fileURLToPath(dir);
        const publicPassages: SearchPassage[] = [],
          guidePassages: SearchPassage[] = [];
        for (const file of await htmlFiles(directory)) {
          const url =
            "/" +
            path
              .relative(directory, file)
              .split(path.sep)
              .join("/")
              .replace(/index\.html$/, "");
          const scope = url.startsWith("/admin/docs/") ? "guide" : "public";
          const passages = extractPassages(
            await readFile(file, "utf8"),
            url,
            scope,
          );
          (scope === "guide" ? guidePassages : publicPassages).push(
            ...passages,
          );
        }
        const linked = JSON.parse(await readFile(path.join(directory, "search/content-links.json"), "utf8").catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "[]"; throw error; }));
        for (const record of linked) publicPassages.push({ id: createHash("sha256").update(`${record.path}\n${record.title}\n${record.text}`).digest("hex").slice(0,24), url: record.path, title: record.title, text: record.text,
          contentLinkUrl: record.contentLinkUrl, contentLinkNewTab: record.contentLinkNewTab !== false });
        // The rendered HTML and current links supply the complete passage roster.
        // Only the numeric vector can come from an exact prior encoder input.
        let encoder: Awaited<ReturnType<typeof loadSearchEncoder>> | undefined;
        try {
          for (const passages of [publicPassages, guidePassages]) {
            for (const passage of passages) {
              const input = encoderInput(passage);
              const vector = baseline?.get(input);
              if (vector) {
                passage.vector = vector;
                continue;
              }
              encoder ??= await loadSearchEncoder();
              const output = await encoder(input, { pooling: "mean", normalize: true });
              passage.vector = Array.from(output.data, (value) => Math.round(Number(value) * 1e6) / 1e6);
            }
          }
        } finally {
          await encoder?.dispose();
        }
        const write = async (relative: string, passages: SearchPassage[]) => {
          const destination = path.join(directory, relative);
          await mkdir(path.dirname(destination), { recursive: true });
          await writeFile(
            destination,
            JSON.stringify({
              version: 1,
              model: MODEL_ID,
              revision: MODEL_REVISION,
              passages,
            }),
          );
        };
        await write(searchIndexPath, publicPassages);
        if (guidePassages.length)
          await write("admin/docs/meaning-index.json", guidePassages);
        if (baseline) {
          console.log(JSON.stringify({ event: "cms_public_build_timing", stage: "meaning_search_complete",
            elapsedMs: Math.round(baselineReadMs + performance.now() - started) }));
        }
      },
    },
  };
}
