import { parseBlocks, type PageBlock, type RichTextDoc } from "./content-model";
import { validateSection } from "./editor-admin";
import rolloutDefaults from "./support-page-rollout-defaults.json";

const regions = new Map([
  ["hero-actions", "cta_row"], ["transition-notice", "prose"],
  ["transition-actions", "cta_row"], ["body-copy", "prose"],
  ["service-destinations", "card_grid"],
]);

/** Reviewed public copy captured October 6, 2026; never a substitute for staff edits. */
export function supportCompositionDefaults(): PageBlock[] {
  const parsed = parseBlocks(structuredClone(rolloutDefaults));
  if (!parsed.ok) throw new Error(`Support rollout defaults are invalid: ${parsed.error}`);
  return parsed.blocks;
}

function richText(doc: RichTextDoc): string {
  const visit = (node: RichTextDoc["content"][number]): string =>
    `${node.text ?? ""} ${(node.content ?? []).map(visit).join(" ")}`;
  return doc.content.map(visit).join(" ");
}

export interface SupportCompositionPlan {
  changed: boolean;
  blocks: PageBlock[];
  insertedIds: string[];
  retainedIds: string[];
}

/** Keep payloads, visibility and IDs intact; only placement and template slots change. */
export function planSupportPageComposition(document: {
  serviceCompositionVersion?: unknown;
  blocks?: unknown;
}): SupportCompositionPlan {
  const parsed = parseBlocks(document.blocks ?? [], { complete: false });
  if (!parsed.ok) throw new Error(`Support blocks are invalid: ${parsed.error}`);
  const blocks = structuredClone(parsed.blocks);
  if (document.serviceCompositionVersion === 1) {
    return { changed: false, blocks, insertedIds: [], retainedIds: blocks.map(block => block.id) };
  }
  if (document.serviceCompositionVersion !== undefined) throw new Error("Unknown service composition version");
  const mapped = blocks.filter(block => regions.has(block.section ?? ""));
  for (const [section, type] of regions) {
    const matches = mapped.filter(block => block.section === section);
    if (matches.length > 1 || matches.some(block => block.type !== type)) {
      throw new Error(`Ambiguous ${section} content; review it in Boardwalk before migrating`);
    }
  }
  // A partially edited legacy composition may reflect deliberate staff removals.
  // Do not interpret its gaps as permission to restore deleted copy.
  if (mapped.length && ["transition-notice", "body-copy", "service-destinations"].some(
    region => !mapped.some(block => block.section === region),
  )) throw new Error("Partial template composition; review missing parts before migrating");
  if (!mapped.length && blocks.some(block => block.type === "card_grid" ||
    (block.type === "prose" && /Giving and Passport during the transition|Prefer to mail a check\?/i.test(richText(block.data.content))))) {
    throw new Error("Template content may already exist as ordinary blocks; review before migrating");
  }
  const defaults = mapped.length ? [] : supportCompositionDefaults();
  const collisions = defaults.filter(block => blocks.some(existing => existing.id === block.id));
  if (collisions.length) throw new Error("A migration block ID already exists without the composition version");
  const source = mapped.length ? mapped : defaults;
  const rank = (block: PageBlock) => mapped.length
    ? [...regions.keys()].indexOf(block.section!)
    : defaults.findIndex(item => item.id === block.id);
  const fixed = source.sort((a, b) => rank(a) - rank(b));
  const card = fixed.find(block => block.type === "card_grid")!;
  const remaining = blocks.filter(block => !mapped.includes(block)).sort((a, b) => a.order - b.order);
  // Sam's DAF block (including any inline FAQ) and all other staff additions keep
  // their relative order. The destination row follows them.
  const arranged = [...fixed.filter(block => block !== card), ...remaining, card].map((block, order) => {
    const { section, ...copy } = block;
    return { ...copy, ...(section && !regions.has(section) ? { section } : {}), order } as PageBlock;
  });
  const validation = parseBlocks(arranged, { complete: false });
  if (!validation.ok) throw new Error(validation.error);
  const error = validateSection("programLanding", arranged);
  if (error) throw new Error(error.detail);
  return { changed: true, blocks: arranged, insertedIds: defaults.map(block => block.id), retainedIds: blocks.map(block => block.id) };
}
