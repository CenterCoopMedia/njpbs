import { parseLiveBlogFeed, parseLiveBlogManifest, type LiveBlogManifest } from "../../../packages/content-core/src/live-blog-manifest";
import { resolveLiveBlogPresentation } from "../../../packages/content-core/src/live-blog";
import { installLiveBlogFollowUps } from "./live-blog-follow-ups";
import { installLiveBlogPagination } from "./live-blog-pagination";

const INTERVAL = 30_000;

/** Poll bounded metadata. Full updates use the reader control; follow-ups and
 * appearance refresh existing entries without changing the update count. */
export function installLiveBlogUpdates(root: HTMLElement, onLoaded: () => void = () => {}): void {
  if (root.dataset.updatesInstalled) return;
  const doc = root.ownerDocument, win = doc.defaultView;
  const marker = root.querySelector<HTMLScriptElement>("[data-live-blog-manifest]");
  const controls = root.querySelector<HTMLElement>("[data-live-blog-refresh]");
  const button = controls?.querySelector<HTMLButtonElement>("[data-live-blog-load]");
  const status = root.querySelector<HTMLElement>("[data-live-blog-announcement]");
  if (!win || !marker || !controls || !button || !status || !/^\/posts\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(win.location.pathname)) return;
  let applied: LiveBlogManifest;
  try {
    applied = parseLiveBlogManifest(JSON.parse(marker.textContent ?? ""));
    if (applied.updates.length !== applied.totalCount) return;
  } catch { return; }
  if (applied.coverageState === "ended") return;
  root.dataset.updatesInstalled = "true";
  controls.hidden = false; button.hidden = true;
  installLiveBlogFollowUps(root);
  let pagination = installLiveBlogPagination(root);
  let pending: LiveBlogManifest | undefined, count = 0, failures = 0, loading = false, stopped = false, observedEnded = false;
  let timer: ReturnType<typeof setTimeout> | undefined, active: AbortController | undefined;
  const head = doc.querySelector<HTMLElement>(".site-head");
  const positionControl = () => {
    if (stopped || !root.isConnected) return;
    const headerBottom = Math.max(0, head?.getBoundingClientRect().bottom ?? 0);
    const list = root.querySelector(".live-blog__updates");
    const inset = `${headerBottom}px`;
    if (root.style.getPropertyValue("--live-blog-header-bottom") !== inset) root.style.setProperty("--live-blog-header-bottom", inset);
    controls.toggleAttribute("data-sticky", !button.hidden && !!list && list.getBoundingClientRect().top < headerBottom);
    controls.toggleAttribute("data-menu-open", !!head?.querySelector('.nav-toggle[aria-expanded="true"]'));
  };
  win.addEventListener("scroll", positionControl, { passive: true });
  win.addEventListener("resize", positionControl);
  const headerResize = head && win.ResizeObserver ? new win.ResizeObserver(positionControl) : undefined;
  const menuChanges = head ? new win.MutationObserver(positionControl) : undefined;
  const observeHeader = () => {
    if (!head) return;
    headerResize?.observe(head);
    menuChanges?.observe(head, { attributes: true, subtree: true, attributeFilter: ["aria-expanded"] });
  };
  observeHeader(); positionControl();
  const url = new URL(win.location.pathname, win.location.origin);
  const feedUrl = new URL(url); feedUrl.searchParams.set("live-blog", "updates");
  const newEntries = (value: LiveBlogManifest) => value.updates.filter(entry => !applied.updates.some(old => old.id === entry.id));
  const follows = (value: LiveBlogManifest, previous: LiveBlogManifest, complete = false) => value.postId === previous.postId &&
    value.totalCount >= previous.totalCount && Date.parse(value.updatedAt) >= Date.parse(previous.updatedAt) &&
    (!previous.followUpsUpdatedAt || !!value.followUpsUpdatedAt && Date.parse(value.followUpsUpdatedAt) >= Date.parse(previous.followUpsUpdatedAt)) &&
    previous.updates.every(old => {
      const entry = value.updates.find(candidate => candidate.id === old.id);
      return entry ? Date.parse(entry.updatedAt) >= Date.parse(old.updatedAt) : !complete && value.totalCount > value.updates.length;
    });
  const schedule = () => {
    if (timer) clearTimeout(timer);
    if (!stopped && !observedEnded && root.isConnected && !doc.hidden && applied.coverageState !== "ended") timer = setTimeout(poll, Math.min(300_000, INTERVAL * 2 ** failures));
  };
  const read = async (target: URL, type: string) => {
    const controller = new AbortController(); active = controller;
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await win.fetch(target.href, { credentials: "same-origin", redirect: "error", signal: controller.signal, headers: { Accept: type } });
      if (!response.ok || !response.headers.get("content-type")?.includes(type)) throw new Error("Live blog unavailable");
      return await response.text();
    } finally { clearTimeout(timeout); if (active === controller) active = undefined; }
  };
  const preserveThread = (old: Element | undefined, next: Element) => {
    const opened = old?.querySelector('.live-blog-follow-ups__toggle[aria-expanded="true"]');
    if (opened) {
      next.querySelector('.live-blog-follow-ups__toggle')?.setAttribute("aria-expanded", "true");
      next.querySelector<HTMLElement>('.live-blog-follow-ups__list')?.removeAttribute("hidden");
    }
  };
  const restoreFocus = (focused: HTMLElement | null, copy: HTMLElement) => {
    if (!focused) return;
    if (focused.id) {
      const byId = doc.getElementById(focused.id); byId?.focus({ preventScroll: true });
      if (doc.activeElement === byId) return;
    }
    if (focused.classList.contains("live-blog-follow-ups__toggle")) {
      (copy.querySelector<HTMLButtonElement>(".live-blog-follow-ups__toggle") ?? copy).focus({ preventScroll: true });
      return;
    }
    const followUpId = focused.closest<HTMLElement>(".live-blog-follow-up")?.id;
    const followUp = followUpId ? doc.getElementById(followUpId) : null;
    const oldLink = focused.closest<HTMLAnchorElement>("a");
    const link = oldLink && Array.from((followUp ?? copy).querySelectorAll<HTMLAnchorElement>("a")).find(item => item.getAttribute("href") === oldLink.getAttribute("href"));
    (link || followUp || copy).focus({ preventScroll: true });
  };
  const threadRevision = (thread: Element | null | undefined) => Array.from(thread?.querySelectorAll<HTMLElement>(".live-blog-follow-up") ?? [])
    .map(item => `${item.id}:${item.dataset.liveBlogFollowUpUpdatedAt}`).join("|");
  const appearance = (value: LiveBlogManifest) => JSON.stringify(resolveLiveBlogPresentation(value));
  const copyAppearance = (incoming: HTMLElement) => {
    for (const key of ["data-live-blog-reporter-photos", "data-live-blog-reporter-cards", "data-live-blog-playful"]) {
      const value = incoming.getAttribute(key);
      if (value === null) root.removeAttribute(key); else root.setAttribute(key, value);
    }
  };
  const syncReporterCounts = (incoming: HTMLElement) => {
    const counts = new Map(Array.from(incoming.querySelectorAll(".live-blog__reporter-card[id]"))
      .map(card => [card.id, card.querySelector(".live-blog__card-count")?.textContent]));
    for (const card of root.querySelectorAll(".live-blog__reporter-card[id]")) {
      const count = card.querySelector(".live-blog__card-count"), fresh = counts.get(card.id);
      if (count && fresh != null && count.textContent !== fresh) count.textContent = fresh;
    }
  };
  const refreshExistingEntries = async (revision: LiveBlogManifest) => {
    const text = await read(url, "text/html");
    if (doc.hidden || stopped) return;
    if (text.length > 2 * 1024 * 1024) throw new Error("Invalid Post output");
    const incoming = new win.DOMParser().parseFromString(text, "text/html").querySelector<HTMLElement>("[data-live-blog]");
    const next = parseLiveBlogManifest(JSON.parse(incoming?.querySelector("[data-live-blog-manifest]")?.textContent ?? ""));
    if (!incoming || next.updates.length !== next.totalCount || !follows(next, applied, true) || !follows(next, revision, true)) throw new Error("Stale Post output");
    const anchor = Array.from(root.querySelectorAll<HTMLElement>(".live-blog-follow-up")).find(entry => {
      const box = entry.getBoundingClientRect(); return box.bottom > 0 && box.top < win.innerHeight;
    }) ?? Array.from(root.querySelectorAll<HTMLElement>("[data-live-blog-entry]")).find(entry => entry.getBoundingClientRect().bottom > 0);
    const top = anchor?.getBoundingClientRect().top;
    const anchorId = anchor?.id;
    const activeId = doc.activeElement?.id;
    // DOMParser enables noscript fallback markup; it must stay inert in this scripted page.
    incoming.querySelectorAll("noscript").forEach(node => node.remove());
    const appearanceChanged = appearance(next) !== appearance(applied);
    let announcement = "";
    const withdrawnParents = new Set<string>();
    for (const old of root.querySelectorAll<HTMLElement>("[data-live-blog-entry]")) {
      const fresh = Array.from(incoming.querySelectorAll<HTMLElement>("[data-live-blog-entry]")).find(entry => entry.dataset.liveBlogEntry === old.dataset.liveBlogEntry);
      const thread = fresh?.querySelector<HTMLElement>(".live-blog-follow-ups");
      const current = old.querySelector<HTMLElement>(".live-blog-follow-ups");
      if (current && fresh && !thread) withdrawnParents.add(old.id);
      if (fresh && appearanceChanged) {
        const focused = old.contains(doc.activeElement) ? doc.activeElement as HTMLElement : null;
        const copy = doc.importNode(fresh, true); preserveThread(old, copy); old.replaceWith(copy);
        restoreFocus(focused, copy);
        if (thread && threadRevision(current) !== threadRevision(thread)) announcement = `New follow-up on ${fresh.querySelector("h3")?.textContent ?? "this update"}`;
        else announcement ||= "Live blog appearance updated.";
        continue;
      }
      if (!thread) {
        if (current && fresh) {
          const focused = old.contains(doc.activeElement);
          const copy = doc.importNode(fresh, true); old.replaceWith(copy);
          if (focused) copy.focus({ preventScroll: true });
          announcement ||= "An update and its follow-ups were withdrawn.";
        }
        continue;
      }
      if (threadRevision(current) === threadRevision(thread)) continue;
      const focused = current?.contains(doc.activeElement) ? doc.activeElement as HTMLElement : null;
      const copy = doc.importNode(thread, true);
      preserveThread(old, copy);
      if (current) current.replaceWith(copy); else (old.querySelector(".live-blog__permalink") ?? old.lastElementChild)?.before(copy);
      restoreFocus(focused, copy);
      announcement ||= `New follow-up on ${old.querySelector("h3")?.textContent ?? "this update"}`;
    }
    if (withdrawnParents.size) {
      const keys = root.querySelector(".live-blog__keys");
      for (const link of keys?.querySelectorAll<HTMLAnchorElement>("a") ?? []) {
        if (withdrawnParents.has(link.hash.slice(1))) link.closest("li")?.remove();
      }
      if (keys && !keys.querySelector("li")) keys.remove();
    }
    if (activeId) doc.getElementById(activeId)?.focus({ preventScroll: true });
    if (anchor && top !== undefined) {
      const difference = (anchorId ? doc.getElementById(anchorId) : anchor)?.getBoundingClientRect().top! - top;
      if (difference) win.scrollBy(0, difference);
    }
    syncReporterCounts(incoming);
    copyAppearance(incoming);
    applied = { ...applied, updatedAt: next.updatedAt, presentation: next.presentation, followUpsUpdatedAt: next.followUpsUpdatedAt };
    marker.textContent = JSON.stringify(applied);
    if (announcement) status.textContent = announcement;
    onLoaded();
  };
  const poll = async () => {
    if (stopped || doc.hidden || loading || active) return;
    try {
      const text = await read(feedUrl, "application/json");
      if (doc.hidden || stopped || loading) return;
      if (text.length > 65_536) throw new Error("Invalid live blog revision");
      const next = parseLiveBlogFeed(JSON.parse(text));
      if (!follows(next, applied) || (pending && !follows(next, pending))) throw new Error("Stale live blog revision");
      const nextCount = next.totalCount - applied.totalCount;
      pending = nextCount ? next : undefined;
      button.hidden = nextCount === 0;
      button.textContent = `${nextCount} new update${nextCount === 1 ? "" : "s"}`;
      button.setAttribute("aria-label", `Load ${nextCount} new update${nextCount === 1 ? "" : "s"}`);
      if (nextCount && nextCount !== count) status.textContent = `${nextCount} new update${nextCount === 1 ? "" : "s"} available.`;
      count = nextCount; failures = 0;
      positionControl();
      if ((next.followUpsUpdatedAt && next.followUpsUpdatedAt !== applied.followUpsUpdatedAt) || appearance(next) !== appearance(applied)) {
        loading = true;
        try { await refreshExistingEntries(next); } finally { loading = false; }
      }
      observedEnded = next.coverageState === "ended";
    } catch { if (!doc.hidden) failures = Math.min(failures + 1, 4); }
    finally { schedule(); }
  };
  button.addEventListener("click", async () => {
    if (!pending || loading) return;
    active?.abort();
    loading = true; if (timer) clearTimeout(timer);
    button.setAttribute("aria-busy", "true"); button.setAttribute("aria-disabled", "true");
    try {
      const text = await read(url, "text/html");
      if (text.length > 2 * 1024 * 1024) throw new Error("Invalid Post output");
      const incomingDoc = new win.DOMParser().parseFromString(text, "text/html");
      const incoming = incomingDoc.querySelector<HTMLElement>("[data-live-blog]");
      const incomingMarker = incoming?.querySelector("[data-live-blog-manifest]");
      const next = parseLiveBlogManifest(JSON.parse(incomingMarker?.textContent ?? ""));
      if (!incoming || next.updates.length !== next.totalCount || !follows(next, applied, true) || !follows(next, pending, true)) throw new Error("Stale Post output");
      incoming.querySelectorAll("noscript").forEach(node => node.remove());
      const fresh = newEntries(next);
      const list = root.querySelector<HTMLOListElement>(".live-blog__updates");
      const incomingList = incoming.querySelector<HTMLOListElement>(".live-blog__updates");
      if (!list || !incomingList || incomingList.children.length !== next.updates.length) throw new Error("Incomplete Post output");
      const oldEntries = new Map(Array.from(list.children).map(li => [li.querySelector<HTMLElement>("[data-live-blog-entry]")?.dataset.liveBlogEntry, li]));
      const previous = new Map(applied.updates.map(entry => [entry.id, entry.updatedAt]));
      const incomingEntries = Array.from(incomingList.children);
      const incomingIds = incomingEntries.map(li => li.querySelector<HTMLElement>("[data-live-blog-entry]")?.dataset.liveBlogEntry);
      if (new Set(incomingIds).size !== next.updates.length || incomingIds.some(id => !next.updates.some(entry => entry.id === id))) throw new Error("Incomplete Post output");
      let cursor = list.firstElementChild;
      for (const li of incomingEntries) {
        const id = li.querySelector<HTMLElement>("[data-live-blog-entry]")!.dataset.liveBlogEntry!;
        const old = oldEntries.get(id);
        const entry = old && appearance(next) === appearance(applied) && previous.get(id) === next.updates.find(item => item.id === id)!.updatedAt ? old : doc.importNode(li, true);
        if (entry !== old) preserveThread(old, entry);
        if (entry === cursor) cursor = cursor.nextElementSibling;
        else if (old === cursor) { cursor = cursor!.nextElementSibling; old!.replaceWith(entry); }
        else { list.insertBefore(entry, cursor); old?.remove(); }
      }
      for (const selector of ["[data-live-blog-branding]", ".live-blog__state", ":scope > .live-blog__metadata", ".live-blog__keys", "[data-live-blog-empty]", "[data-live-blog-order]"]) {
        const old = root.querySelector(selector), replacement = incoming.querySelector(selector);
        if (replacement) {
          if (old) old.replaceWith(doc.importNode(replacement, true));
          else if (selector === "[data-live-blog-branding]") root.prepend(doc.importNode(replacement, true));
          else (selector === ".live-blog__keys" ? root.querySelector("[data-live-blog-order], [data-live-blog-empty]") ?? list : list).before(doc.importNode(replacement, true));
        }
        else old?.remove();
      }
      syncReporterCounts(incoming);
      copyAppearance(incoming);
      marker.textContent = incomingMarker!.textContent;
      applied = next;
      if (pagination) pagination.refresh(); else pagination = installLiveBlogPagination(root);
      onLoaded();
      const newest = Array.from(list.querySelectorAll<HTMLElement>("[data-live-blog-entry]")).find(article => fresh.some(entry => entry.id === article.dataset.liveBlogEntry));
      // This focus change belongs to the explicit click. Polling never moves it.
      newest?.focus({ preventScroll: true });
      if (newest) {
        const box = newest.getBoundingClientRect();
        const heading = newest.querySelector("h3")?.getBoundingClientRect() ?? box;
        const inset = Math.max(Number.parseFloat(win.getComputedStyle(newest).scrollMarginBlockStart) || 0, head?.getBoundingClientRect().bottom ?? 0);
        if (box.top < inset || heading.bottom > win.innerHeight) newest.scrollIntoView({ block: "start", behavior: "instant" });
      }
      button.hidden = true; pending = undefined; count = 0;
      positionControl();
      status.textContent = `${fresh.length} new update${fresh.length === 1 ? "" : "s"} loaded.`;
      failures = 0;
    } catch { failures = Math.min(failures + 1, 4); status.textContent = "Updates could not be loaded. Try again."; }
    finally { loading = false; button.removeAttribute("aria-busy"); button.removeAttribute("aria-disabled"); schedule(); }
  });
  doc.addEventListener("visibilitychange", () => { if (doc.hidden) { if (timer) clearTimeout(timer); active?.abort(); } else schedule(); });
  win.addEventListener("pagehide", () => { stopped = true; if (timer) clearTimeout(timer); active?.abort(); headerResize?.disconnect(); menuChanges?.disconnect(); });
  win.addEventListener("pageshow", () => { stopped = false; observeHeader(); positionControl(); schedule(); });
  schedule();
}
