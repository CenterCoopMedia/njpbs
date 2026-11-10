/** Install once on the shared root; delegation also handles refreshed threads. */
export function installLiveBlogFollowUps(root: HTMLElement): void {
  if (root.dataset.followUpsInstalled) return;
  root.dataset.followUpsInstalled = "true";
  const doc = root.ownerDocument, win = doc.defaultView;
  const expand = (target: Element | null) => {
    const thread = target?.closest(".live-blog-follow-ups");
    const button = thread?.querySelector<HTMLButtonElement>(".live-blog-follow-ups__toggle");
    const list = thread?.querySelector<HTMLElement>(".live-blog-follow-ups__list");
    if (button && list) { button.setAttribute("aria-expanded", "true"); list.hidden = false; }
  };
  const anchor = () => {
    try { expand(doc.getElementById(decodeURIComponent(win?.location.hash.slice(1) ?? ""))); } catch { /* malformed fragments do not interrupt the feed */ }
  };
  root.addEventListener("click", event => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>(".live-blog-follow-ups__toggle");
    if (button && root.contains(button)) {
      const list = doc.getElementById(button.getAttribute("aria-controls") ?? "");
      if (!list || !root.contains(list)) return;
      const open = button.getAttribute("aria-expanded") !== "true";
      button.setAttribute("aria-expanded", String(open)); list.hidden = !open;
    }
    const link = event.target.closest<HTMLAnchorElement>("a[href^='#']");
    if (link) { try { expand(doc.getElementById(decodeURIComponent(link.hash.slice(1)))); } catch {} }
  });
  win?.addEventListener("hashchange", anchor);
  anchor();
}
