import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { parsePoliticsResource } from "../src/lib/politics-resource";
import { parseElectionDirectory } from "../src/lib/election-directory";
import { parseBioCatalog } from "../src/lib/bio-catalog";

/** Staff data is emitted only at the exact paths authorized by guide-content. */
export function politicsResourceContentPlugin(resourceDirectory = path.resolve(import.meta.dirname, "../private-resources")): Plugin {
  return {
    name: "politics-resource-content",
    generateBundle() {
      if (!existsSync(resourceDirectory)) {
        this.warn("Politics resource corpus is absent; no resource assets will be emitted.");
        return;
      }
      const assets = ["nj-politics", "nj-election-2026"].map(name => {
        const source = readFileSync(path.join(resourceDirectory, `${name}.json`), "utf8");
        const parsed: unknown = JSON.parse(source);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("NJ politics resource must contain a JSON object.");
        if (name === "nj-election-2026") parseElectionDirectory(parsed);
        else parsePoliticsResource(parsed);
        return { type: "asset" as const, fileName: `guide-content/resources/${name}.json`, source: `${JSON.stringify(parsed)}\n` };
      });
      const bios = parseBioCatalog(JSON.parse(readFileSync(path.join(resourceDirectory, "public-bios.json"), "utf8")));
      assets.push({ type: "asset", fileName: "guide-content/resources/public-bios.json", source: `${JSON.stringify(bios)}\n` });
      // Validate every input before emitting any staff asset.
      for (const asset of assets) this.emitFile(asset);
    },
  };
}
