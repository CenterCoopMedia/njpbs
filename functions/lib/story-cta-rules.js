"use strict";
const { parseBlocks } = require("./content-blocks");
const MAX_STORY_CTA_RULES = 20;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const only = (value, keys) => Object.keys(value).every(key => keys.includes(key));

// Mirror of the shared settings rule contract. Consumer contract tests cover both.
function validateStoryCtaRules(value, version = 2) {
  if (!Array.isArray(value) || value.length > MAX_STORY_CTA_RULES) return "Use at most 20 story CTA rules.";
  const ids = new Set();
  for (const rule of value) {
    if (!object(rule) || !only(rule, ["id", "label", "enabled", "target", "position", "content"]) ||
        typeof rule.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(rule.id) || ids.has(rule.id)) return "Each rule needs a unique valid id.";
    ids.add(rule.id);
    if (typeof rule.label !== "string" || !rule.label.trim() || rule.label !== rule.label.trim() || rule.label.length > 100 ||
        // eslint-disable-next-line no-control-regex -- Labels must reject ASCII control characters.
        /[\u0000-\u001f\u007f]/.test(rule.label)) return "Give each rule a name of at most 100 characters.";
    if (typeof rule.enabled !== "boolean") return "Rule enabled must be a boolean.";
    if (!object(rule.target) || !only(rule.target, ["contentTypes"]) || !Array.isArray(rule.target.contentTypes) ||
        rule.target.contentTypes.length !== 1 || rule.target.contentTypes[0] !== "post") return "Rules can target stories only.";
    const position = rule.position;
    if (!object(position)) return "Choose a story body position.";
    if (version === 1 && (!only(position, ["kind"]) || position.kind !== "end")) return "Choose the end of the story body.";
    if (version === 2 && (position.kind === "after-paragraph"
      ? !only(position, ["kind", "count"]) || !Number.isSafeInteger(position.count) || Number(position.count) < 1 || Number(position.count) > 10000
      : !only(position, ["kind"]) || !["start", "end"].includes(String(position.kind)))) return "Choose start, end, or a paragraph number from 1 to 10000.";
    const content = rule.content;
    const types = version === 1 ? ["support_appeal"] : ["support_appeal", "newsletter_signup"];
    if (!object(content) || !only(content, ["type", "data"]) || !types.includes(String(content.type)) || !object(content.data)) return "Choose a supported CTA block.";
    if (content.data.backgroundImageAssetId) return "Automatic appeals use text and a button. Add images in the story body.";
    const parsed = parseBlocks([{ id: "cta", order: 0, visible: true, ...content }]);
    if (!parsed.ok) return "Complete the CTA block with a safe link and its required text.";
  }
  return null;
}
module.exports = { MAX_STORY_CTA_RULES, validateStoryCtaRules };
