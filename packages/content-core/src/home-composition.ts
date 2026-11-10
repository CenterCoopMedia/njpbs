import { homeBandBackground } from "./home-band-background.ts";
import {
  PROMOTION_PLAYLIST_PLACEMENTS,
  type CardGridBlock,
  type ContentShelfData,
  type CtaRowBlock,
  type PageBlock,
  type ProseBlock,
  type PromotionPlaylistPlacement,
  type RichTextDoc,
} from "./content-model";
import { HOME_PASSPORT_CONTENT, homeStartItems, type HomeStartItem, type HomePassportContent } from "./home-section-render";
import { HOME_DESTINATIONS, homeCompositionError, homeDetailText, homePassportHeading } from "./home-composition-contract";

function paragraph(text: string): RichTextDoc {
  return { type: "doc", content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : [] }] };
}

// A fresh draft proposal, never a read-time seed or database write. IDs are
// placeholders until the existing save boundary assigns canonical block IDs.
export function homeCompositionDefaults(): PageBlock[] {
  const start = homeStartItems(HOME_DESTINATIONS, true);
  const frame = (section: string, order: number) => ({ id: `new-${section}`, section, order, visible: true });
  const shelf = (section: string, order: number, data: ContentShelfData): PageBlock => ({ ...frame(section, order), type: "content_shelf", data });
  return [
    { ...frame("home-start", 0), type: "card_grid", data: { cards: start.map(item => ({ title: item.show, href: item.href, body: paragraph(item.detail ?? "") })) } },
    { ...frame("home-start-action", 1), type: "cta_row", data: { ctas: [{ label: "Full schedule", href: HOME_DESTINATIONS.schedule }] } },
    shelf("home-featured", 2, { title: "Featured on NJ PBS", source: "pbs_featured", itemLimit: 8, moreLabel: "Browse all", moreHref: HOME_DESTINATIONS.ondemand }),
    { ...frame("home-passport-copy", 3), type: "prose", data: { content: { type: "doc", content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: HOME_PASSPORT_CONTENT.heading }] },
      ...structuredClone(HOME_PASSPORT_CONTENT.body.content),
    ] } } },
    { ...frame("home-passport-action", 4), type: "cta_row", data: { ctas: [{ label: HOME_PASSPORT_CONTENT.actionLabel, href: HOME_DESTINATIONS.passport, variant: "primary" }] } },
    shelf("home-more", 5, { title: "More to watch", source: "pbs_more", itemLimit: 16, moreLabel: "Browse all", moreHref: HOME_DESTINATIONS.ondemand }),
    shelf("home-spotlight", 6, { title: "NJ Spotlight News", source: "spotlight_news", itemLimit: 8, moreLabel: "More news", moreHref: HOME_DESTINATIONS.spotlight }),
  ];
}

export interface HomeComposition {
  start: HomeStartItem[];
  scheduleLabel: string;
  passport: HomePassportContent;
  featured: ContentShelfData;
  more: ContentShelfData;
  spotlight: ContentShelfData;
}

export const HOME_CONTENT_AREAS = {
  before_start: "home-start",
  before_featured: "home-featured",
  before_passport: "home-passport-copy",
  before_more: "home-more",
  before_spotlight: "home-spotlight",
  after_spotlight: null,
} as const;

/** Start-here regions stay stored for conversion, but they are not public and have no editor. */
export function isHomeLockedAuthoringSection(section: string | undefined): boolean {
  return section === "home-start" || section === "home-start-action";
}

/** A section's button is part of that section, not a structural neighbor. */
export function isHomeSectionAction(section: string | undefined): boolean {
  return section === "home-start-action" || section === "home-passport-action";
}

/** Top-level Home groups the canvas and outline may use as move neighbors. */
export function homeStructuralMoveNeighbors<B extends { layout?: unknown; section?: string }>(
  blocks: readonly B[],
): B[] {
  return blocks.filter((block) => block.layout === undefined && !isHomeSectionAction(block.section));
}

export type HomeContentArea = keyof typeof HOME_CONTENT_AREAS;

/** Group added content by the next fixed section without changing stored order.
 * Call after Home admission. The same boundaries drive editor and public layout.
 */
export function homeContentAreas<B extends Pick<PageBlock, "section" | "type">>(blocks: readonly B[]): Record<HomeContentArea, B[]> {
  const areas: Record<HomeContentArea, B[]> = { before_start: [], before_featured: [], before_passport: [], before_more: [], before_spotlight: [], after_spotlight: [] };
  let area: HomeContentArea = "after_spotlight";
  for (const block of [...blocks].reverse()) {
    if (block.type === "promotion_playlist") continue;
    if (block.section !== undefined) {
      const boundary = (Object.keys(HOME_CONTENT_AREAS) as HomeContentArea[]).find(key => HOME_CONTENT_AREAS[key] === block.section);
      if (boundary) area = boundary;
      continue;
    }
    areas[area].unshift(block);
  }
  return areas;
}

const HOME_SECTION_ACTIONS: Readonly<Partial<Record<string, string>>> = {
  "home-start": "home-start-action",
  "home-passport-copy": "home-passport-action",
};

/** Identity members of one Home section. Recovery and Passport pairs are atomic. */
export function homeSectionMemberIds<B extends { id: string; section?: string }>(blocks: readonly B[], id: string): string[] {
  const block = blocks.find(candidate => candidate.id === id);
  if (!block) return [];
  const body = Object.entries(HOME_SECTION_ACTIONS).find(([body, action]) => body === block.section || action === block.section);
  return body ? blocks.filter(candidate => body.includes(candidate.section ?? "")).map(candidate => candidate.id) : [id];
}

type HomeOrderedBlock = {
  id: string;
  type: string;
  section?: string;
  data: object;
};

/** Public Home placement for a manual shelf. Missing values keep the factory default. */
export function homePromotionPlacement(block: HomeOrderedBlock): PromotionPlaylistPlacement | null {
  if (block.type !== "promotion_playlist") return null;
  const placement = (block.data as { placement?: unknown }).placement;
  return (PROMOTION_PLAYLIST_PLACEMENTS as readonly string[]).includes(placement as string)
    ? placement as PromotionPlaylistPlacement
    : "before_featured";
}

function homeNamedPlacement(section: string | undefined): PromotionPlaylistPlacement | null {
  const area = (Object.keys(HOME_CONTENT_AREAS) as HomeContentArea[]).find(key => HOME_CONTENT_AREAS[key] === section);
  return area && area !== "after_spotlight" ? area : null;
}

/** Placement implied by the next named Home section after `id`. */
export function homePlacementFromFollowingSection(blocks: readonly HomeOrderedBlock[], id: string): PromotionPlaylistPlacement | null {
  const start = blocks.findIndex(block => block.id === id);
  if (start < 0) return null;
  for (let index = start + 1; index < blocks.length; index += 1) {
    const placement = homeNamedPlacement(blocks[index]?.section);
    if (placement) return placement;
  }
  return null;
}

/** Visual Home order: added content, same-placement shelves, then the named section. */
export function homeStructuralBlocks<B extends HomeOrderedBlock>(blocks: readonly B[]): B[] {
  const areas = homeContentAreas(blocks as readonly (B & Pick<PageBlock, "section" | "type">)[]);
  const bySection = new Map<string, B>();
  for (const block of blocks) {
    if (block.section !== undefined) bySection.set(block.section, block);
  }
  const promotions = blocks.filter(block => block.type === "promotion_playlist");
  const result: B[] = [];
  for (const area of Object.keys(HOME_CONTENT_AREAS) as HomeContentArea[]) {
    result.push(...areas[area]);
    if (area !== "after_spotlight") {
      result.push(...promotions.filter(block => homePromotionPlacement(block) === area));
    }
    const section = HOME_CONTENT_AREAS[area];
    if (!section) continue;
    const named = bySection.get(section);
    if (named) result.push(named);
    const action = HOME_SECTION_ACTIONS[section];
    const actionBlock = action ? bySection.get(action) : undefined;
    if (actionBlock) result.push(actionBlock);
  }
  const used = new Set(result.map(block => block.id));
  for (const block of blocks) {
    if (!used.has(block.id)) result.push(block);
  }
  return result;
}

// Validate before mapping, including every required region's presence. A new
// malformed composition cannot drop silently into the legacy page frame.
export function resolveHomeComposition(
  version: unknown,
  blocks: readonly PageBlock[],
  assets: Readonly<Record<string, { url: string }>> = {},
  { complete = true }: { complete?: boolean } = {},
): HomeComposition | null {
  const error = homeCompositionError("home", version, blocks, { complete });
  if (error) throw new Error(error);
  if (version === undefined) return null;
  const start = blocks.find(block => block.section === "home-start") as CardGridBlock;
  for (const card of start.visible ? start.data.cards : []) {
    if (card.imageAssetId && !assets[card.imageAssetId]?.url) {
      throw new Error(`Missing Home pathway image ${card.imageAssetId}`);
    }
  }
  return homeCompositionView(blocks, assets);
}

// Presentation only. The editor keeps the fixed region structure while a person
// types temporarily blank labels. Persistence and public admission must use
// resolveHomeComposition/homeCompositionError before calling this mapper.
export function homeCompositionView(
  blocks: readonly PageBlock[],
  assets: Readonly<Record<string, { url: string }>> = {},
): HomeComposition {
  const bySection = new Map(blocks.map(block => [block.section, block]));
  const start = bySection.get("home-start") as CardGridBlock;
  const schedule = bySection.get("home-start-action") as CtaRowBlock;
  const passport = bySection.get("home-passport-copy") as ProseBlock;
  const passportAction = bySection.get("home-passport-action") as CtaRowBlock;
  const pathways = homeStartItems(HOME_DESTINATIONS, true);
  const shelf = (section: string) => (bySection.get(section) as Extract<PageBlock, { type: "content_shelf" }>).data;
  return {
    start: start.data.cards.map((card, index) => {
      const image = card.imageAssetId ? assets[card.imageAssetId]?.url : pathways[index].image;
      return { ...pathways[index], show: card.title, detail: homeDetailText(card.body) ?? "", image };
    }),
    scheduleLabel: schedule.data.ctas[0].label,
    passport: {
      backgroundImage: passport.visible ? homeBandBackground(passport.data.backgroundImageAssetId, assets) : undefined,
      heading: homePassportHeading(passport.data.content) ?? "",
      body: { type: "doc", content: passport.data.content.content.slice(1) },
      actionLabel: passportAction.data.ctas[0].label,
    },
    featured: shelf("home-featured"),
    more: shelf("home-more"),
    spotlight: shelf("home-spotlight"),
  };
}

export type HomeCompositionGroup =
  | { kind: "section"; section: string; blocks: PageBlock[] }
  | { kind: "content"; blocks: PageBlock[] };

/** The admitted v2 array, grouped only for rendering. Never a saved sections array.
 * Rows and semantic copy/action pairs remain whole. Withdrawn sections retain
 * their identities in storage/projection but have no rendered group.
 */
export function homeCompositionGroups(blocks: readonly PageBlock[]): HomeCompositionGroup[] {
  const groups: HomeCompositionGroup[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.section !== undefined && block.type !== "promotion_playlist") {
      const members: PageBlock[] = [block];
      if (HOME_SECTION_ACTIONS[block.section]) members.push(blocks[++index]);
      if (block.visible) groups.push({ kind: "section", section: block.section, blocks: members });
    } else {
      const members = [block];
      if (block.type === "row") {
        while (blocks[index + 1]?.layout?.rowId === block.id) members.push(blocks[++index]);
      }
      if (block.visible) {
        // Consecutive ordinary content shares authored heading context. Manual
        // shelves are independent sections and reset that context.
        const previous = groups.at(-1);
        if (block.type !== "promotion_playlist" && previous?.kind === "content" &&
            previous.blocks[0].type !== "promotion_playlist") previous.blocks.push(...members);
        else groups.push({ kind: "content", blocks: members });
      }
    }
  }
  return groups;
}
