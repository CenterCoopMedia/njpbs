import { readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { guideSearchPassages, type GuideSearchPassage } from "../src/lib/guide-search";
import { GUIDE_SEARCH_PASSAGE_LIMIT } from "../src/lib/guide-video-assets";
import { ADMIN_DOC_SECTIONS } from "../../site/src/lib/admin-docs";

const GUIDE_IMAGE = /(?:src|href)="\/images\/admin-guide\/([A-Za-z0-9][A-Za-z0-9._-]*\.webp)"/g;
const GUIDE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function markdownBody(source: string, slug: string): string {
  const match = source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  if (!match) throw new Error(`Boardwalk guide page ${slug} has no frontmatter.`);
  return source.slice(match[0].length);
}

/**
 * Put the reviewed guide sources in the Admin artifact without adding them to a public
 * JavaScript chunk. Cloudflare Pages Functions protects every file below guide-content
 * before the browser can read it.
 */
export function boardwalkGuideContentPlugin(): Plugin {
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const pagesRoot = path.join(repoRoot, "site/src/pages/_admin-docs");
  const imagesRoot = path.join(repoRoot, "site/src/internal/admin-guide");

  return {
    name: "boardwalk-guide-content",
    generateBundle() {
      const slugs = new Set<string>();
      const images = new Set<string>();
      const search: GuideSearchPassage[] = [];

      for (const section of ADMIN_DOC_SECTIONS) {
        for (const page of section.pages) {
          if (!GUIDE_SLUG.test(page.slug) || slugs.has(page.slug)) {
            throw new Error(`Boardwalk guide has an invalid or duplicate slug: ${page.slug}`);
          }
          slugs.add(page.slug);
          const source = markdownBody(
            readFileSync(path.join(pagesRoot, page.slug, "index.md"), "utf8"),
            page.slug,
          );
          for (const match of source.matchAll(GUIDE_IMAGE)) images.add(match[1]);
          search.push(...guideSearchPassages(source, page));
          if (search.length > GUIDE_SEARCH_PASSAGE_LIMIT) {
            throw new Error(`Boardwalk guide search has ${search.length} passages.`);
          }
          this.emitFile({
            type: "asset",
            fileName: `guide-content/pages/${page.slug}.md`,
            source,
          });
        }
      }

      this.emitFile({
        type: "asset",
        fileName: "guide-content/manifest.json",
        source: `${JSON.stringify({ sections: ADMIN_DOC_SECTIONS })}\n`,
      });

      this.emitFile({
        type: "asset",
        fileName: "guide-content/search.json",
        source: `${JSON.stringify({ passages: search })}\n`,
      });

      for (const image of [...images].sort()) {
        this.emitFile({
          type: "asset",
          fileName: `guide-content/images/${image}`,
          source: readFileSync(path.join(imagesRoot, image)),
        });
      }
    },
  };
}
