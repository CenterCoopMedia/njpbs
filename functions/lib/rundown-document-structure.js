"use strict";

const { fail, fingerprint } = require("./live-production-requests");

const LIMITS = Object.freeze({ tabs: 10, blocks: 1000, characters: 100000, depth: 8, bytes: 512 * 1024 });
const sourceId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const tabId = value => typeof value === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(value);
function parseSourceConfig(value) {
  if (!value || Object.keys(value).some(key => !["documentId", "tabIds", "enabled"].includes(key)) ||
    !sourceId(value.documentId) || typeof value.enabled !== "boolean" || !Array.isArray(value.tabIds) ||
    !value.tabIds.length || value.tabIds.length > LIMITS.tabs || value.tabIds.some(id => !tabId(id)) ||
    new Set(value.tabIds).size !== value.tabIds.length) fail("Choose an exact document ID and 1–10 distinct tab IDs.");
  return { documentId: value.documentId, tabIds: [...value.tabIds], enabled: value.enabled };
}

// Offsets locate a passage in this read. They never identify a banner across reads.
function structureDocument(document, config) {
  if (document.documentId !== config.documentId || document.suggestionsViewMode !== "PREVIEW_WITHOUT_SUGGESTIONS") {
    fail("The Google Docs response must exclude suggestions and match the selected document.", 422);
  }
  const tabs = [], blocks = [], diagnostics = [];
  let characters = 0;
  function collect(items, depth = 0) {
    if (depth > LIMITS.depth) fail("Rundown tab nesting exceeds the intake budget.", 413);
    for (const tab of items) {
      if (tabs.length >= 100) fail("Rundown has too many tabs.", 413);
      tabs.push(tab);
      collect(tab.childTabs ?? [], depth + 1);
    }
  }
  collect(document.tabs ?? []);
  if (!tabs.length && document.body) tabs.push({ tabProperties: { tabId: "legacy", title: "Document" }, documentTab: { body: document.body } });
  const selected = config.tabIds.map(id => tabs.find(tab => tab.tabProperties?.tabId === id));
  if (selected.some(tab => !tab)) fail("A selected rundown tab is unavailable. The last good read is retained.", 422);
  for (const tab of selected) {
    const { tabId, title } = tab.tabProperties;
    if (!Array.isArray(tab.documentTab?.body?.content)) fail("A selected tab has unsupported content.", 422);
    let segment = { id: "body", title: "" };
    const headings = new Map();
    function walk(content, path, depth = 0) {
      if (depth > LIMITS.depth) fail("Rundown table nesting exceeds the intake budget.", 413);
      for (const [index, element] of (content ?? []).entries()) {
        const location = `${path}/${index}`;
        if (element.paragraph) {
          const paragraph = element.paragraph;
          const text = (paragraph.elements ?? []).filter(run => !run.suggestedInsertionIds?.length)
            .map(run => run.textRun?.content ?? "").join("").replace(/\r\n?/g, "\n").replace(/\n$/, "");
          if ((paragraph.elements ?? []).some(run => !run.textRun)) diagnostics.push({ code: "non_text_omitted", tabId, location });
          const style = paragraph.paragraphStyle ?? {};
          if (/^(HEADING_[1-6]|TITLE)$/.test(style.namedStyleType ?? "")) {
            const count = (headings.get(text) ?? 0) + 1;
            headings.set(text, count);
            segment = { id: style.headingId ?? fingerprint([text, count]).slice(0, 24), title: text };
          }
          characters += text.length;
          if (characters > LIMITS.characters || blocks.length >= LIMITS.blocks) fail("Rundown exceeds the character or passage budget.", 413);
          blocks.push({ sourceId: `${tabId}:${location}`, tabId, tabTitle: title ?? "", segmentId: segment.id,
            segmentTitle: segment.title, location, startIndex: element.startIndex ?? null, text,
            headingLevel: style.namedStyleType === "TITLE" ? 0 : /^HEADING_[1-6]$/.test(style.namedStyleType ?? "") ? Number(style.namedStyleType.slice(-1)) : null,
            heading: /^(HEADING_[1-6]|TITLE)$/.test(style.namedStyleType ?? "") });
        } else if (element.table) {
          for (const [row, value] of (element.table.tableRows ?? []).entries()) {
            for (const [cell, entry] of (value.tableCells ?? []).entries()) walk(entry.content, `${location}/r${row}/c${cell}`, depth + 1);
          }
        } else if (!element.sectionBreak) diagnostics.push({ code: "unsupported_structure", tabId, location });
      }
    }
    walk(tab.documentTab?.body?.content, "body");
  }
  const canonical = blocks.map(block => { const value = { ...block }; delete value.startIndex; return value; });
  const result = { schemaVersion: 1, documentId: document.documentId, revisionId: document.revisionId ?? null,
    hash: fingerprint(canonical), blocks, diagnostics };
  if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.bytes) fail("Structured rundown exceeds the storage budget.", 413);
  return result;
}
module.exports = { LIMITS, sourceId, parseSourceConfig, structureDocument };
