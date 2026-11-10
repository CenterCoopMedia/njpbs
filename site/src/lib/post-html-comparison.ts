import { parse, type DefaultTreeAdapterMap } from "parse5";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
function element(node: Node): node is Element { return "tagName" in node; }
function children(node: Node): Node[] { return "childNodes" in node ? node.childNodes : []; }
function walk(node: Node): Element[] {
  return [...(element(node) ? [node] : []), ...children(node).flatMap(walk)];
}
function text(node: Node): string {
  if (element(node) && ["script", "style", "noscript", "template"].includes(node.tagName)) return "";
  return "value" in node ? node.value : children(node).map(text).join(" ");
}
function attr(node: Element, name: string): string { return node.attrs.find(value => value.name === name)?.value ?? ""; }
const normalized = (value: string) => value.replace(/\s+/g, " ").trim();
function url(value: string): string {
  if (!value) return "";
  try {
    const parsed = new URL(value, "https://njpbs.org");
    if (["njpbs.org", "dev-public.example.org"].includes(parsed.hostname)) return parsed.pathname + parsed.search + parsed.hash;
    return parsed.href;
  } catch { return value; }
}
const sorted = (values: string[]) => [...new Set(values)].sort();
export interface PostHtmlSemantics {
  title: string;
  bodyText: string;
  mediaSources: string[];
  links: string[];
  headTags: string[];
}

/** Compare content and SEO, independent of bundler hashes, whitespace and CSS.
 * Canonical/head URLs stay literal so a wrong dev canonical remains visible.
 */
export function postHtmlSemantics(html: string): PostHtmlSemantics {
  const nodes = walk(parse(html));
  const head = nodes.find(node => node.tagName === "head");
  const content = nodes.find(node => node.tagName === "article") ?? nodes.find(node => node.tagName === "main");
  if (!head || !content) throw new Error("Expected a full Post document with head and article/main");
  const headNodes = walk(head);
  const mediaSources = walk(content).flatMap(node => {
    if (!["img", "video", "source", "iframe", "audio", "track"].includes(node.tagName)) return [];
    return ["src", "srcset", "poster"].flatMap(name => attr(node, name) ? [`${node.tagName}:${name}:${url(attr(node, name))}`] : []);
  });
  const headTags = headNodes.flatMap(node => {
    if (node.tagName === "meta") return [JSON.stringify([...node.attrs].sort((a, b) => a.name.localeCompare(b.name)))];
    if (node.tagName === "link" && ["canonical", "alternate"].includes(attr(node, "rel"))) return [JSON.stringify([...node.attrs].sort((a, b) => a.name.localeCompare(b.name)))];
    if (node.tagName === "script" && attr(node, "type") === "application/ld+json") {
      const json = children(node).map(child => "value" in child ? child.value : "").join("");
      return [JSON.stringify(JSON.parse(json))];
    }
    return [];
  });
  return {
    title: normalized(text(headNodes.find(node => node.tagName === "title") ?? head)),
    bodyText: normalized(text(content)), mediaSources: sorted(mediaSources),
    links: sorted(nodes.filter(node => node.tagName === "a").map(node => `${url(attr(node, "href"))}|${normalized(text(node))}`)),
    headTags: sorted(headTags),
  };
}
export function comparePostHtml(live: string, dev: string) {
  const before = postHtmlSemantics(live);
  const after = postHtmlSemantics(dev);
  return (Object.keys(before) as (keyof PostHtmlSemantics)[])
    .filter(field => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
    .map(field => ({ field, live: before[field], dev: after[field] }));
}
