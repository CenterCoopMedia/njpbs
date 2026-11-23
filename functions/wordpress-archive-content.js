"use strict";

const { createHash } = require("node:crypto");
const { parseFragment } = require("parse5");
const { isDataTableData } = require("./lib/data-table");
const { validateSection } = require("./lib/editor-section-contract");
const { embedPlayer, xVideoLink } = require("./lib/embed-player");
const { safeHref } = require("./lib/safe-href");

const MAX_HTML = 512_000;
const GROUPS = new Set(["article", "div", "section", "main", "aside", "header", "footer"]);
const CLASSIC_CONTAINERS = new Set(["p", "blockquote", "li"]);
const INLINE = new Set(["a", "span", "cite", "strong", "b", "em", "i", "code"]);
const INTERACTIVE = new Set(["script", "style", "object", "embed", "svg", "math", "template",
  "form", "input", "button", "select", "textarea", "noscript"]);
const STATIC_BLOCKS = new Set(["paragraph", "heading", "group", "columns", "column", "quote", "pullquote",
  "list", "list-item", "separator", "code", "preformatted", "image", "gallery", "table", "embed", "freeform"]);
const DYNAMIC_BLOCKS = new Set(["query", "latest-posts", "latest-comments", "archives", "categories", "rss",
  "search", "tag-cloud", "calendar", "social-links", "navigation", "block", "pattern", "template-part"]);
const CORE_SHORTCODES = new Set(["audio", "caption", "embed", "gallery", "playlist", "video", "wp_caption"]);
const MARKS = new Map([["strong", "bold"], ["b", "bold"], ["em", "italic"], ["i", "italic"], ["code", "code"]]);
const children = node => node.childNodes ?? [];
const attr = (node, name) => node.attrs?.find(item => item.name === name)?.value;
const hasClass = (node, name) => attr(node, "class")?.split(/\s+/).includes(name);
const textNode = (text, marks = []) => ({ type: "text", text, ...(marks.length ? { marks } : {}) });
const isInline = node => ["text", "hardBreak", "classicBreak"].includes(node.type);
const visibleInline = node => node.type === "hardBreak" || (node.type === "text" && node.text.trim());

function isHidden(node) {
  const style = attr(node, "style")?.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, "") ?? "";
  return attr(node, "hidden") !== undefined
    || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\s*(?:!\s*important\s*)?(?=;|$)/i.test(style);
}

function paragraphs(pieces) {
  const result = [];
  let inline = [];
  function flush() {
    const first = inline.findIndex(visibleInline);
    if (first >= 0) {
      const content = [];
      let afterExplicitBreak = false;
      for (const node of inline.slice(first, inline.findLastIndex(visibleInline) + 1)) {
        if (node.type === "classicBreak") {
          if (!afterExplicitBreak) content.push({ type: "hardBreak" });
        } else {
          content.push(node);
          if (visibleInline(node)) afterExplicitBreak = node.type === "hardBreak";
        }
      }
      result.push({ type: "paragraph", content });
    }
    inline = [];
  }
  for (const piece of pieces) {
    if (isInline(piece)) inline.push(piece);
    else {
      flush();
      if (piece.type !== "paragraphBoundary") result.push(piece);
    }
  }
  flush();
  return result;
}

function plainText(pieces) {
  return pieces.map(node => {
    if (node.type === "text") return node.text;
    if (node.type === "hardBreak") return "\n";
    return plainText(node.content ?? []);
  }).join(pieces.some(piece => !isInline(piece)) ? "\n" : "");
}

function enforceTreeLimit(fragment) {
  let count = 0;
  function visit(node, depth) {
    return ++count <= 10_000 && depth <= 50 && children(node).every(child => visit(child, depth + 1));
  }
  return visit(fragment, 0);
}

/** Convert one WXR story body. Report fields are identifiers, fixed codes and offsets. */
function convertWordPressStory({ html, sourceRef, permalink, mediaByUrl = new Map() }) {
  const { source, postId } = sourceRef ?? {};
  if (typeof source !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(source)
    || typeof postId !== "string" || !/^\d{1,20}$/.test(postId)) {
    throw new TypeError("A WordPress archive source key and decimal post ID are required.");
  }
  const issues = new Map();
  function flag(code, location) {
    if (issues.size >= 200) {
      issues.set("report_limit", { code: "report_limit", start: 0, end: 0 });
      return;
    }
    const start = location?.startOffset ?? 0;
    const end = location?.endOffset ?? start;
    issues.set(`${start}:${end}:${code}`, { code, start, end });
  }
  function finish(blocks) {
    const items = [...issues.values()].sort((a, b) => a.start - b.start || a.end - b.end);
    return { blocks, report: { sourceRef: { source, postId },
      status: items.length ? "manual_review" : blocks.length ? "complete" : "skipped", issues: items } };
  }
  if (typeof html !== "string" || !html.isWellFormed()) {
    flag("invalid_body");
    return finish([]);
  }
  if (html.length > MAX_HTML) {
    flag("body_limit");
    return finish([]);
  }
  const fragment = parseFragment(html, {
    sourceCodeLocationInfo: true,
    onParseError: error => flag("malformed_html", error),
  });
  if (!enforceTreeLimit(fragment)) {
    flag("body_limit");
    return finish([]);
  }
  const closingShortcodes = new Set();
  for (const match of html.matchAll(/\[\/([a-z][\w:-]*)\]/gi)) closingShortcodes.add(match[1].toLowerCase());
  const classicStory = !/<!--\s*wp:[a-z]/i.test(html);
  const textOrigins = new WeakMap();

  function resolveHref(raw) {
    const value = typeof raw === "string" ? raw.trim() : "";
    // Network-path references in the archive inherit the original permalink's scheme.
    const href = /^\/\/[^/\\]/.test(value) ? value : safeHref(raw);
    if (!href) return null;
    try { return safeHref(new URL(href, permalink).href); }
    catch { return null; }
  }
  function link(node) {
    const raw = attr(node, "href");
    const href = resolveHref(raw);
    if (raw !== undefined && !href) flag("unsafe_link", node.sourceCodeLocation);
    return href;
  }
  function block(blockType, data, node) {
    return { blockType, data, location: node.sourceCodeLocation };
  }
  function richOnly(pieces) {
    return pieces.filter(piece => {
      if (!piece.blockType) return true;
      flag("nested_structured_content", piece.location);
      return false;
    });
  }
  function textWithShortcodes(node, marks) {
    const value = node.value;
    const parts = [];
    let parent = node.parentNode;
    while (INLINE.has(parent.tagName)) parent = parent.parentNode;
    const classicFlow = parent.nodeName === "#document-fragment" || GROUPS.has(parent.tagName)
      || (classicStory && CLASSIC_CONTAINERS.has(parent.tagName));
    function addText(text) {
      const chunks = classicFlow ? text.split(/\n[\t ]*\n+/) : [text];
      for (const [index, value] of chunks.entries()) {
        if (index) parts.push({ type: "paragraphBoundary" });
        const lines = classicFlow ? value.split("\n") : [value];
        for (const [lineIndex, line] of lines.entries()) {
          if (lineIndex) parts.push({ type: "classicBreak" });
          if (line) {
            const piece = textNode(line, marks);
            textOrigins.set(piece, node);
            parts.push(piece);
          }
        }
      }
    }
    function recognized(name, args, closing) {
      return (!args || /^[\s/]/.test(args)) && (closing || CORE_SHORTCODES.has(name.toLowerCase())
        || args.includes("=") || args.endsWith("/") || closingShortcodes.has(name.toLowerCase()));
    }
    let start = 0;
    for (const match of value.matchAll(/\[\[([a-z][\w:-]*)([^[\]]*)\]\]|\[(\/?)([a-z][\w:-]*)([^[\]]*)\]/gi)) {
      const [, escapedName, escapedArgs, closing, name, args] = match;
      if (!recognized(escapedName ?? name, escapedArgs ?? args, closing)) continue;
      addText(value.slice(start, match.index));
      if (escapedName) addText(match[0].slice(1, -1));
      else flag("shortcode", node.sourceCodeLocation);
      start = match.index + match[0].length;
    }
    addText(value.slice(start));
    return parts;
  }
  function project(nodes) {
    return plainText(richOnly(nodes.flatMap(node => convert(node)))).trim();
  }
  function image(node, marks) {
    const src = resolveHref(attr(node, "src"));
    const assetId = src && /^https?:\/\//.test(src) ? mediaByUrl.get(src) : undefined;
    if (typeof assetId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(assetId)) {
      flag("missing_media", node.sourceCodeLocation);
      return [];
    }
    const alt = attr(node, "alt") ?? "";
    const href = marks.find(mark => mark.type === "link")?.attrs.href;
    if (!alt.trim()) flag("missing_alt", node.sourceCodeLocation);
    return [block("image", { assetId, alt, ...(href ? { href } : {}) }, node)];
  }
  function embed(node, raw, linkFallback = false) {
    const url = resolveHref(raw);
    const canUseUrl = url && attr(node, "srcdoc") === undefined;
    const player = canUseUrl && embedPlayer(url, false);
    if (player) return [block("embed", { url: player.src }, node)];
    flag("unsupported_embed", node.sourceCodeLocation);
    const post = canUseUrl && xVideoLink(url);
    const href = post || (linkFallback && canUseUrl ? url : null);
    return href ? [{ type: "paragraph", content: [textNode(post ? "View post on X" : raw, [{ type: "link", attrs: { href } }])] }] : [];
  }
  function table(node) {
    const direct = children(node);
    const rows = direct.flatMap(child => ["thead", "tbody", "tfoot"].includes(child.tagName) ? children(child) : [child])
      .filter(child => child.tagName === "tr");
    const cells = rows.map(row => children(row).filter(cell => ["th", "td"].includes(cell.tagName)));
    const simple = cells[0]?.length && cells[0].every(cell => cell.tagName === "th")
      && !direct.some(isHidden) && !rows.some(isHidden)
      && cells.every((row, index) => row.every(cell => (index === 0 || cell.tagName === "td")
        && !isHidden(cell) && attr(cell, "rowspan") === undefined && attr(cell, "colspan") === undefined));
    const caption = direct.find(child => child.tagName === "caption");
    if (caption && children(caption).some(child => child.nodeName !== "#text")) {
      flag("table_formatting", caption.sourceCodeLocation);
    }
    const data = {
      title: caption && simple ? project(children(caption)) : "Table",
      csv: simple ? cells.map(row => row.map(cell => {
        if (children(cell).some(child => child.nodeName !== "#text")) flag("table_formatting", cell.sourceCodeLocation);
        return `"${project(children(cell)).replaceAll('"', '""')}"`;
      }).join(",")).join("\n") : "",
      source: "",
      sourceHref: "",
    };
    if (!simple || !isDataTableData(data, true)) {
      flag("unsupported_table", node.sourceCodeLocation);
      return [];
    }
    return [{ ...block("data_table", data, node), hasCaption: Boolean(caption) }];
  }
  function figure(node, marks) {
    const parts = children(node).map(child => ({
      caption: child.tagName === "figcaption" || hasClass(child, "wp-caption-text") ? child : null,
      pieces: convert(child, marks),
    }));
    const content = paragraphs(parts.filter(part => !part.caption).flatMap(part => part.pieces));
    const captions = parts.filter(part => part.caption);
    if (!captions.length) return content;
    const [only] = content;
    const [{ caption, pieces }] = captions;
    if (captions.length === 1 && content.length === 1 && ["image", "embed", "data_table"].includes(only.blockType)
      && children(caption).every(child => child.nodeName === "#text")
      && !isHidden(caption)
      && parts.indexOf(captions[0]) > parts.findIndex(part => part.pieces.includes(only))
      && !only.hasCaption) {
      const value = plainText(pieces).trim();
      if (value && (only.blockType !== "data_table" || isDataTableData({ ...only.data, title: value }, true))) {
        only.data[only.blockType === "data_table" ? "title" : "caption"] = value;
        return content;
      }
    }
    // Retain rich captions as editable prose, including the credit's links.
    return paragraphs(parts.flatMap(part => part.pieces));
  }
  function comment(node) {
    const marker = /^\s*wp:([a-z][a-z\d-]*(?:\/[a-z][a-z\d-]*)?)(?=\s|\/|$)/i.exec(node.data);
    if (!marker) return;
    const name = marker[1].startsWith("core-embed/") ? "embed" : marker[1].replace(/^core\//, "");
    if (STATIC_BLOCKS.has(name) && !node.data.trimEnd().endsWith("/")) return;
    const code = name === "shortcode" ? "shortcode" : name === "html" ? "interactive_markup"
      : DYNAMIC_BLOCKS.has(name) || name.startsWith("post-") ? "dynamic_block" : "unsupported_block";
    flag(code, node.sourceCodeLocation);
  }
  function convert(node, marks = [], literal = false) {
    const location = node.sourceCodeLocation;
    const tag = node.tagName;
    if (node.nodeName === "#text") {
      if (literal) return [textNode(node.value)];
      if (marks.length > 1 && marks.some(mark => mark.type === "code")) {
        flag("code_formatting", location);
        marks = marks.filter(mark => mark.type !== "code");
      }
      return textWithShortcodes(node, marks);
    }
    if (node.nodeName === "#comment") {
      comment(node);
      return [];
    }
    if (INTERACTIVE.has(tag)) {
      flag("interactive_markup", location);
      return [];
    }
    if (isHidden(node)) {
      flag("hidden_markup", location);
      return [];
    }
    if (tag === "br") return [{ type: "hardBreak" }];
    if (tag === "hr") return [block("divider", {}, node)];
    if (tag === "img") return image(node, marks);
    if (tag === "iframe") return embed(node, attr(node, "src"));
    if (tag === "audio" || tag === "video" || tag === "source") {
      flag("unsupported_media", location);
      return [];
    }
    if (tag === "table") return table(node);
    if (tag === "figure" || hasClass(node, "wp-caption")) return figure(node, marks);
    if (hasClass(node, "wp-block-embed__wrapper") && children(node).every(child => child.nodeName === "#text")) {
      return embed(node, children(node).map(child => child.value).join("").trim());
    }
    if (tag === "a") {
      const href = link(node);
      if (href) marks = [...marks.filter(mark => mark.type !== "link"), { type: "link", attrs: { href } }];
    }
    const mark = MARKS.get(tag);
    if (mark && !marks.some(item => item.type === mark)) marks = [...marks, { type: mark }];
    const pieces = children(node).flatMap(child => convert(child, marks, literal || tag === "pre"));
    if ((tag === "ul" && (hasClass(node, "blocks-gallery-grid") || hasClass(node, "wp-block-gallery")))
      || (tag === "li" && hasClass(node, "blocks-gallery-item"))) return paragraphs(pieces);
    if (GROUPS.has(tag) || tag === "p" || tag === "figcaption") return paragraphs(pieces);
    if (/^h[1-6]$/.test(tag)) {
      const level = tag === "h1" || tag === "h2" ? 2 : 3;
      if (tag !== "h2" && tag !== "h3") flag("heading_level", location);
      if (pieces.some(piece => !isInline(piece))) {
        flag("heading_layout", location);
        return paragraphs(pieces);
      }
      return [{ type: "heading", attrs: { level }, content: pieces }];
    }
    if (tag === "pre") {
      const value = plainText(richOnly(pieces));
      return [{ type: "codeBlock", content: value ? [textNode(value)] : [] }];
    }
    if (tag === "blockquote" || tag === "li") {
      const content = paragraphs(richOnly(pieces));
      if (tag === "li" && !["ul", "ol"].includes(node.parentNode.tagName)) {
        flag("list_layout", location);
        return content;
      }
      if (!content.length || (tag === "li" && content[0].type !== "paragraph")) content.unshift({ type: "paragraph" });
      return [{ type: tag === "li" ? "listItem" : "blockquote", content }];
    }
    if (tag === "ul" || tag === "ol") {
      const items = richOnly(pieces).filter(piece => piece.type === "listItem");
      const customNumbering = tag === "ol" && ((attr(node, "start") ?? "1") !== "1"
        || (attr(node, "type") ?? "1") !== "1" || attr(node, "reversed") !== undefined
        || children(node).some(child => child.tagName === "li" && attr(child, "value") !== undefined));
      if (pieces.some(piece => piece.type !== "listItem" && (!isInline(piece) || piece.text?.trim()))
        || customNumbering) flag("list_layout", location);
      return items.length ? [{ type: tag === "ul" ? "bulletList" : "orderedList", content: items }] : [];
    }
    if (!INLINE.has(tag)) flag("unsupported_markup", location);
    return pieces;
  }

  const blocks = [];
  const prefix = createHash("sha256").update(JSON.stringify([source, postId])).digest("hex").slice(0, 24);
  function add(type, data) {
    const order = blocks.length;
    blocks.push({ id: `wp-${prefix}-${order}`, type, order, visible: true, data });
  }
  let prose = [];
  function flush() {
    if (prose.length) add("prose", { content: { type: "doc", content: prose } });
    prose = [];
  }
  function classicEmbed(piece) {
    if (piece.type !== "paragraph" || piece.content.length !== 1) return piece;
    const [text] = piece.content;
    const raw = text.type === "text" && !text.marks ? text.text.trim() : "";
    return /^https?:\/\/\S+$/i.test(raw) ? embed(textOrigins.get(text), raw, true)[0] ?? piece : piece;
  }
  const content = paragraphs(children(fragment).flatMap(node => convert(node)));
  for (const piece of classicStory ? content.map(classicEmbed) : content) {
    if (piece.blockType) {
      flush();
      add(piece.blockType, piece.data);
    } else prose.push(piece);
  }
  flush();
  if (validateSection("post", blocks)) {
    flag("post_block_limit");
    return finish([]);
  }
  return finish(blocks);
}

module.exports = { convertWordPressStory };
