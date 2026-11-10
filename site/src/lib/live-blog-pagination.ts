/** Progressive paging over one immutable snapshot; no network or polling. */
export function installLiveBlogPagination(root: HTMLElement): { refresh(): void } | undefined {
  if (root.dataset.paginationInstalled) return;
  const list = root.querySelector<HTMLOListElement>(".live-blog__updates");
  const controls = root.querySelector<HTMLElement>("[data-live-blog-pagination]");
  const older = controls?.querySelector<HTMLButtonElement>("[data-live-blog-older]");
  const count = controls?.querySelector<HTMLElement>("[data-live-blog-count]");
  const win = root.ownerDocument.defaultView;
  if (!list || !controls || !older || !count || !win) return;
  let entries = Array.from(list.children) as HTMLLIElement[];
  const pageSize = 20;
  root.dataset.paginationInstalled = "true";
  let visible = pageSize;
  const destination = (hash: string) => {
    try {
      const target = root.ownerDocument.getElementById(decodeURIComponent(hash.slice(1)));
      const index = entries.findIndex(entry => !!target && entry.contains(target));
      return index < 0 ? null : { target: target!, index };
    } catch { return null; }
  };
  const initial = destination(win.location.hash);
  if (initial) visible = Math.min(entries.length, Math.ceil((initial.index + 1) / pageSize) * pageSize);
  const update = (announcement = "") => {
    entries.forEach((entry, index) => { entry.hidden = index >= visible; });
    const remaining = entries.length - visible;
    older.hidden = remaining === 0;
    const next = Math.min(pageSize, remaining);
    older.textContent = `Show ${next} older update${next === 1 ? "" : "s"}`;
    count.textContent = `${announcement}Showing ${visible} of ${entries.length} updates.`;
  };
  update(); controls.hidden = entries.length <= pageSize;
  count.setAttribute("role", "status"); count.setAttribute("aria-live", "polite"); count.setAttribute("aria-atomic", "true");
  older.addEventListener("click", () => {
    count.setAttribute("aria-live", "polite");
    const first = visible;
    visible = Math.min(entries.length, visible + pageSize);
    update(`${visible - first} older updates shown. `);
    // The first new entry occupies the old control's position. Keep that position
    // and give keyboard readers a useful next destination before hiding the button.
    entries[first]?.querySelector<HTMLElement>("article")?.focus({ preventScroll: true });
  });
  const reveal = (hash: string) => {
    const target = destination(hash);
    if (!target) return null;
    if (target.index >= visible) { visible = Math.min(entries.length, Math.ceil((target.index + 1) / pageSize) * pageSize); update(); }
    return target.target;
  };
  root.addEventListener("click", event => {
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href^='#']") : null;
    if (link) reveal(link.hash); // Reveal before native fragment navigation.
  });
  win.addEventListener("hashchange", () => {
    const target = reveal(win.location.hash);
    if (target) { target.focus({ preventScroll: true }); target.scrollIntoView({ block: "start", behavior: "instant" }); }
  });
  return { refresh() {
    const previous = new Set(entries.map(entry => entry.querySelector("article")?.id));
    entries = Array.from(list.children) as HTMLLIElement[];
    visible = Math.min(entries.length, visible + entries.filter(entry => !previous.has(entry.querySelector("article")?.id)).length);
    // New-entry loading owns its own short announcement. The archive count must
    // not produce a second live-region announcement during that action.
    count.setAttribute("aria-live", "off");
    update(); controls.hidden = entries.length <= pageSize;
  } };
}
