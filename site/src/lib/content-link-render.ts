import { parse } from "parse5";
import { escapeHtml } from "../../../packages/content-core/src/content-model";
import { contentLink, type ContentLinkMetadata } from "../../../packages/content-core/src/content-link.ts";
import { homeExternalLinkNotice } from "../../../packages/content-core/src/home-rail-render";

export interface ContentLinkEntry extends ContentLinkMetadata { path: string; previousSlugs?: readonly string[] }

/** Covers authored links as well as cards: rich text, live updates, newsletter
 * embeds, navigation and future renderers share this final HTML boundary. */
export function renderContentLinks(html: string, entries: readonly ContentLinkEntry[], baseUrl = "https://njpbs.org/", publicOwnPath?: string): string {
  const links = new Map<string, ContentLinkEntry>();
  for (const entry of entries) {
    if (entry.contentLinkMode !== "custom") continue;
    contentLink(entry, entry.path);
    for (const path of [entry.path, ...(entry.previousSlugs ?? []).map(slug => entry.path.startsWith("/posts/") ? `/posts/${slug}/` : `/${slug}/`)]) links.set(path, entry);
  }
  if (publicOwnPath && links.has(publicOwnPath)) return contentLinkFallbackHtml(links.get(publicOwnPath)!);
  if (!links.size) return html;
  const patches: { start: number; end: number; text: string }[] = [];
  const visit = (node: any) => {
    if (node.tagName === "a" && node.sourceCodeLocation?.startTag) {
      const href = node.attrs.find((attr: any) => attr.name === "href")?.value;
      let url: URL | undefined;
      try { if (typeof href === "string" && href.trim() && !href.startsWith("#")) url = new URL(href, baseUrl); } catch { /* Invalid existing links stay with their owner's validation. */ }
      const entry = url && ["https://njpbs.org", "https://www.njpbs.org", "https://dev.njpbs.org"].includes(url.origin) ? links.get(url.pathname.replace(/\/index\.html$/, "/").replace(/\/?$/, "/")) : undefined;
      if (entry) {
        const link = contentLink(entry, entry.path);
        const attributes = node.attrs.filter((attr: any) => !["href", "target", "rel"].includes(attr.name)).map((attr: any) => attr.name === "aria-label" ? { ...attr, value: attr.value.replace(/ ?\(opens in (?:a )?new tab\)/g, "") + (link.newTab ? " (opens in new tab)" : "") } : attr);
        attributes.push({ name: "href", value: link.href });
        if (link.newTab) attributes.push({ name: "target", value: link.target }, { name: "rel", value: link.rel });
        const tag = node.sourceCodeLocation.startTag;
        patches.push({ start: tag.startOffset, end: tag.endOffset, text: `<a${attributes.map((attr: any) => ` ${attr.name}="${escapeHtml(attr.value)}"`).join("")}>` });
        if (!link.newTab) for (const child of node.childNodes ?? []) {
          const source = child.sourceCodeLocation;
          if (child.tagName === "span" && source && (child.attrs ?? []).some((attr: any) => attr.name === "class" && attr.value.split(/\s+/).includes("sr-only")) && /^ ?\(opens in (?:a )?new tab\)$/.test((child.childNodes ?? []).map((text: any) => text.value ?? "").join(""))) patches.push({ start: source.startOffset, end: source.endOffset, text: "" });
        }
        const close = node.sourceCodeLocation.endTag;
        if (link.newTab && close && !/opens in (?:a )?new tab/.test(html.slice(tag.endOffset, close.startOffset))) patches.push({ start: close.startOffset, end: close.startOffset, text: homeExternalLinkNotice });
      }
    }
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(parse(html, { sourceCodeLocationInfo: true }));
  for (const patch of patches.sort((a,b) => b.start - a.start)) html = html.slice(0, patch.start) + patch.text + html.slice(patch.end);
  return html;
}

/** Noindex HTML retained for a static rollback; the public reader returns 302. */
export function contentLinkFallbackHtml(value: ContentLinkMetadata): string {
  const destination = contentLink(value, "");
  if (!destination.external) throw new Error("A content link fallback requires a custom URL");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow"><meta http-equiv="refresh" content="0;url=${escapeHtml(destination.href)}"><title>Continue to the linked content</title></head><body><main><h1>Continue to the linked content</h1><p><a href="${escapeHtml(destination.href)}"${destination.newTab ? ' target="_blank" rel="noopener noreferrer"' : ""}>Continue to ${escapeHtml(new URL(destination.href).hostname)}${destination.newTab ? homeExternalLinkNotice : ""}</a></p></main></body></html>`;
}
