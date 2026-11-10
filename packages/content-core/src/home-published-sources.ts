import { readHomeNewscastPacket } from "./home-newscast-published.ts";
import { readHomeHeroCatalog } from "./home-hero.ts";
import { readHomeEditorialSourceReceipt, homeCatalogJson } from "./home-source-catalog.ts";
import type {
  HomeNewsCard,
  HomeProgramCard,
  HomeSourceSnapshot,
} from "./home-rail-render";
import { safeHref } from "./safe-href.ts";
import { spotlightStoryImage } from "./spotlight-image.mjs";
import { homeSourceImage } from "./home-source-curation.ts";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("A Home source card has invalid text.");
  return value;
}

function link(value: unknown): string {
  const href = text(value);
  if (safeHref(href) === null || !/^(https?:\/\/|\/(?!\/))/.test(href)) {
    throw new Error("A Home source card has an invalid link.");
  }
  return href;
}

function date(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error("A Home source has an invalid check time.");
  }
  return value;
}

function cards<T>(
  value: unknown,
  maximum: number,
  read: (card: Record<string, unknown>) => T,
): T[] {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    value.some((card) => !object(card))
  ) {
    throw new Error("The Home source card list is invalid.");
  }
  return value.map(read);
}

function program(card: Record<string, unknown>): HomeProgramCard {
  const image = homeSourceImage({ url: card.image, alt: "" });
  return {
    title: text(card.title),
    description: text(card.description),
    href: link(card.href),
    ...(image ? { image: image.url } : {}),
  };
}

function news(card: Record<string, unknown>): HomeNewsCard {
  const image = spotlightStoryImage(card);
  return {
    title: text(card.title),
    category: text(card.category),
    href: link(card.href),
    image: image.url, ...(image.fallbackUrl || card.fallbackImage !== undefined
      ? { fallbackImage: image.fallbackUrl ?? image.url } : {}),
    ...(card.dateLabel === undefined
      ? {}
      : { dateLabel: text(card.dateLabel) }),
  };
}

// A rejected hero catalog must not disable the independent shelf source cards.
function optionalHeroCatalog(value: unknown) {
  if (value === undefined) return {};
  try { return { heroCatalog: readHomeHeroCatalog(value) }; }
  catch { return {}; }
}

// A feed check time is not a publication receipt. Match both separately fetched
// files before the canvas calls these cards the published site's source data.
export function readHomeSourceSnapshot(
  value: unknown,
  publication: unknown,
): HomeSourceSnapshot {
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    !object(value.publication) ||
    !object(publication) ||
    publication.schemaVersion !== 1
  ) {
    throw new Error(
      "The Home source and publication receipts do not match. Try loading the cards again.",
    );
  }
  const receipt = value.publication;
  if (
    typeof receipt.buildBatchId !== "string" ||
    !receipt.buildBatchId ||
    !Number.isSafeInteger(receipt.generation) ||
    Number(receipt.generation) < 1 ||
    typeof receipt.commitSha !== "string" ||
    !/^[a-f0-9]{40}$/.test(receipt.commitSha) ||
    receipt.buildBatchId !== publication.buildBatchId ||
    receipt.generation !== publication.generation ||
    receipt.commitSha !== publication.commitSha
  ) {
    throw new Error(
      "The Home source and publication receipts do not match. Try loading the cards again.",
    );
  }
  if (
    !object(value.pbs) ||
    (value.pbs.source !== "media-manager" && value.pbs.source !== "manual") ||
    !object(value.spotlight) ||
    value.spotlight.source !== "spotlight-rss"
  ) {
    throw new Error("The Home source names are invalid.");
  }
  return {
    schemaVersion: 1,
    ...(value.editorial === undefined ? {} : { editorial: (() => {
      const editorial = readHomeEditorialSourceReceipt(value.editorial);
      if (homeCatalogJson({ buildBatchId: editorial.receipt.buildBatchId, generation: editorial.receipt.generation,
        commitSha: editorial.receipt.commitSha }) !== homeCatalogJson({ buildBatchId: receipt.buildBatchId,
        generation: receipt.generation, commitSha: receipt.commitSha })) throw new Error("Home catalog and publication receipts do not match.");
      return editorial;
    })() }),
    ...optionalHeroCatalog(value.heroCatalog),
    publication: {
      buildBatchId: receipt.buildBatchId,
      generation: Number(receipt.generation),
      commitSha: receipt.commitSha,
    },
    pbs: {
      source: value.pbs.source,
      ...(Object.hasOwn(value.pbs, "newscast") ? { newscast: readHomeNewscastPacket(value.pbs.newscast) } : {}),
      checkedAt: date(value.pbs.checkedAt),
      featured: cards(value.pbs.featured, 8, program),
      more: cards(value.pbs.more, 16, program),
    },
    spotlight: {
      source: "spotlight-rss",
      checkedAt: date(value.spotlight.checkedAt),
      cards: cards(value.spotlight.cards, 8, news),
    },
  };
}

