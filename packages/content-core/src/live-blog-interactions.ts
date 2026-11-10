import { liveBlogLinkIcon } from "./live-blog-reporters-render.ts";

const checkIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';

/** Progressive enhancement; refreshed entries use the same installer and markup. */
export function installLiveBlogInteractions(root: HTMLElement): void {
  if (root.dataset.liveBlogInteractions) return;
  root.dataset.liveBlogInteractions = "true";
  const doc = root.ownerDocument, win = doc.defaultView;
  if (!win) return;
  const reduced = win.matchMedia?.("(prefers-reduced-motion: reduce)");
  const motionOff = () => reduced?.matches || doc.documentElement.dataset.motion === "off";
  let active: { trigger: HTMLButtonElement; panel: HTMLElement; focusedId?: string } | undefined;
  const close = (restoreFocus = true) => {
    if (!active) return;
    const { trigger, panel } = active;
    active = undefined; panel.hidden = true; trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus && trigger.isConnected) trigger.focus();
  };
  const enhance = () => {
    root.classList.add("live-blog--enhanced");
    // Reused entries can become the second item of a day after new updates load.
    const syncDay = (stamp: HTMLElement | null, previous?: string) => {
      const label = stamp?.querySelector<HTMLElement>("[data-live-blog-day-label]");
      if (label) label.hidden = stamp!.dataset.liveBlogDay === previous;
      return stamp?.dataset.liveBlogDay;
    };
    let previousDay: string | undefined;
    for (const entry of root.querySelectorAll(".live-blog__entry")) {
      const stamp = entry.querySelector<HTMLElement>(".live-blog__stamp>.live-blog__metadata time[data-live-blog-day]");
      previousDay = syncDay(stamp, previousDay);
      let replyDay = stamp?.dataset.liveBlogDay;
      for (const reply of entry.querySelectorAll<HTMLElement>(".live-blog-follow-up__header>.live-blog__metadata time[data-live-blog-day]")) replyDay = syncDay(reply, replyDay);
    }
    for (const anchor of root.querySelectorAll<HTMLAnchorElement>("a.live-blog__permalink,a.live-blog-follow-up__permalink")) {
      let canonical: URL;
      try {
        // A private render must never copy its session route or query string.
        canonical = new URL(root.dataset.liveBlogCanonical ?? "");
        if (!/^https?:$/.test(canonical.protocol)) continue;
        canonical.search = ""; canonical.hash = anchor.hash;
      } catch { continue; }
      const reply = anchor.classList.contains("live-blog-follow-up__permalink");
      const label = `Copy link to this ${reply ? "follow-up" : "update"}`;
      const wrap = doc.createElement("div"); wrap.className = "live-blog__copy-control";
      const button = doc.createElement("button"); button.type = "button";
      button.id = anchor.id;
      button.className = `${anchor.className} live-blog__icon-control live-blog__copy-button`;
      button.setAttribute("aria-label", label); button.innerHTML = liveBlogLinkIcon;
      const tip = doc.createElement("span"); tip.className = "live-blog__tooltip"; tip.textContent = label; tip.hidden = true;
      tip.id = `${button.id}-tooltip`; tip.setAttribute("role", "tooltip"); button.setAttribute("aria-describedby", tip.id);
      const status = doc.createElement("span"); status.className = "live-blog__sr-only";
      status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite"); status.setAttribute("aria-atomic", "true");
      const fallback = doc.createElement("label"); fallback.className = "live-blog__copy-fallback"; fallback.hidden = true;
      fallback.append(doc.createTextNode(`Select and copy this ${reply ? "follow-up’s" : "update’s"} URL`));
      const input = doc.createElement("input"); input.type = "text"; input.readOnly = true; input.value = canonical.href; fallback.append(input);
      const focused = doc.activeElement === anchor;
      anchor.replaceWith(wrap); wrap.append(button, tip, status, fallback);
      if (focused) button.focus({ preventScroll: true });
      let timer: number | undefined;
      const showTip = () => { tip.hidden = button.hasAttribute("data-copied"); };
      const hideTip = (event: PointerEvent) => {
        const target = event.relatedTarget as Node | null;
        if (target && (button.contains(target) || tip.contains(target))) return;
        if (!button.matches(":focus-visible")) tip.hidden = true;
      };
      button.addEventListener("pointerenter", event => { if (event.pointerType !== "touch") showTip(); });
      button.addEventListener("pointerleave", hideTip);
      tip.addEventListener("pointerenter", showTip); tip.addEventListener("pointerleave", hideTip);
      button.addEventListener("focus", showTip); button.addEventListener("blur", () => { tip.hidden = true; });
      button.addEventListener("click", async () => {
        win.clearTimeout(timer); tip.hidden = true;
        delete button.dataset.copied; button.innerHTML = liveBlogLinkIcon; status.textContent = "";
        try {
          if (!win.navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
          await win.navigator.clipboard.writeText(canonical.href);
          if (!button.isConnected) return;
          fallback.hidden = true; button.dataset.copied = ""; button.innerHTML = checkIcon; status.textContent = "Link copied";
          if (!motionOff() && root.dataset.liveBlogPlayful === "true") {
            const article = button.closest<HTMLElement>("article")!;
            const layer = doc.createElement("span"); layer.className = "live-blog__ripple"; layer.setAttribute("aria-hidden", "true");
            for (let i = 0; i < 3; i++) layer.append(doc.createElement("i"));
            const a = article.getBoundingClientRect(), b = button.getBoundingClientRect();
            layer.style.setProperty("--ripple-x", `${b.left - a.left}px`); layer.style.setProperty("--ripple-y", `${b.top - a.top}px`);
            article.append(layer);
            win.setTimeout(() => layer.remove(), 660);
          }
          timer = win.setTimeout(() => { delete button.dataset.copied; button.innerHTML = liveBlogLinkIcon; status.textContent = ""; }, 2600);
        } catch {
          if (!button.isConnected) return;
          fallback.hidden = false; input.focus(); input.select(); status.textContent = "Select and copy the URL.";
        }
      });
    }
    if (active && !active.trigger.isConnected) {
      const previous = active;
      const trigger = doc.getElementById(previous.trigger.id) as HTMLButtonElement | null;
      const panel = doc.getElementById(previous.panel.id);
      if (trigger && panel && root.contains(trigger)) {
        active = { trigger, panel, focusedId: previous.focusedId };
        panel.hidden = false; trigger.setAttribute("aria-expanded", "true");
        const focused = doc.activeElement;
        if (previous.focusedId && (focused === doc.body || focused?.id === previous.trigger.closest("article")?.id)) {
          doc.getElementById(previous.focusedId)?.focus({ preventScroll: true });
        }
      } else close(false);
    }
  };
  root.addEventListener("click", event => {
    const target = event.target as Element;
    const trigger = target.closest<HTMLButtonElement>(".live-blog__reporter-trigger");
    if (trigger && root.contains(trigger)) {
      if (active?.trigger === trigger) { close(); return; }
      close(false);
      const panel = doc.getElementById(trigger.getAttribute("aria-controls") ?? "");
      if (!panel || !root.contains(panel)) return;
      active = { trigger, panel }; panel.hidden = false; trigger.setAttribute("aria-expanded", "true");
      panel.querySelector<HTMLButtonElement>(".live-blog__card-close")?.focus();
    } else if (target.closest(".live-blog__card-close")) close();
  });
  root.addEventListener("focusin", event => {
    const target = event.target as HTMLElement;
    if (active?.panel.contains(target)) active.focusedId = target.id;
  });
  doc.addEventListener("pointerdown", event => {
    const target = event.target as Node;
    if (active && !active.panel.contains(target) && !active.trigger.contains(target)) close(false);
  });
  doc.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    if (active) { event.preventDefault(); close(); }
    root.querySelectorAll<HTMLElement>(".live-blog__tooltip").forEach(tip => { tip.hidden = true; });
  });
  reduced?.addEventListener("change", () => root.querySelectorAll(".live-blog__ripple").forEach(node => node.remove()));
  enhance();
  new win.MutationObserver(enhance).observe(root, { childList: true, subtree: true });
}
