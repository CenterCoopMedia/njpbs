const INTERVAL = 60_000;
const MAX_DELAY = 15 * INTERVAL;
const CONTENT = "[data-election-results-content]";

interface ResultsBlock {
  element: HTMLElement;
  content: HTMLElement;
  html: string;
}

/** The public HTML already has the publisher's current authority and cache rules.
 * Reuse that route; do not fetch CMS data or introduce a second results feed. */
export function installElectionResults(view: Window): () => void {
  const doc = view.document;
  const blocks: ResultsBlock[] = Array.from(doc.querySelectorAll<HTMLElement>("[data-election-results]"))
    .flatMap(element => {
      const content = element.querySelector<HTMLElement>(CONTENT);
      return content ? [{ element, content, html: content.innerHTML }] : [];
    });
  if (!blocks.length) return () => {};
  const stopFilters = blocks.map(block => installFilters(block.element, view));
  let delay = INTERVAL;
  let nextCheck = Date.now() + delay;
  let timer = 0;
  let request: AbortController | undefined;
  let stopped = false;

  function schedule() {
    view.clearTimeout(timer);
    if (!stopped && !doc.hidden && !request) {
      timer = view.setTimeout(refresh, Math.max(1_000, nextCheck - Date.now()));
    }
  }

  async function refresh() {
    if (stopped || doc.hidden || request) return;
    const controller = new AbortController();
    request = controller;
    const timeout = view.setTimeout(() => controller.abort(), 15_000);
    try {
      // Omit query/hash and cookies so the existing shared published-page cache
      // can serve readers. Redirects must never turn this into a cross-origin GET.
      const url = new URL(view.location.pathname, view.location.origin);
      const response = await view.fetch(url.href, { cache: "no-cache", credentials: "omit",
        mode: "same-origin", redirect: "error", signal: controller.signal, headers: { Accept: "text/html" } });
      if (!response.ok || !response.headers.get("content-type")?.includes("text/html") ||
          response.headers.get("x-njpbs-publication-refresh") === "pending" ||
          response.headers.get("publication-refresh") === "pending") throw new Error("Results unavailable");
      const html = await response.text();
      if (stopped || doc.hidden || controller.signal.aborted) return;
      // Template contents cannot load the page shell's images or embeds while
      // we extract the results. Only the selected results nodes become live.
      const published = doc.createElement("template");
      published.innerHTML = html;
      for (const block of blocks) {
        const current = Array.from(published.content.querySelectorAll<HTMLElement>("[data-election-results]"))
          .find(element => element.dataset.electionResults === block.element.dataset.electionResults);
        const content = current?.querySelector<HTMLElement>(CONTENT);
        if (!content) throw new Error("Results block unavailable");
        const nextHtml = content.innerHTML;
        if (nextHtml === block.html) continue;
        if (!replaceResults(view, block.content, content)) continue;
        block.html = nextHtml;
        const status = block.element.querySelector<HTMLElement>("[data-election-results-update]");
        const time = new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York", hour: "numeric", minute: "2-digit",
        }).format(new Date());
        if (status) status.textContent = `Results updated ${time} ET`;
      }
      delay = INTERVAL;
    } catch {
      if (!doc.hidden && !stopped) delay = Math.min(delay * 2, MAX_DELAY);
    } finally {
      view.clearTimeout(timeout);
      request = undefined;
      nextCheck = Date.now() + delay;
      schedule();
    }
  }

  const visibility = () => {
    if (doc.hidden) {
      view.clearTimeout(timer);
      request?.abort();
    } else schedule();
  };
  doc.addEventListener("visibilitychange", visibility);
  schedule();
  return () => {
    stopped = true;
    view.clearTimeout(timer);
    request?.abort();
    doc.removeEventListener("visibilitychange", visibility);
    stopFilters.forEach(stop => stop());
  };
}

/** Keep open tables, the focused control and the visible race in place. If a
 * focused control was removed, retain its content until the reader moves away. */
function replaceResults(view: Window, content: HTMLElement, published: HTMLElement): boolean {
  const active = view.document.activeElement;
  const newRaces = Array.from(published.querySelectorAll<HTMLElement>("[data-election-race]"));
  let focus: HTMLElement | undefined;
  if (active && content.contains(active)) {
    for (const attribute of ["id", "data-election-focus", "data-election-jump"]) {
      const key = active.getAttribute(attribute);
      if (!key) continue;
      focus = Array.from(published.querySelectorAll<HTMLElement>(`[${attribute}]`))
        .find(element => element.getAttribute(attribute) === key);
      break;
    }
    if (!focus) return false;
  }
  const scrollers: { element: HTMLElement; left: number; top: number }[] = [];
  const jumps = content.querySelector<HTMLElement>(".election-results__jumps ul");
  const nextJumps = published.querySelector<HTMLElement>(".election-results__jumps ul");
  if (jumps && nextJumps) scrollers.push({ element: nextJumps, left: jumps.scrollLeft, top: jumps.scrollTop });
  for (const race of content.querySelectorAll<HTMLElement>("[data-election-race]")) {
    const details = race.querySelector("details");
    const replacement = newRaces.find(element => element.dataset.electionRace === race.dataset.electionRace);
    if (details?.open) replacement?.querySelector("details")?.setAttribute("open", "");
    const scroller = race.querySelector<HTMLElement>(".election-results__table-scroll");
    const nextScroller = replacement?.querySelector<HTMLElement>(".election-results__table-scroll");
    if (scroller && nextScroller) scrollers.push({ element: nextScroller, left: scroller.scrollLeft, top: scroller.scrollTop });
  }
  const visible = Array.from(content.querySelectorAll<HTMLElement>("[data-election-race]"))
    .find(race => !race.hidden && race.getBoundingClientRect().bottom > 0 && race.getBoundingClientRect().top < view.innerHeight);
  const top = visible?.getBoundingClientRect().top;
  const scrollX = view.scrollX;
  content.replaceChildren(...Array.from(published.childNodes));
  scrollers.forEach(({ element, left, top }) => { element.scrollLeft = left; element.scrollTop = top; });
  focus?.focus({ preventScroll: true });
  content.parentElement?.dispatchEvent(new Event("election-results-updated"));
  const anchor = visible && newRaces.find(race => race.dataset.electionRace === visible.dataset.electionRace);
  // Outside the results, keep the browser's own anchor on the reader's text.
  if (anchor && !anchor.hidden && top !== undefined) {
    view.scrollTo({ left: scrollX, top: view.scrollY + anchor.getBoundingClientRect().top - top, behavior: "instant" });
  }
  return true;
}

/** Controls stay outside refreshed content, so a new snapshot keeps the query. */
function installFilters(element: HTMLElement, view: Window): () => void {
  const controls = element.querySelector<HTMLElement>("[data-election-filters]");
  const search = element.querySelector<HTMLInputElement>("[data-election-search-input]");
  const status = element.querySelector<HTMLSelectElement>("[data-election-status-input]");
  const count = element.querySelector<HTMLElement>("[data-election-filter-count]");
  const empty = element.querySelector<HTMLElement>("[data-election-no-matches]");
  if (!controls || !search || !status || !count || !empty) return () => {};
  function filter() {
    const query = search!.value.trim().toLocaleLowerCase("en-US");
    const races = Array.from(element.querySelectorAll<HTMLElement>("[data-election-race]"));
    const active = element.ownerDocument.activeElement;
    for (const race of races) {
      const matches = (race.dataset.electionSearch ?? "").toLocaleLowerCase("en-US").includes(query) &&
        (status!.value === "all" || race.dataset.electionStatus === status!.value);
      // A race and its jump link are one focus group during automatic updates.
      const hasFocus = race.contains(active) || active?.getAttribute("data-election-jump") === race.dataset.electionRace;
      race.hidden = !matches && !hasFocus;
      const link = Array.from(element.querySelectorAll<HTMLElement>("[data-election-jump]"))
        .find(link => link.dataset.electionJump === race.dataset.electionRace);
      if (link?.parentElement) link.parentElement.hidden = race.hidden;
    }
    const visible = races.filter(race => !race.hidden).length;
    count!.textContent = `${visible} of ${races.length} races`;
    empty!.hidden = visible !== 0;
    const jumps = element.querySelector<HTMLElement>(".election-results__jumps");
    if (jumps) jumps.hidden = visible === 0;
  }
  let focusTimer = 0;
  // A microtask can run between the browser's blur and focus steps, while the
  // active element is temporarily body. Wait until the focus transfer completes.
  const afterFocus = () => {
    view.clearTimeout(focusTimer);
    focusTimer = view.setTimeout(filter, 0);
  };
  controls.hidden = false;
  search.addEventListener("input", filter);
  status.addEventListener("change", filter);
  element.addEventListener("election-results-updated", filter);
  element.addEventListener("focusout", afterFocus);
  filter();
  return () => {
    view.clearTimeout(focusTimer);
    search.removeEventListener("input", filter);
    status.removeEventListener("change", filter);
    element.removeEventListener("election-results-updated", filter);
    element.removeEventListener("focusout", afterFocus);
  };
}
