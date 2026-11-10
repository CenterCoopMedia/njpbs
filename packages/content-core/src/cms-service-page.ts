import { visibleLayoutBlocks } from "./content-layout";
import {
  renderRichText,
  safeHref,
  type CtaRowData,
  type PageBlock,
} from "./content-model";
import type {
  ResolvedRenderAsset,
} from "./content-render";
import {
  type LaunchFallbackPage,
  type LaunchLink,
} from "./launch-fallback";

export interface CmsServiceCard {
  label?: string;
  title: string;
  bodyHtml?: string;
  href?: string;
  external: boolean;
  imageAssetId?: string;
  image?: ResolvedRenderAsset;
}

export interface CmsServiceAction extends LaunchLink {
  variant?: CtaRowData["ctas"][number]["variant"];
}

export interface CmsServicePageProjection {
  blockIds: Partial<Record<"actions" | "body" | "cards" | "note" | "notice" | "noticeActions", string>>;
  page: LaunchFallbackPage;
  summary: string;
  actions: CmsServiceAction[];
  bodyHtml?: string;
  sections: Array<{ id: string; html?: string; actions?: CmsServiceAction[] }>;
  noticeHtml?: string;
  noticeActions: CmsServiceAction[];
  cards: CmsServiceCard[];
  noteHtml?: string;
  remainingBlocks: PageBlock[];
}

interface CmsServicePageInput {
  frame: LaunchFallbackPage;
  title: string;
  description: string;
  blocks: PageBlock[];
  assets: Record<string, ResolvedRenderAsset>;
}

const copyRegions: Record<string, readonly string[]> = {
  live: ["caption-guidance", "caption-actions"],
  kids: ["broadcast-guidance", "broadcast-actions"],
  about: [
    "what-njpbs-is",
    "montclair-role",
    "spotlight-announcement",
    "member-stations",
    "what-continues",
    "contact-guidance",
    "contact-actions",
  ],
};

function externalHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

function actionLinks(
  block: Extract<PageBlock, { type: "cta_row" }> | undefined,
): CmsServiceAction[] {
  return (block?.data.ctas ?? []).flatMap((action) => {
    const href = safeHref(action.href);
    return href === null
      ? []
      : [{
          label: action.label,
          href,
          external: externalHref(href),
          ...(action.variant ? { variant: action.variant } : {}),
        }];
  });
}

function firstRegionBlock<T extends PageBlock["type"]>(
  blocks: PageBlock[],
  section: string,
  type: T,
): Extract<PageBlock, { type: T }> | undefined {
  return blocks.find(
    (block): block is Extract<PageBlock, { type: T }> =>
      block.visible && block.section === section && block.type === type,
  );
}

export function projectCmsServicePage(
  input: CmsServicePageInput,
): CmsServicePageProjection {
  const blocks = visibleLayoutBlocks(input.blocks);
  const actionBlock = firstRegionBlock(blocks, "hero-actions", "cta_row");
  const bodyBlock = firstRegionBlock(blocks, "body-copy", "prose");
  const cardsBlock = firstRegionBlock(
    blocks,
    input.frame.slug === "watch" ? "watch-destinations" : "service-destinations",
    "card_grid",
  );
  const noteBlock = firstRegionBlock(blocks, "service-note", "prose");
  const givingPage = ["support", "give", "passport"].includes(input.frame.slug);
  const noticeBlock = givingPage
    ? firstRegionBlock(blocks, "transition-notice", "prose")
    : undefined;
  const noticeActionBlock = givingPage
    ? firstRegionBlock(blocks, "transition-actions", "cta_row")
    : undefined;
  const sectionBlocks = (copyRegions[input.frame.slug] ?? []).flatMap((region) => {
    const block = region.endsWith("-actions")
      ? firstRegionBlock(blocks, region, "cta_row")
      : firstRegionBlock(blocks, region, "prose");
    return block ? [block] : [];
  });
  const mappedIds = new Set<string>();
  for (const block of [
    actionBlock, bodyBlock, cardsBlock, noteBlock,
    noticeBlock, noticeActionBlock, ...sectionBlocks,
  ]) {
    if (block) mappedIds.add(block.id);
  }

  const actions = actionLinks(actionBlock);
  const fallback = input.frame;
  const sections = sectionBlocks
    .sort((a, b) => a.order - b.order)
    .map((block) => block.type === "prose"
      ? {
          id: block.id,
          html: renderRichText(block.data.content, {
            externalLinksNewTab: true,
            standaloneLinkClass: "public-page__section-links",
          }),
        }
      : { id: block.id, actions: actionLinks(block) });

  const cards = (cardsBlock?.data.cards ?? []).map((card) => {
    const href = safeHref(card.href);
    const image = card.imageAssetId
      ? input.assets[card.imageAssetId]
      : undefined;
    return {
      ...(card.label ? { label: card.label } : {}),
      title: card.title,
      ...(card.body ? { bodyHtml: renderRichText(card.body) } : {}),
      ...(href !== null ? { href } : {}),
      external: href !== null && externalHref(href),
      ...(image && card.imageAssetId
        ? { imageAssetId: card.imageAssetId, image }
        : {}),
    };
  });

  return {
    blockIds: {
      actions: actionBlock?.id,
      body: bodyBlock?.id,
      cards: cardsBlock?.id,
      note: noteBlock?.id,
      notice: noticeBlock?.id,
      noticeActions: noticeActionBlock?.id,
    },
    page: {
      ...fallback,
      title: input.title,
      description: input.description,
      body: [],
      // LaunchFallbackPage retains its required fallback CTA type, while the
      // component receives the exact zero-or-more saved action list separately.
      primaryAction: actions[0] ?? fallback.primaryAction,
      ...(actions[1]
        ? { secondaryAction: actions[1] }
        : { secondaryAction: undefined }),
    },
    summary: input.description,
    actions,
    sections,
    ...(noticeBlock ? { noticeHtml: renderRichText(noticeBlock.data.content) } : {}),
    noticeActions: actionLinks(noticeActionBlock),
    ...(bodyBlock ? { bodyHtml: renderRichText(bodyBlock.data.content) } : {}),
    cards,
    ...(noteBlock ? { noteHtml: renderRichText(noteBlock.data.content) } : {}),
    remainingBlocks: blocks.filter((block) => !mappedIds.has(block.id)),
  };
}
