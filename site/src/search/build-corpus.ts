import { createHash } from "node:crypto";
import {
  MODEL_ID,
  MODEL_REVISION,
} from "../../../packages/browser-search/contracts";
import { loadSearchEncoder } from "./model";
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { AstroIntegration } from "astro";
import { fileURLToPath } from "node:url";

export { extractPassages, type SearchPassage } from "./passages";
import { extractPassages, type SearchPassage } from "./passages";
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
  return {
    name: "meaning-search-index",
    hooks: {
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
        // Passage vectors are built from this exact site's rendered, admitted content.
        // The model matches the browser query encoder; no hosted inference is used.
        const encoder = await loadSearchEncoder();
        for (const passages of [publicPassages, guidePassages]) {
          for (const passage of passages) {
            const output = await encoder(`${passage.title}\n${passage.text}`, {
              pooling: "mean",
              normalize: true,
            });
            passage.vector = Array.from(
              output.data,
              (value) => Math.round(Number(value) * 1e6) / 1e6,
            );
          }
        }
        await encoder.dispose();
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
        await write("search/meaning-index.json", publicPassages);
        if (guidePassages.length)
          await write("admin/docs/meaning-index.json", guidePassages);
      },
    },
  };
}
