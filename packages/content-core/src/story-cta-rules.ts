import { parseBlocks, type PageBlock, type SupportAppealBlock, type NewsletterSignupBlock, type RichTextNode } from "./content-model.ts";
import { visibleLayoutBlocks } from "./content-layout.ts";

export const MAX_STORY_CTA_RULES = 20;
export interface StoryCtaRule {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly target: { readonly contentTypes: readonly "post"[] };
  readonly position: { readonly kind: "start" | "end" } | { readonly kind: "after-paragraph"; readonly count: number };
  readonly content: Pick<SupportAppealBlock, "type" | "data"> | Pick<NewsletterSignupBlock, "type" | "data">;
}
export interface StoryCtasSettingsValues { readonly rules: readonly StoryCtaRule[] }

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));

/** The settings write boundary and public projections share this closed contract. */
export function validateStoryCtaRules(value: unknown, version = 2): string | null {
  if (!Array.isArray(value) || value.length > MAX_STORY_CTA_RULES) return "Use at most 20 story CTA rules.";
  const ids = new Set<string>();
  for (const rule of value) {
    if (!object(rule) || !only(rule, ["id", "label", "enabled", "target", "position", "content"]) ||
        typeof rule.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(rule.id) || ids.has(rule.id)) return "Each rule needs a unique valid id.";
    ids.add(rule.id);
    if (typeof rule.label !== "string" || !rule.label.trim() || rule.label !== rule.label.trim() || rule.label.length > 100 ||
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

/** Render a composition without writing automatic blocks into the saved story. */
export function insertStoryCtas(blocks: readonly PageBlock[], rules: readonly StoryCtaRule[], contentType = "post"): PageBlock[] {
  const selected = rules.filter(rule => rule.enabled && rule.target.contentTypes.some(type => type === contentType));
  if (!selected.length) return [...blocks];
  const ids = new Set(blocks.map(block => block.id));
  function uniqueId(base: string) {
    let id = base;
    while (ids.has(id)) id += "-cta";
    ids.add(id);
    return id;
  }
  const automatic = (rule: StoryCtaRule, layout?: PageBlock["layout"]): PageBlock => ({
    ...structuredClone(rule.content), id: uniqueId(`story-cta-${rule.id}`), visible: true, order: 0, ...(layout ? { layout } : {}),
  });
  const result: PageBlock[] = selected.filter(rule => rule.position.kind === "start").map(rule => automatic(rule));
  const afterParagraph = new Map<number, StoryCtaRule[]>();
  for (const rule of selected) if (rule.position.kind === "after-paragraph") {
    afterParagraph.set(rule.position.count, [...(afterParagraph.get(rule.position.count) ?? []), rule]);
  }
  const visibleIds = new Set(visibleLayoutBlocks(blocks).map(block => block.id));
  let paragraphs = 0;
  for (const block of blocks) {
    if (block.type !== "prose" || !visibleIds.has(block.id) || !afterParagraph.size) { result.push(block); continue; }
    let segment: RichTextNode[] = [], parts = 0;
    const appendSegment = () => {
      if (!segment.length) return;
      result.push({ ...block, id: parts++ === 0 ? block.id : uniqueId(`${block.id}-cta-part-${parts}`),
        data: { ...block.data, content: { ...block.data.content, content: segment } } });
      segment = [];
    };
    for (const node of block.data.content.content) {
      segment.push(node);
      if (node.type !== "paragraph") continue;
      paragraphs++;
      const matches = afterParagraph.get(paragraphs);
      if (!matches) continue;
      appendSegment();
      result.push(...matches.map(rule => automatic(rule, block.layout)));
    }
    appendSegment();
    if (!block.data.content.content.length) result.push(block);
  }
  result.push(...selected.filter(rule => rule.position.kind === "end").map(rule => automatic(rule)));
  return result.map((block, order) => ({ ...block, order }));
}
