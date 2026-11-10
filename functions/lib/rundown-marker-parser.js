"use strict";

const { fingerprint, fail } = require("./live-production-requests");
const { parseBannerText } = require("./live-production-contract");

const PARSER_VERSION = "markers-1";
const excludedSection = text => /^(?:future(?: shows?)?|pretapes?|reference(?: material)?|reusable (?:reporter )?lower.thirds|practice)(?:\s*[:/]|\s*$)/i.test(text.trim());
const productionCue = text => /^(?:SCRIPT|ANCHOR|TRACK|SOT|VO|VIDEO|AUDIO|ANIMATION|WIPE|ROLL|TAKE|MEDIA|CUE|END LOWER THIRDS)\s*[:-]/i.test(text.trim());
const placeholder = text => !text.trim() || /^(?:TBD|TK|TODO|[-_…]+|\[.*\]|<.*>)$/i.test(text.trim());
const annotation = text => /\[[^\]]*\]|\{[^}]*\}|\(\([^)]*\)\)|\[\[|https?:\/\//i.test(text);

/** Explicit markers create proposals only. Ambiguous passages have no default template. */
function extractMarkedBanners(snapshot) {
  const proposals = [], diagnostics = [], occurrences = new Map();
  let lower = false, excluded = false, excludedAtLevel = null, enclosingLevel = null, previousTab = null, context = null, group = [];
  function propose(entries, marker, proposedText, flags = []) {
    const first = entries[0];
    const rawLines = entries.map(entry => entry.text);
    if (rawLines.every(placeholder)) return;
    if (rawLines.some(annotation)) { proposedText = null; flags.push("editorial_annotation"); }
    const contextKey = fingerprint([snapshot.documentId, first.tabId, first.segmentId, marker]);
    const occurrence = (occurrences.get(contextKey) ?? 0) + 1;
    occurrences.set(contextKey, occurrence);
    if (proposals.length >= 100) fail("Review at most 100 marked banner proposals per source read.", 413);
    const candidate = { id: fingerprint([contextKey, occurrence]).slice(0, 32), contextKey,
      marker, occurrence, tabId: first.tabId, segmentId: first.segmentId, segmentTitle: first.segmentTitle,
      tabTitle: first.tabTitle, order: proposals.length, rawLines,
      text: proposedText ? parseBannerText(proposedText) : null, flags: [...new Set(flags)],
      passages: entries.map(entry => ({ sourceId: entry.sourceId, location: entry.location, startIndex: entry.startIndex, text: entry.sourceText })) };
    candidate.fingerprint = fingerprint({ contextKey, occurrence, text: candidate.text, rawLines, order: candidate.order });
    proposals.push(candidate);
  }
  function flush() {
    if (!group.length) return;
    if (group.length === 2 && /^\s*NAME\s*:/i.test(group[0].text) && /^\s*TITLE\s*:/i.test(group[1].text)) {
      const name = group[0].text.replace(/^\s*NAME\s*:\s*/i, ""), title = group[1].text.replace(/^\s*TITLE\s*:\s*/i, "");
      if (name.trim() && !placeholder(name)) propose(group, "lower_thirds:name_title", { templateId: "name_title", name, title });
    } else if (group.length === 1 && !/^\s*(?:NAME|TITLE)\s*:/i.test(group[0].text)) {
      propose(group, "lower_thirds:headline", { templateId: "headline", headline: group[0].text });
    } else propose(group, "lower_thirds:unresolved", null, ["ambiguous_grouping"]);
    group = [];
  }
  for (const block of snapshot.blocks) {
    const nextContext = `${block.tabId}:${block.segmentId}`;
    if (context !== nextContext || block.heading) {
      flush(); lower = false; context = nextContext;
      if (previousTab !== block.tabId) { excludedAtLevel = null; excluded = false; enclosingLevel = null; previousTab = block.tabId; }
      if (block.heading) {
        const level = block.headingLevel ?? 1;
        // TITLE is the document header; body labels use the nearest story level.
        enclosingLevel = level === 0 ? null : level;
        if (excludedAtLevel !== null && level <= excludedAtLevel) excludedAtLevel = null;
        if (excludedSection(block.segmentTitle)) excludedAtLevel ??= level;
        excluded = excludedAtLevel !== null;
      }
    }
    const lines = block.text.replaceAll("\u000b", "\n").split("\n");
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      const entry = { ...block, text: line, sourceText: line };
      if (excludedSection(line)) { flush(); lower = false; excluded = true; excludedAtLevel ??= block.headingLevel ?? enclosingLevel ?? Infinity; diagnostics.push({ code: "excluded_section", sourceId: block.sourceId }); continue; }
      if (excluded) continue;
      if (block.heading) continue;
      const marked = /^\s*(BANNER|RA\s+BANNER\s*#(\d+))\s*:\s*(.*)$/i.exec(line);
      if (marked) {
        flush();
        const copy = [marked[3]];
        while (lineIndex + 1 < lines.length && lines[lineIndex + 1].trim() &&
          !/^\s*(?:BANNER|RA\s+BANNER|LOWER\s+THIRDS|NAME|TITLE)\s*[:#]/i.test(lines[lineIndex + 1]) &&
          !productionCue(lines[lineIndex + 1]) && !excludedSection(lines[lineIndex + 1])) copy.push(lines[++lineIndex]);
        const headline = copy.join("\n");
        if (!placeholder(headline)) propose([{ ...entry, text: headline, sourceText: [line, ...copy.slice(1)].join("\n") }], marked[2] ? `ra_banner:${marked[2]}` : "banner",
          { templateId: "headline", headline });
        else diagnostics.push({ code: "empty_marker", sourceId: block.sourceId });
        continue;
      }
      if (/^\s*LOWER\s+THIRDS\s*:\s*$/i.test(line)) { flush(); lower = true; continue; }
      if (productionCue(line)) { flush(); lower = false; continue; }
      if (!line.trim()) { flush(); continue; }
      if (lower && (!placeholder(line) || annotation(line))) group.push(entry);
    }
  }
  flush();
  for (const candidate of proposals) {
    if (occurrences.get(candidate.contextKey) > 1) candidate.flags.push("repeated_marker");
  }
  return { schemaVersion: 1, parserVersion: PARSER_VERSION, sourceGeneration: snapshot.generation,
    sourceHash: snapshot.hash, sourceRevisionId: snapshot.revisionId, proposals, diagnostics };
}
module.exports = { PARSER_VERSION, extractMarkedBanners };
