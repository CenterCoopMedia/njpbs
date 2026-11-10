// Rehype plugin: drop HTML comment nodes from rendered markdown output.
//
// The content pages under src/content/pages/*.md can carry internal guardrail
// reminders as HTML comments. Those reminders are for whoever edits the source —
// they must never ship in the public
// HTML, where they would leak internal notes into the page source.
//
// Stripping at render time keeps the reminders in the .md source while emitting
// clean HTML. In Astro's markdown pipeline a top-level HTML comment reaches a
// rehype plugin as a hast "raw" node whose value is the literal "<!-- ... -->"
// string (rehype-raw, which would re-parse it into a "comment" node, runs after
// user rehype plugins). So this strips both shapes: a "comment" node, and a "raw"
// node whose trimmed value is entirely an HTML comment.

import { visit } from "unist-util-visit";
import type { Root } from "hast";

const COMMENT_ONLY = /^\s*<!--[\s\S]*?-->\s*$/;

export function rehypeStripComments() {
  return (tree: Root) => {
    visit(tree, (node, index, parent) => {
      if (!parent || typeof index !== "number") return undefined;
      const isComment = node.type === "comment";
      // Astro 7's HAST types no longer include `raw` in RootContent even though
      // unified still presents raw HTML to user plugins before rehype-raw.
      const rawNode = node as { type: string; value?: unknown };
      const isRawComment =
        rawNode.type === "raw" &&
        typeof rawNode.value === "string" &&
        COMMENT_ONLY.test(rawNode.value);
      if (isComment || isRawComment) {
        parent.children.splice(index, 1);
        // Re-visit this index, now holding the next sibling.
        return index;
      }
      return undefined;
    });
  };
}
