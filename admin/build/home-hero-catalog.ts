import type { Plugin } from "vite";
import { createHomeSourceSnapshot } from "../../site/src/lib/home-sources";
import launchMedia from "../../site/src/data/launch-media-manager.json";
import spotlightNews from "../../site/src/data/spotlight-news.json";

export function homeHeroCatalogPlugin(): Plugin {
  const id = "virtual:home-hero-catalog";
  return {
    name: "home-hero-release-catalog",
    resolveId(source) { if (source === id) return `\0${id}`; },
    load(source) {
      if (source !== `\0${id}`) return;
      const catalog = createHomeSourceSnapshot(launchMedia, spotlightNews).heroCatalog;
      return `export default ${JSON.stringify(catalog)};`;
    },
  };
}
