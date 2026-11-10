import { parse } from "parse5";
import { createHash } from "node:crypto";

export interface SearchPassage {
  id: string;
  url: string;
  title: string;
  text: string;
  vector?: number[];
  contentLinkUrl?: string;
  contentLinkNewTab?: boolean;
}
type Node = {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: Node[];
};
const attr = (node: Node, name: string) =>
  node.attrs?.find((a) => a.name === name)?.value;
function find(node: Node, predicate: (n: Node) => boolean): Node | undefined {
  if (predicate(node)) return node;
  for (const child of node.childNodes ?? []) {
    const match = find(child, predicate);
    if (match) return match;
  }
}
function textContent(node: Node | undefined): string {
  if (!node) return "";
  if (
    ["script", "style", "nav", "button"].includes(node.tagName ?? "") ||
    attr(node, "data-pagefind-ignore") !== undefined
  )
    return "";
  if (node.nodeName === "#text") return node.value ?? "";
  const content = (node.childNodes ?? []).map(textContent).join("");
  // Inline emphasis belongs to the surrounding word/sentence. Only structural
  // boundaries add whitespace; joining every node adds spaces before punctuation.
  return /^(br|div|p|li|ul|ol|h[1-6]|tr|td|dd|dt)$/.test(node.tagName ?? "")
    ? ` ${content} `
    : content;
}
function text(node: Node | undefined): string {
  return textContent(node).replace(/\s+/g, " ").trim();
}
export function extractPassages(
  html: string,
  url: string,
  scope: "public" | "guide",
): SearchPassage[] {
  const document = parse(html) as Node;
  const root = find(document, (n) => n.tagName === "html");
  if (
    scope === "public" &&
    (attr(root!, "data-pagefind-ignore") !== undefined ||
      /^\/(admin|wiki|prototype|design-system)(\/|$)/.test(url))
  )
    return [];
  if (scope === "guide" && !url.startsWith("/admin/docs/")) return [];
  const robots = find(
    document,
    (n) => n.tagName === "meta" && attr(n, "name")?.toLowerCase() === "robots",
  );
  if (
    scope === "public" &&
    /\bnoindex\b/i.test(attr(robots ?? document, "content") ?? "")
  )
    return [];
  const body = find(
    document,
    (n) => attr(n, "data-pagefind-body") !== undefined,
  );
  if (!body) return [];
  const title = text(
    find(body, (n) => n.tagName === "h1") ??
      find(document, (n) => n.tagName === "title")!,
  );
  const sections: { heading: string; anchor: string; parts: string[] }[] = [
    { heading: title, anchor: "", parts: [] },
  ];
  function walk(node: Node) {
    if (
      attr(node, "data-pagefind-ignore") !== undefined ||
      ["script", "style", "nav", "button"].includes(node.tagName ?? "")
    )
      return;
    if (/^h[23]$/.test(node.tagName ?? "")) {
      sections.push({
        heading: text(node),
        anchor: attr(node, "id") ?? "",
        parts: [],
      });
      return;
    }
    if (["p", "li", "td", "dd", "dt"].includes(node.tagName ?? "")) {
      sections.at(-1)!.parts.push(text(node));
      return;
    }
    for (const child of node.childNodes ?? []) walk(child);
  }
  walk(body);
  return sections.flatMap((section) => {
    const words = section.parts.join(" ").split(/\s+/).filter(Boolean);
    const result: SearchPassage[] = [];
    for (let offset = 0; offset < words.length; offset += 150) {
      const content = words.slice(offset, offset + 180).join(" ");
      if (!content) continue;
      const target =
        url + (section.anchor ? `#${encodeURIComponent(section.anchor)}` : "");
      result.push({
        id: createHash("sha256")
          .update(`${target}\n${offset}\n${content}`)
          .digest("hex")
          .slice(0, 24),
        url: target,
        title:
          section.heading === title ? title : `${title}: ${section.heading}`,
        text: content,
      });
    }
    return result;
  });
}
