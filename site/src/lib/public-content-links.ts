import { visit } from "unist-util-visit";
import type { Root, Element } from "hast";
import { normalizePath } from "./wiki";

export function resolvePublicContentHref(rawHref: string): string {
  const href = rawHref.trim();
  if (
    href === "" ||
    href.startsWith("#") ||
    href.startsWith("/") ||
    href.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(href)
  ) {
    return href;
  }

  const tailIdx = href.search(/[#?]/);
  const path = tailIdx === -1 ? href : href.slice(0, tailIdx);
  const tail = tailIdx === -1 ? "" : href.slice(tailIdx);
  if (!path.toLowerCase().endsWith(".md")) return href;

  const normalized = normalizePath("", path);
  const filename = normalized.split("/").pop() ?? "";
  const slug = filename.replace(/\.md$/i, "");
  return slug ? `/${slug}/${tail}` : href;
}

export function rehypePublicContentLinks() {
  return (tree: Root, file: { path?: string; history?: string[] }) => {
    const path = (file?.path ?? file?.history?.[0] ?? "").replace(/\\/g, "/");
    if (!path.includes("/src/content/pages/")) return;

    visit(tree, "element", (node: Element) => {
      if (node.tagName !== "a" || !node.properties) return;
      const href = node.properties.href;
      if (typeof href !== "string") return;
      node.properties.href = resolvePublicContentHref(href);
    });
  };
}
