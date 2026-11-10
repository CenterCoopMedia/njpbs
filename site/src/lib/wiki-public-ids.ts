// Build-time scan of the OKF bundle for the set of PUBLIC concept ids.
//
// Read by astro.config.mjs and handed to the rehype link rewriter so it can tell
// a link to a published concept (-> /wiki/ route) from an internal link that
// must be redacted to plain text. Kept separate from wiki.ts because it touches the filesystem
// (node only); the pure link/slug logic in wiki.ts stays fs-free and unit-tested.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const PUBLIC_TRUE = /^\s*public:\s*true\s*$/m;

/** Walk `wikiDir` and return the ids (relative POSIX path, no `.md`) of files whose frontmatter sets `public: true`. */
export function readPublicWikiIds(wikiDir: string): string[] {
  const ids: string[] = [];

  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".md")) {
        const fm = FRONTMATTER.exec(readFileSync(full, "utf8"));
        if (fm && PUBLIC_TRUE.test(fm[1])) {
          ids.push(relative(wikiDir, full).replace(/\\/g, "/").replace(/\.md$/, ""));
        }
      }
    }
  }

  walk(wikiDir);
  return ids.sort();
}
