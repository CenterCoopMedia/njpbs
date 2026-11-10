"use strict";

const { safeHref } = require("./safe-href");
const { publicRichText } = require("./live-blog");
const { transferError } = require("./cuez-transfer-contract");

function stripTransferMarkers(value) {
  const stripped = value.replace(/\[boardwalk-transfer:[a-f0-9]{64}\]/gi, "");
  return stripped === value ? value : stripped.trim();
}
const inlineNode = node => ["text", "hardBreak"].includes(node.type);
function blockContent(nodes) {
  const blocks = [];
  let inline = [];
  const flush = () => {
    if (inline.some(node => node.type === "hardBreak" || node.text?.trim())) blocks.push({ type: "paragraph", content: inline });
    inline = [];
  };
  for (const node of nodes) {
    if (inlineNode(node)) inline.push(node);
    else {
      flush();
      if (node.type === "listItem") {
        if (blocks.at(-1)?.type === "bulletList") blocks.at(-1).content.push(node);
        else blocks.push({ type: "bulletList", content: [node] });
      } else blocks.push(node);
    }
  }
  flush();
  return blocks;
}
function inlineContent(nodes) {
  return nodes.flatMap(node => inlineNode(node) ? [node] : [...inlineContent(node.content ?? []), { type: "hardBreak" }]);
}
function textContent(nodes) {
  return nodes.map(node => node.type === "text" ? node.text : node.type === "hardBreak" ? "\n" : textContent(node.content ?? [])).join("");
}

// Match the editor's portable node/mark set. The shared owner strips attributes.
async function importRichText(html, baseUrl) {
  if (typeof html !== "string" || html.length > 512000 || !html.isWellFormed()) throw transferError("output_unavailable");
  const { parseFragment } = await import("parse5");
  const fragment = parseFragment(html);
  const omitted = new Set();
  let count = 0;
  const blocks = { p: "paragraph", h1: "heading", h2: "heading", h3: "heading",
    ul: "bulletList", ol: "orderedList", li: "listItem", blockquote: "blockquote", pre: "codeBlock" };
  const marks = { strong: "bold", b: "bold", em: "italic", i: "italic", code: "code" };
  const dropped = new Set(["script", "style", "iframe", "object", "embed", "svg", "math", "template", "form", "input", "img", "video", "audio"]);
  function convert(node, inherited = [], depth = 0) {
    if (++count > 10000 || depth > 50) throw transferError("output_unavailable");
    if (node.nodeName === "#text") {
      const text = node.value.replace(/\[boardwalk-transfer:[a-f0-9]{64}\]/gi, "");
      if (text !== node.value) omitted.add("Internal transfer markers were omitted.");
      return text ? [{ type: "text", text, ...(inherited.length ? { marks: inherited } : {}) }] : [];
    }
    if (node.nodeName === "#comment") return [];
    const tag = node.tagName;
    if (dropped.has(tag)) { omitted.add("Embedded or active content was omitted."); return []; }
    if (tag === "br") return [{ type: "hardBreak" }];
    let nextMarks = inherited;
    if (marks[tag]) nextMarks = [...inherited.filter(mark => mark.type !== marks[tag]), { type: marks[tag] }];
    if (tag === "a") {
      let href = safeHref(node.attrs?.find(attr => attr.name === "href")?.value);
      if (href && baseUrl) {
        try {
          const link = new URL(href, baseUrl);
          href = link.username || link.password ? null : safeHref(link.href);
        } catch { href = null; }
      }
      if (href) nextMarks = [...inherited.filter(mark => mark.type !== "link"), { type: "link", attrs: { href } }];
      else omitted.add("An unsupported link was removed.");
    }
    const children = (node.childNodes ?? []).flatMap(child => convert(child, nextMarks, depth + 1));
    if (["div", "section", "article"].includes(tag)) return blockContent(children);
    if (!blocks[tag]) {
      if (tag && !marks[tag] && !["a", "span", "div", "section", "article"].includes(tag)) omitted.add("Unsupported formatting was converted to text.");
      return children;
    }
    const type = blocks[tag];
    if (type === "codeBlock") {
      const text = textContent(children);
      return [{ type, content: text ? [{ type: "text", text }] : [] }];
    }
    if (["bulletList", "orderedList"].includes(type)) {
      const items = children.filter(node => node.type !== "text" || node.text.trim()).map(node =>
        node.type === "listItem" ? node : { type: "listItem", content: [{ type: "paragraph", content: inlineContent([node]) }] });
      return items.length ? [{ type, content: items }] : [];
    }
    if (["listItem", "blockquote"].includes(type)) {
      const content = blockContent(children);
      if (!content.length || type === "listItem" && content[0].type !== "paragraph") content.unshift({ type: "paragraph" });
      return [{ type, content }];
    }
    return [{ type, ...(type === "heading" ? { attrs: { level: tag === "h3" ? 3 : 2 } } : {}), content: inlineContent(children) }];
  }
  const converted = fragment.childNodes.flatMap(node => convert(node));
  const content = blockContent(converted);
  return { document: publicRichText({ type: "doc", content: content.length ? content : [{ type: "paragraph" }] }), warnings: [...omitted] };
}

module.exports = { importRichText, stripTransferMarkers };
