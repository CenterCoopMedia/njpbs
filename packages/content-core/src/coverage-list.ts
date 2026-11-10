// Structured outside-coverage entries for custom Pages such as NJ PBS in the news.
// Editors add, reorder, and remove items through the shared list control. Stored
// prose that already lists linked coverage can be read into this shape without
// inventing a new record type.

import {
  COVERAGE_LIST_LIMITS,
  escapeHtml,
  isRichTextDoc,
  isSafeHref,
  safeHref,
  type CoverageEntry,
  type CoverageListData,
  type LinkCardData,
  type RichTextNode,
} from "./content-model.ts";
import { isCalendarDay } from "./editorial-dates.ts";
import { formatEditorialDate } from "./editorial-date-format.ts";

const MONTHS: ReadonlyArray<{ names: readonly string[]; month: number }> = [
  { names: ["january", "jan.", "jan"], month: 1 },
  { names: ["february", "feb.", "feb"], month: 2 },
  { names: ["march", "mar.", "mar"], month: 3 },
  { names: ["april", "apr.", "apr"], month: 4 },
  { names: ["may"], month: 5 },
  { names: ["june", "jun.", "jun"], month: 6 },
  { names: ["july", "jul.", "jul"], month: 7 },
  { names: ["august", "aug.", "aug"], month: 8 },
  { names: ["september", "sept.", "sept", "sep.", "sep"], month: 9 },
  { names: ["october", "oct.", "oct"], month: 10 },
  { names: ["november", "nov.", "nov"], month: 11 },
  { names: ["december", "dec.", "dec"], month: 12 },
];

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function parseCoverageDate(value: string): string | "" {
  const trimmed = value.trim();
  if (isCalendarDay(trimmed)) return trimmed;
  const numeric = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (numeric) {
    const candidate = `${numeric[3]}-${pad(Number(numeric[1]))}-${pad(Number(numeric[2]))}`;
    return isCalendarDay(candidate) ? candidate : "";
  }
  const named = new RegExp(
    `^(${MONTHS.flatMap((month) => month.names).map((name) => name.replace(".", "\\.")).join("|")})\\s+(\\d{1,2}),?\\s+(\\d{4})$`,
    "i",
  ).exec(trimmed);
  if (!named) return "";
  const monthName = named[1].toLowerCase();
  const month = MONTHS.find((entry) => entry.names.includes(monthName))?.month;
  if (!month) return "";
  const candidate = `${named[3]}-${pad(month)}-${pad(Number(named[2]))}`;
  return isCalendarDay(candidate) ? candidate : "";
}

function nodeText(node: RichTextNode | undefined): string {
  if (!node) return "";
  if (typeof node.text === "string") return node.text;
  return (node.content ?? []).map(nodeText).join("");
}

function firstHref(node: RichTextNode | undefined): string | null {
  if (!node) return null;
  const marked = node.marks?.find((mark) => mark.type === "link");
  if (marked) {
    const href = typeof marked.attrs?.href === "string" ? marked.attrs.href : "";
    return href;
  }
  for (const child of node.content ?? []) {
    const nested = firstHref(child);
    if (nested) return nested;
  }
  return null;
}

function linkedText(node: RichTextNode | undefined): string {
  if (!node) return "";
  if (node.marks?.some((mark) => mark.type === "link")) return nodeText(node);
  return (node.content ?? []).map(linkedText).join("");
}

function isYearHeading(text: string): boolean {
  return /^(19|20)\d{2}$/.test(text.trim());
}

function splitOutletAndDate(text: string): { outlet: string; date: string } | null {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  const separators = [" — ", " – ", " - ", ", "];
  for (const separator of separators) {
    let index = trimmed.lastIndexOf(separator);
    while (index > 0) {
      const date = parseCoverageDate(trimmed.slice(index + separator.length));
      const outlet = trimmed.slice(0, index).trim();
      if (date && outlet) return { outlet, date };
      index = trimmed.lastIndexOf(separator, index - 1);
    }
  }
  const dateOnly = parseCoverageDate(trimmed);
  if (dateOnly) return { outlet: "", date: dateOnly };
  return { outlet: trimmed, date: "" };
}

function looksLikeCoverageMeta(text: string): { outlet: string; date: string } | null {
  const meta = splitOutletAndDate(text);
  if (!meta) return null;
  if (meta.date) return meta;
  const outlet = meta.outlet.trim();
  if (!outlet || outlet.length > 80 || /[.?!]/.test(outlet)) return null;
  return meta;
}

function entryFromBlock(node: RichTextNode): CoverageEntry | null {
  const href = firstHref(node);
  if (!href) return null;
  const title = linkedText(node).replace(/\s+/g, " ").trim() || nodeText(node).replace(/\s+/g, " ").trim();
  if (!title || isYearHeading(title)) return null;
  let remainder = nodeText(node).replace(/\s+/g, " ").trim();
  if (title && remainder.startsWith(title)) remainder = remainder.slice(title.length).trim();
  remainder = remainder.replace(/^[-–—,:]\s*/, "");
  if (remainder) {
    const meta = looksLikeCoverageMeta(remainder);
    if (!meta) return null;
    return {
      title,
      outlet: meta.outlet,
      date: meta.date,
      url: href,
    };
  }
  return {
    title,
    outlet: "",
    date: "",
    url: href,
  };
}

function mergeMeta(entry: CoverageEntry, node: RichTextNode): boolean {
  if (firstHref(node) || linkedText(node).trim()) return false;
  const meta = looksLikeCoverageMeta(nodeText(node));
  if (!meta) return false;
  if (!entry.outlet) entry.outlet = meta.outlet;
  if (!entry.date) entry.date = meta.date;
  return true;
}

export interface CoverageProseInspection {
  entries: CoverageEntry[];
  leftover: boolean;
  convertible: boolean;
  overflow: boolean;
  overLimit: boolean;
  lostYearHeadings: boolean;
}

interface CoverageCollectState {
  leftover: boolean;
  lostYearHeadings: boolean;
  emptyYearHeading: boolean;
  currentYear: string;
  entriesInCurrentYear: number;
  unmatchedInCurrentYear: boolean;
}

export function linkCardYear(card: LinkCardData): string | null {
  return card.date && isCalendarDay(card.date) ? card.date.slice(0, 4) : null;
}

function entryYear(entry: CoverageEntry): string | null {
  return entry.date && isCalendarDay(entry.date) ? entry.date.slice(0, 4) : null;
}

function closeYearGroup(state: CoverageCollectState): void {
  if (!state.currentYear) return;
  if (state.unmatchedInCurrentYear) state.lostYearHeadings = true;
  if (state.entriesInCurrentYear === 0) state.emptyYearHeading = true;
}

function noteYearGroupEntry(state: CoverageCollectState, entry: CoverageEntry): void {
  if (!state.currentYear) return;
  state.entriesInCurrentYear += 1;
  if (entryYear(entry) !== state.currentYear) state.unmatchedInCurrentYear = true;
}

function collectFromNodes(
  nodes: readonly RichTextNode[] | undefined,
  entries: CoverageEntry[],
  state: CoverageCollectState,
): void {
  let current: CoverageEntry | null = null;
  const flush = () => {
    if (current && (current.title || current.url)) {
      noteYearGroupEntry(state, current);
      entries.push(current);
    }
    current = null;
  };
  for (const node of nodes ?? []) {
    if (node.type === "bulletList" || node.type === "orderedList") {
      flush();
      for (const item of node.content ?? []) collectFromNodes(item.content, entries, state);
      continue;
    }
    if (node.type === "listItem") {
      flush();
      collectFromNodes(node.content, entries, state);
      continue;
    }
    if (node.type === "heading" && isYearHeading(nodeText(node))) {
      flush();
      closeYearGroup(state);
      state.currentYear = nodeText(node).trim();
      state.entriesInCurrentYear = 0;
      state.unmatchedInCurrentYear = false;
      continue;
    }
    if (current && mergeMeta(current, node)) continue;
    const next = entryFromBlock(node);
    if (next) {
      flush();
      current = next;
      continue;
    }
    if (nodeText(node).trim()) {
      flush();
      state.leftover = true;
    }
  }
  flush();
}

function coverageFieldsOverLimit(entry: CoverageEntry): boolean {
  return entry.title.length > COVERAGE_LIST_LIMITS.title
    || entry.outlet.length > COVERAGE_LIST_LIMITS.outlet
    || entry.url.length > COVERAGE_LIST_LIMITS.url;
}

function isConvertibleCoverage(
  entries: readonly CoverageEntry[],
  flags: { overflow: boolean; lostYearHeadings: boolean; overLimit: boolean },
): boolean {
  if (flags.overflow || flags.lostYearHeadings || flags.overLimit || entries.length === 0) {
    return false;
  }
  return entries.some((entry) => Boolean(entry.date) || entry.outlet.trim().length > 0);
}

// A coverage entry can store a calendar day or a blank date, not a year alone.
// Year headings therefore survive conversion only when each item under them has
// a matching YYYY-MM-DD date. The stored list also caps at 100 items and at the
// title, outlet, and URL lengths the model accepts. Conversion is refused in
// those data-loss cases instead of dropping headings, extra rows, or field text.
export function inspectCoverageProse(value: unknown): CoverageProseInspection {
  if (!isRichTextDoc(value)) {
    return {
      entries: [],
      leftover: false,
      convertible: false,
      overflow: false,
      overLimit: false,
      lostYearHeadings: false,
    };
  }
  const entries: CoverageEntry[] = [];
  const state: CoverageCollectState = {
    leftover: false,
    lostYearHeadings: false,
    emptyYearHeading: false,
    currentYear: "",
    entriesInCurrentYear: 0,
    unmatchedInCurrentYear: false,
  };
  collectFromNodes(value.content, entries, state);
  closeYearGroup(state);
  if (state.emptyYearHeading && entries.length > 0) state.lostYearHeadings = true;
  const overflow = entries.length > COVERAGE_LIST_LIMITS.entries;
  const overLimit = entries.some(coverageFieldsOverLimit);
  return {
    entries,
    leftover: state.leftover,
    overflow,
    overLimit,
    lostYearHeadings: state.lostYearHeadings,
    convertible: isConvertibleCoverage(entries, {
      overflow,
      lostYearHeadings: state.lostYearHeadings,
      overLimit,
    }),
  };
}

export function coverageEntriesFromRichText(value: unknown): CoverageEntry[] {
  return inspectCoverageProse(value).entries;
}

export function linkCardSearchText(card: LinkCardData): string {
  const date = card.date ?? "";
  return [
    card.title,
    card.source ?? "",
    card.summary ?? "",
    date ? formatEditorialDate(date) : "",
    linkCardYear(card) ?? "",
  ].filter(Boolean).join(" ");
}

export function renderLinkCard(
  card: LinkCardData,
  headingLevel: number,
): string {
  const href = safeHref(card.url);
  const title = escapeHtml(card.title.trim());
  const source = card.source?.trim()
    ? `<span class="link-card__source">${escapeHtml(card.source.trim())}</span>`
    : "";
  const summary = card.summary?.trim()
    ? `<p class="link-card__summary">${escapeHtml(card.summary.trim())}</p>`
    : "";
  const dateValue = card.date ?? "";
  const dateLabel = dateValue ? formatEditorialDate(dateValue) : "";
  const date = dateLabel
    ? `<time class="link-card__date" datetime="${escapeHtml(dateValue)}">${escapeHtml(dateLabel)}</time>`
    : "";
  const body = `${source}<h${headingLevel} class="link-card__title">${title}</h${headingLevel}>${summary}${date}`;
  const content = href
    ? `<a class="link-card__link" href="${escapeHtml(href)}">${body}</a>`
    : `<div class="link-card__link">${body}</div>`;
  return `<article class="link-card" data-link-card>${content}</article>`;
}

function renderEntry(
  card: LinkCardData,
  entryIndex: number,
  headingLevel: number,
): string {
  return `<li class="coverage-list__card" data-coverage-entry data-coverage-entry-index="${entryIndex}" data-coverage-entry-date="${escapeHtml(card.date ?? "")}" data-coverage-search="${escapeHtml(linkCardSearchText(card))}">${renderLinkCard(card, headingLevel)}</li>`;
}

export function renderCoverageList(
  data: CoverageListData,
  generatedHeadingLevel: number,
): string {
  const entries = data.entries.filter((entry) => entry.title.trim() && (
    !entry.url.trim() || isSafeHref(entry.url)
  ));
  if (!entries.length) return "";
  const cards = entries.map((entry) => ({
    title: entry.title,
    url: entry.url,
    source: entry.outlet,
    date: entry.date,
  }));
  const groups: Array<{
    year: string | null;
    entries: Array<{ card: LinkCardData; index: number }>;
  }> = [];
  cards.forEach((card, index) => {
    const year = linkCardYear(card);
    const currentGroup = groups.at(-1);
    if (currentGroup?.year === year) currentGroup.entries.push({ card, index });
    else groups.push({ year, entries: [{ card, index }] });
  });
  const sections = groups.map(({ year, entries: groupEntries }) => {
    const heading = year
      ? `<h${generatedHeadingLevel}>${escapeHtml(year)}</h${generatedHeadingLevel}>`
      : "";
    const entryHeadingLevel = year
      ? Math.min(6, generatedHeadingLevel + 1)
      : generatedHeadingLevel;
    const yearValue = year ?? "";
    return `<div class="coverage-list__group" data-coverage-group data-coverage-year="${escapeHtml(yearValue)}">${heading}<ul class="coverage-list__grid" role="list">${groupEntries.map(({ card, index }) => renderEntry(card, index, entryHeadingLevel)).join("")}</ul></div>`;
  });
  const countLabel = `${entries.length} ${entries.length === 1 ? "article" : "articles"}`;
  const controls = `<div class="coverage-list__controls" data-coverage-controls hidden><label class="coverage-list__search"><span>Search articles</span><input type="search" autocomplete="off" placeholder="Search by title or outlet" data-coverage-search-input></label><label class="coverage-list__sort"><span>Sort articles</span><select data-coverage-sort><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label><p class="coverage-list__status" role="status" aria-live="polite" aria-atomic="true" data-coverage-status>${countLabel}</p></div>`;
  const empty = `<div class="coverage-list__empty" data-coverage-empty hidden><h${generatedHeadingLevel}>No matching articles</h${generatedHeadingLevel}><p>Try a different title or outlet.</p></div>`;
  return `<section class="coverage-list" data-coverage-list data-coverage-entry-count="${entries.length}">${controls}<div class="coverage-list__groups" data-coverage-groups>${sections.join("")}</div>${empty}</section>`;
}
