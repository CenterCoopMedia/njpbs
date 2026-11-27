import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import fonts from "../../site/scripts/public-fonts.json";

const directory = new URL("../../site/public/brand/fonts/", import.meta.url);
const prepare = fileURLToPath(new URL("../../site/scripts/prepare-public-fonts.mjs", import.meta.url));

/** Boardwalk serves the public site's pinned PBS Sans files from its own origin, at /brand/fonts/. */
export function publicFontsPlugin(): Plugin {
  return {
    name: "njpbs-public-fonts",
    // The dev server does not serve the fonts: visual tests keep the fallback face they were recorded with.
    apply: "build",
    // Downloads missing files once and verifies every checksum, so a missing font fails the build.
    buildStart: () => { execFileSync(process.execPath, [prepare], { stdio: "inherit" }); },
    generateBundle() {
      for (const name of Object.keys(fonts)) {
        this.emitFile({ type: "asset", fileName: `brand/fonts/${name}`, source: readFileSync(new URL(name, directory)) });
      }
    },
  };
}
