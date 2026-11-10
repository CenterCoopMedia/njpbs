import { createModalDialog } from "./dialog";

/** Delegate from the retained feed root so refreshed/older entries work too. */
export function installLiveBlogImages(root: HTMLElement): void {
  const dialog = root.parentElement?.querySelector<HTMLDialogElement>("[data-live-blog-image-dialog]");
  if (!dialog) return;
  const image = dialog.querySelector<HTMLImageElement>("[data-expanded-image]")!;
  const full = dialog.querySelector<HTMLAnchorElement>("[data-full-image]")!;
  const caption = dialog.querySelector<HTMLElement>("[data-image-caption]")!;
  let entryId: string | undefined, imageIndex = 0;
  if (typeof dialog.showModal !== "function") return;
  root.querySelectorAll("[data-live-blog-image]").forEach(link => {
    link.setAttribute("aria-haspopup", "dialog");
    const notice = link.querySelector<HTMLElement>("[data-live-blog-image-fallback]");
    if (notice) notice.hidden = true;
  });
  if (root.dataset.imagesInstalled) return;
  const modal = createModalDialog(dialog, { initialFocus: "[data-dialog-close]", onClose() {
    // Discard the previous original before a later opening sets new metadata.
    image.removeAttribute("src");
    image.alt = "";
    // A refresh can replace the original trigger while the reader views its image.
    const entry = Array.from(root.querySelectorAll<HTMLElement>("[data-live-blog-entry]")).find(entry => entry.dataset.liveBlogEntry === entryId);
    const trigger = entry?.querySelectorAll<HTMLAnchorElement>("[data-live-blog-image]")[imageIndex];
    (trigger ?? entry)?.focus();
  } });
  if (!modal.supportsModal) return;
  root.dataset.imagesInstalled = "true";
  // Keep Tab within the two controls; Chromium otherwise adds a browser-chrome
  // stop between the last and first controls of a native modal.
  const close = dialog.querySelector<HTMLButtonElement>("[data-dialog-close]")!;
  dialog.addEventListener("keydown", event => {
    // The modal controller closes this dialog first; keep the same Escape from
    // reaching the document-level reporter-card handler and moving focus again.
    if (event.key === "Escape") { event.stopPropagation(); return; }
    if (event.key !== "Tab") return;
    if (!event.shiftKey && document.activeElement === close) { event.preventDefault(); full.focus(); }
    else if (event.shiftKey && document.activeElement === full) { event.preventDefault(); close.focus(); }
  });
  root.addEventListener("click", event => {
    if (!(event.target instanceof Element) || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest<HTMLAnchorElement>("a[data-live-blog-image]");
    const source = link?.querySelector("img");
    if (!link || !source || !root.contains(link)) return;
    event.preventDefault();
    const entry = link.closest<HTMLElement>("[data-live-blog-entry]");
    entryId = entry?.dataset.liveBlogEntry;
    imageIndex = Array.from(entry?.querySelectorAll("[data-live-blog-image]") ?? []).indexOf(link);
    image.src = link.href;
    image.alt = source.alt;
    full.href = link.href;
    const description = link.querySelector("figcaption");
    caption.replaceChildren(...(description ? Array.from(description.childNodes).map(node => node.cloneNode(true)) : []));
    caption.hidden = !caption.textContent?.trim();
    modal.open(link);
  });
}
