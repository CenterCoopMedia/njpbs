// Rehype plugin: rewrite the relative `.md` links inside rendered wiki pages.
//
// The OKF bundle links concept-to-concept with relative markdown links
// (`../systems/passport.md`). When we render a curated subset to HTML those links
// are resolved: a link to a PUBLIC concept points at its /wiki/ route; a real
// external URL opens in a new tab; and a link to a non-public concept — or to a
// file outside the bundle (the deep `docs/` research) — is REDACTED (the link is
// unwrapped to plain text) so internal content is never one click from the public
// wiki and the build carries no dangling internal link.
//
// Scoped to wiki source files only (path contains "/wiki/"), so it is a no-op for
// the design-preview content pages, which share Astro's global markdown pipeline.
// Markdown links are real `a` elements by the time user rehype plugins run, so we
// visit elements (not raw nodes — that is rehype-strip-comments' job).

import { visit } from "unist-util-visit";
import type { Root, Element, ElementContent } from "hast";
import { resolveWikiHref } from "./wiki.ts";

export interface RehypeWikiLinksOptions {
  /** entry ids (wiki-relative, no extension) whose pages are published */
  publicIds: string[];
}

export function rehypeWikiLinks(opts: RehypeWikiLinksOptions) {
  const publics = new Set(opts.publicIds);

  return (tree: Root, file: { path?: string; history?: string[] }) => {
    const path = (file?.path ?? file?.history?.[0] ?? "").replace(/\\/g, "/");
    const marker = "/wiki/";
    const idx = path.lastIndexOf(marker);
    if (idx === -1) return; // not a wiki source file — leave it alone
    const fromId = path.slice(idx + marker.length).replace(/\.md$/i, "");

    visit(
      tree,
      "element",
      (node: Element, index, parent) => {
        if (node.tagName !== "a" || !node.properties) return undefined;
        const href = node.properties.href;
        if (typeof href !== "string") return undefined;

        const resolved = resolveWikiHref(href, fromId, publics);

        if (resolved.kind === "redact") {
          // Unwrap: replace the <a> with its children (the link text), so the
          // internal target is not reachable from the public render.
          if (parent && typeof index === "number") {
            parent.children.splice(
              index,
              1,
              ...(node.children as ElementContent[]),
            );
            return index; // re-visit at this position (now the former children)
          }
          return undefined;
        }

        node.properties.href = resolved.href;
        // Real external links open safely in a new tab — also what the QA audit
        // expects of off-site anchors.
        if (resolved.kind === "external" && /^https?:\/\//i.test(resolved.href)) {
          node.properties.rel = ["noopener", "noreferrer"];
          node.properties.target = "_blank";
        }
        return undefined;
      },
    );
  };
}
