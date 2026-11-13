import { parseBlocks, type PageBlock, type SupportAppealBlock } from "./content-model.ts";

export const MAX_STORY_CTA_RULES = 20;
export interface StoryCtaRule {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly target: { readonly contentTypes: readonly "post"[] };
  readonly position: { readonly kind: "end" };
  readonly content: Pick<SupportAppealBlock, "type" | "data">;
}
export interface StoryCtasSettingsValues { readonly rules: readonly StoryCtaRule[] }

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));

/** The settings write boundary and public projections share this closed contract. */
export function validateStoryCtaRules(value: unknown): string | null {
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
    if (!object(rule.position) || !only(rule.position, ["kind"]) || rule.position.kind !== "end") return "Choose the end of the story body.";
    const content = rule.content;
    if (!object(content) || !only(content, ["type", "data"]) || content.type !== "support_appeal" || !object(content.data)) return "Choose a support appeal block.";
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
  const automatic = selected.map(rule => {
    let id = `story-cta-${rule.id}`;
    while (ids.has(id)) id += "-cta";
    ids.add(id);
    return { ...structuredClone(rule.content), id, visible: true, order: 0 };
  });
  return [...blocks, ...automatic].map((block, order) => ({ ...block, order }));
}
