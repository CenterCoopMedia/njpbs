import {
  escapeHtml,
  type LinkCardBlock,
} from "./content-model";
import type { RenderedContentGroup } from "./content-row-render";
import {
  linkCardSearchText,
  linkCardYear,
  renderLinkCard,
} from "./coverage-list";

export interface LinkCardDirectoryGroup {
  kind: "link-card-directory";
  groups: RenderedContentGroup[];
}

export interface ContentBlockGroup {
  kind: "block";
  group: RenderedContentGroup;
}

export type PublicContentGroup = LinkCardDirectoryGroup | ContentBlockGroup;

export interface ConsecutiveLinkCardYearGroup {
  year: string;
  groups: RenderedContentGroup[];
}

/** Group only consecutive top-level link cards. Cards inside rows stay independent. */
export function groupLinkCardDirectories(
  groups: readonly RenderedContentGroup[],
): PublicContentGroup[] {
  const result: PublicContentGroup[] = [];
  for (let index = 0; index < groups.length;) {
    if (groups[index].block.type !== "link_card") {
      result.push({ kind: "block", group: groups[index] });
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < groups.length && groups[end].block.type === "link_card") end += 1;
    const run = groups.slice(index, end);
    if (run.length >= 2) result.push({ kind: "link-card-directory", groups: run });
    else result.push({ kind: "block", group: run[0] });
    index = end;
  }
  return result;
}

/** Keep the saved card sequence intact for the static, no-JavaScript directory. */
export function groupLinkCardsByConsecutiveYear(
  groups: readonly RenderedContentGroup[],
): ConsecutiveLinkCardYearGroup[] {
  const result: ConsecutiveLinkCardYearGroup[] = [];
  for (const group of groups) {
    if (group.block.type !== "link_card") {
      throw new Error("A link card directory can contain only link cards.");
    }
    const year = linkCardYear(group.block.data) ?? "";
    const current = result.at(-1);
    if (current?.year === year) current.groups.push(group);
    else result.push({ year, groups: [group] });
  }
  return result;
}

/** Render the same directory HTML for static Astro pages and runtime Contact. */
export function renderLinkCardDirectory(
  groups: readonly RenderedContentGroup[],
): string {
  const cards = groups.map((group, initialIndex) => {
    if (group.block.type !== "link_card") {
      throw new Error("A link card directory can contain only link cards.");
    }
    return { block: group.block, initialIndex };
  });
  const articleDirectory = cards.some(({ block }) => Boolean(
    block.data.source || block.data.date,
  ));
  const noun = articleDirectory ? "articles" : "links";
  const sortable = new Set(cards.map(({ block }) => block.data.date).filter(Boolean)).size > 1;
  const yearHeadingLevel = Math.min(
    6,
    Math.max(2, groups[0]?.generatedHeadingLevel ?? 2),
  );
  const cardHeadingLevel = Math.min(6, yearHeadingLevel + 1);
  const cardById = new Map<string, { block: LinkCardBlock; initialIndex: number }>(
    cards.map((card) => [card.block.id, card]),
  );
  const yearGroups = groupLinkCardsByConsecutiveYear(groups).map(({ year, groups }) => ({
    year,
    cards: groups.map((group) => cardById.get(group.block.id)!),
  }));
  const sortControl = sortable
    ? `<label class="coverage-list__sort"><span>Sort ${noun}</span><select data-coverage-sort><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label>`
    : "";
  const controls = `<div class="coverage-list__controls" data-coverage-controls hidden><label class="coverage-list__search"><span>Search ${noun}</span><input type="search" autocomplete="off" placeholder="Search ${noun}" data-coverage-search-input></label>${sortControl}<p class="coverage-list__status" data-coverage-status role="status" aria-live="polite" aria-atomic="true">${cards.length} ${noun}</p></div>`;
  const renderedGroups = yearGroups.map(({ year, cards: yearCards }) => {
    const escapedYear = escapeHtml(year);
    const heading = year
      ? `<h${yearHeadingLevel}>${escapedYear}</h${yearHeadingLevel}>`
      : "";
    const entries = yearCards.map(({ block, initialIndex }) => {
      const headingLevel = year ? cardHeadingLevel : yearHeadingLevel;
      return `<li class="coverage-list__card" data-block-id="${escapeHtml(block.id)}" data-block-type="${block.type}" data-coverage-entry data-coverage-entry-date="${escapeHtml(block.data.date ?? "")}" data-coverage-entry-index="${initialIndex}" data-coverage-search="${escapeHtml(linkCardSearchText(block.data))}">${renderLinkCard(block.data, headingLevel)}</li>`;
    }).join("");
    return `<section class="coverage-list__group" data-coverage-group data-coverage-year="${escapedYear}">${heading}<ul class="coverage-list__grid" role="list">${entries}</ul></section>`;
  }).join("");
  const empty = `<div class="coverage-list__empty" data-coverage-empty hidden><strong>No matching ${noun}</strong><p>Try a different search.</p></div>`;
  return `<section class="link-card-directory coverage-list${sortable ? "" : " link-card-directory--search-only"}" data-coverage-list data-coverage-noun="${noun}">${controls}<div class="coverage-list__groups" data-coverage-groups>${renderedGroups}</div>${empty}</section>`;
}
