import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { youtubePlayerSrc } from "../../../packages/content-core/src/embed-player.ts";

/** Change only live, canonical player attributes, preserving the original bytes
 * for the visible player and JavaScript-disabled readers. */
export function deferYoutubeEmbeds(html: string): string {
  if (!html.includes("youtube")) return html;
  const patches: { start: number; end: number; text: string }[] = [];
  function visit(node: DefaultTreeAdapterTypes.Node): void {
    if ("tagName" in node && node.tagName === "iframe") {
      const src = node.attrs.find(attribute => attribute.name === "src")?.value;
      const location = node.sourceCodeLocation;
      const attribute = location?.attrs?.src;
      if (src && youtubePlayerSrc(src) === src && location?.endTag && attribute) {
        const frame = html.slice(location.startOffset, location.endOffset);
        const start = attribute.startOffset - location.startOffset;
        const end = attribute.endOffset - location.startOffset;
        const deferred = frame.slice(0, start) + frame.slice(start, end).replace(/^src\s*=/i, "data-deferred-youtube-src=") + frame.slice(end);
        patches.push({ start: location.startOffset, end: location.endOffset,
          text: `${deferred}<noscript><style>iframe[data-deferred-youtube-src]{display:none!important}</style>${frame}</noscript>` });
      }
    }
    if ("childNodes" in node) node.childNodes.forEach(visit);
  }
  visit(parseFragment(html, { sourceCodeLocationInfo: true }));
  for (const patch of patches.sort((a, b) => b.start - a.start)) {
    html = html.slice(0, patch.start) + patch.text + html.slice(patch.end);
  }
  return html;
}
