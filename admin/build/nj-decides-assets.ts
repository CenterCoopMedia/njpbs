import { readFileSync } from "node:fs";
import type { Plugin } from "vite";
import { NJ_DECIDES_LOGO } from "../../packages/content-core/src/nj-decides";

const assets = [NJ_DECIDES_LOGO.src, NJ_DECIDES_LOGO.reversedSrc, "/brand/nj-decides/stars.svg"];

/** Admin and Site ship the same canonical kit files. */
export function njDecidesAssetsPlugin(): Plugin {
  const files = new Map(assets.map(path => [path, new URL(`../../site/public${path}`, import.meta.url)]));
  return {
    name: "nj-decides-assets",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const file = files.get((request.url ?? "").split("?")[0]);
        if (!file) return next();
        response.setHeader("Content-Type", "image/svg+xml");
        response.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const [path, file] of files) this.emitFile({ type: "asset", fileName: path.slice(1), source: readFileSync(file) });
    },
  };
}
