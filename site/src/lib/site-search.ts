import { contentLink } from "../../../packages/content-core/src/content-link.ts";
import { pagefindExcerpt, plainExcerpt } from "./search-excerpt";
import { createPageMeaningSearch } from "./meaning-search";
import { recordSiteSearch } from "./analytics-consent";
// Pagefind's browser bundle is emitted after Astro builds, not imported by Vite.
interface SearchResult {
  url: string;
  excerpt: string;
  content?: string;
  meta: { title?: string; contentLinkUrl?: string; contentLinkNewTab?: string };
}
interface SearchIndex {
  filters(): Promise<Record<string, Record<string, number>>>;
  search(
    term: string | null,
    options?: { filters: Record<string, string> },
  ): Promise<{ results: { data(): Promise<SearchResult> }[] }>;
}

let indexPromise: Promise<SearchIndex> | undefined;
function loadIndex(): Promise<SearchIndex> {
  const bundlePath = "/pagefind/pagefind.js";
  return indexPromise ??= import(/* @vite-ignore */ bundlePath).catch(error => {
    indexPromise = undefined;
    throw error;
  });
}

async function loadResults(term: string, limit: number, filters: Record<string, string>) {
  const index = await loadIndex();
  const search = Object.keys(filters).length
    ? await index.search(term || null, { filters })
    : await index.search(term);
  const results = await Promise.all(
    search.results.slice(0, limit).map((result) => result.data()),
  );
  return { results, total: search.results.length };
}

function resultItem(result: SearchResult): HTMLLIElement {
  const url = new URL(result.url, location.origin);
  if (url.origin !== location.origin)
    throw new Error("Unexpected search result origin");
  const item = document.createElement("li");
  const heading = document.createElement("h2");
  const link = document.createElement("a");
  const destination = contentLink(result.meta.contentLinkUrl ? { contentLinkMode: "custom", contentLinkUrl: result.meta.contentLinkUrl, contentLinkNewTab: result.meta.contentLinkNewTab !== "false" } : {}, url.pathname + url.hash);
  link.href = destination.href;
  if (destination.newTab) { link.target = destination.target!; link.rel = destination.rel!; }
  link.textContent = result.meta.title || url.pathname;
  if (destination.newTab) {
    const notice = document.createElement("span"); notice.className = "sr-only"; notice.textContent = " (opens in new tab)"; link.append(notice);
  }
  heading.append(link);
  const excerpt = document.createElement("p");
  excerpt.append(pagefindExcerpt(result.excerpt, result.content));
  item.append(heading, excerpt);
  if (destination.external) { const domain = document.createElement("small"); domain.textContent = new URL(destination.href).hostname; item.append(domain); }
  return item;
}

export function mountSiteSearch(root: HTMLElement): void {
  const form = root.querySelector<HTMLFormElement>("form")!;
  const input = form.querySelector<HTMLInputElement>("input")!;
  const status = root.querySelector<HTMLElement>(".search-status")!;
  const list = root.querySelector<HTMLOListElement>("ol")!;
  const more = root.querySelector<HTMLButtonElement>("[data-search-more]")!;
  const recovery = root.querySelector<HTMLElement>("[data-search-recovery]")!;
  const filterGroup = form.querySelector<HTMLElement>("[data-search-filters]");
  const filterSelects = [...form.querySelectorAll<HTMLSelectElement>("[data-search-filter]")];
  const filterStatus = form.querySelector<HTMLElement>("[data-search-filter-status]");
  let filtersUnavailable = false;
  function selectedFilters(): Record<string, string> {
    return Object.fromEntries(filterSelects.filter(select => select.value)
      .map(select => [select.dataset.searchFilter!, select.value]));
  }
  const pageSize = 10;
  let revision = 0;
  let keywordPendingRevision: number | null = null;
  let debounce: ReturnType<typeof setTimeout>;
  let composing = false;
  const meaningStatus = root.querySelector<HTMLElement>(
    "[data-meaning-status]",
  )!;
  const meaning = createPageMeaningSearch(
    "public",
    (message) => {
      meaningStatus.textContent = message;
    },
    () => {
      if (input.value.trim() && !Object.keys(selectedFilters()).length && keywordPendingRevision !== revision) void search();
    },
  );
  window.addEventListener("pagehide", (event) => {
    if (!event.persisted) meaning.dispose();
  });

  async function search(limit = pageSize, record = false) {
    clearTimeout(debounce);
    const request = ++revision;
    const term = input.value.trim();
    const filters = selectedFilters();
    const filtered = Object.keys(filters).length > 0;
    if (!term && !filtered) return;
    const previousCount = list.children.length;
    const loadingMore = limit > pageSize;
    more.disabled = true;
    recovery.hidden = !filtersUnavailable;
    status.textContent = loadingMore ? "Loading more results…" : "Searching…";
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // Pagefind can leave a request pending after a failed index/worker fetch.
      // Bound the wait; a reload starts a fresh worker and clears its failed cache.
      let keywordUnavailable = false;
      let movedFocus = false;
      function render(results: SearchResult[], total: number) {
        const focused =
          document.activeElement instanceof HTMLAnchorElement &&
          list.contains(document.activeElement)
            ? document.activeElement.href
            : null;
        const items = results.map(resultItem);
        list.replaceChildren(...items);
        if (focused)
          items
            .map((item) => item.querySelector("a"))
            .find((link) => link?.href === focused)
            ?.focus();
        more.hidden = results.length >= total;
        more.disabled = false;
        const queryLabel = term ? `“${term}”` : "the selected filters";
        const emptyHint = filtered
          ? "Change or clear the program filters."
          : "Try fewer words or a different spelling.";
        status.textContent = total
          ? `${total} ${total === 1 ? "result" : "results"} for ${queryLabel}. Showing ${results.length}.`
          : `No results for ${queryLabel}. ${emptyHint}`;
        if (keywordUnavailable)
          status.textContent += " Keyword search is unavailable.";
        if (loadingMore && !movedFocus) {
          items[previousCount]?.querySelector("a")?.focus();
          movedFocus = true;
        }
      }

      keywordPendingRevision = request;
      const keyword = await Promise.race([
        loadResults(term, limit, filters),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Search timed out")),
            10_000,
          );
        }),
      ]).catch((error) => {
        if (filtered || !meaning.ready) throw error;
        keywordUnavailable = true;
        return { results: [] as SearchResult[], total: 0 };
      });
      if (keywordPendingRevision === request) keywordPendingRevision = null;
      clearTimeout(timeout);
      if (request !== revision) return;
      if (record && !keywordUnavailable && !filtered) recordSiteSearch(term, keyword.total);
      // Successful keyword results must not wait for local model inference.
      render(keyword.results, keyword.total);
      let results = keyword.results;
      let total = keyword.total;
      if (meaning.ready && !filtered) {
        const matches = await meaning.search(term).catch(() => []);
        if (request !== revision) return;
        const merged = new Map<
          string,
          { result: SearchResult; score: number }
        >();
        keyword.results.forEach((result, index) =>
          merged.set(result.url, { result, score: 1 / (60 + index + 1) }),
        );
        matches.forEach((passage, index) => {
          const existing = merged.get(passage.url);
          if (existing) {
            existing.score += 1 / (60 + index + 1);
            return;
          }
          const excerpt = document.createElement("span");
          excerpt.textContent = plainExcerpt(passage.text, 280);
          merged.set(passage.url, {
            result: {
              url: passage.url,
              excerpt: excerpt.innerHTML,
              meta: { title: passage.title, ...(passage.contentLinkUrl ? { contentLinkUrl: passage.contentLinkUrl, contentLinkNewTab: String(passage.contentLinkNewTab !== false) } : {}) },
            },
            score: 1 / (60 + index + 1),
          });
        });
        results = [...merged.values()]
          .sort((a, b) => b.score - a.score)
          .map((hit) => hit.result)
          .slice(0, limit);
        total = Math.max(keyword.total, merged.size);
        render(results, total);
      }
    } catch {
      if (request !== revision) return;
      status.textContent =
        "Search could not load. Your connection or the search service may be unavailable.";
      recovery.hidden = false;
      more.hidden = true;
    } finally {
      if (keywordPendingRevision === request) keywordPendingRevision = null;
      clearTimeout(timeout);
      if (request === revision) more.disabled = false;
    }
  }

  function updateQuery(immediate = false, record = false) {
    clearTimeout(debounce);
    // Invalidate on input, before the debounce or any asynchronous work finishes.
    revision += 1;
    list.replaceChildren();
    more.hidden = true;
    recovery.hidden = !filtersUnavailable;
    const filtered = Object.keys(selectedFilters()).length > 0;
    meaningStatus.hidden = filtered;
    const hasQuery = Boolean(input.value.trim()) || filtered;
    status.textContent = hasQuery
      ? "Searching…"
      : "Enter a word or phrase to search.";
    if (!hasQuery || composing) return;
    if (immediate) void search(pageSize, record);
    else debounce = setTimeout(() => void search(), 200);
  }

  input.addEventListener("input", () => updateQuery());
  filterSelects.forEach(select => select.addEventListener("change", () => updateQuery(true)));
  input.addEventListener("compositionstart", () => {
    composing = true;
  });
  input.addEventListener("compositionend", () => {
    composing = false;
    updateQuery();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    updateQuery(true, true);
  });
  form.addEventListener("reset", (event) => {
    event.preventDefault();
    input.value = "";
    filterSelects.forEach(select => { select.value = ""; });
    updateQuery();
    input.focus();
  });
  more.addEventListener(
    "click",
    () => void search(list.children.length + pageSize),
  );
  root.querySelector<HTMLElement>("[data-search-fallback]")!.hidden = true;
  form.hidden = false;
  if (filterGroup) {
    void loadIndex().then(index => index.filters()).then(filters => {
      for (const select of filterSelects) {
        const restored = select.value;
        const values = Object.keys(filters[select.dataset.searchFilter!] ?? {}).sort((a, b) => a.localeCompare(b));
        values.forEach(value => {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = value;
          select.append(option);
        });
        select.disabled = values.length === 0;
        select.value = values.includes(restored) ? restored : "";
      }
      filterGroup.hidden = filterSelects.every(select => select.disabled);
    }).catch(() => {
      filtersUnavailable = true;
      if (filterStatus) filterStatus.textContent = "Program filters could not load. Reload search to try again.";
      recovery.hidden = false;
    });
  }
  // Browser form restoration (back/forward) can supply an existing query.
  updateQuery();
}
