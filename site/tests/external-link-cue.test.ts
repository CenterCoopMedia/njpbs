// @vitest-environment node
// The accessibility statement promises a screen-reader cue on every link that
// opens in a new tab. In the content pages those links are authored as raw HTML
// anchors (Astro's markdown pipeline hands raw HTML to rehype as string nodes, so
// a render-time plugin would be fragile), and the cue is added by hand. This test
// is the lock: any content page that ships a target="_blank" link without the cue
// fails here, so the statement cannot quietly become untrue as pages are added.
//
// Components carry the same cue, but their links are often conditional (CinematicHomePage's
// open in a new tab on the public site), so they are better verified against
// built HTML than source; that is tracked separately.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pagesDir = fileURLToPath(new URL("../src/content/pages", import.meta.url));
const pages = readdirSync(pagesDir).filter((f) => f.endsWith(".md"));

// Each <a ...target="_blank"...>inner</a>, capturing the inner content so we can
// confirm the cue sits inside the link (where a screen reader reads it).
const NEW_TAB_ANCHOR = /<a\b[^>]*\btarget=["']_blank["'][^>]*>([\s\S]*?)<\/a>/g;
const CUE = "(opens in new tab)";

describe("content pages cue every new-tab link for screen readers", () => {
  it.each(pages)("%s cues its new-tab links", (file) => {
    const text = readFileSync(`${pagesDir}/${file}`, "utf8");
    for (const match of text.matchAll(NEW_TAB_ANCHOR)) {
      expect(
        match[1],
        `${file}: new-tab link is missing the sr-only cue -> ${match[0]}`,
      ).toContain(CUE);
    }
  });
});
