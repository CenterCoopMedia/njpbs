import { afterEach, describe, expect, it, vi } from "vitest";
import { installLiveBlogInteractions } from "../../packages/content-core/src/live-blog-interactions";
import { installLiveBlogImages } from "../src/lib/live-blog-images";

function setup(modals = true) {
  document.body.innerHTML = `<div><section data-live-blog><article data-live-blog-entry="one" tabindex="-1"><a data-live-blog-image href="https://media.njpbs.org/full.jpg" target="_blank"><figure><img src="/small.webp" alt="Voters outside town hall"><figcaption>Voting begins<span class="cms-image-credit">NJ PBS</span></figcaption></figure><span data-live-blog-image-fallback> (opens in a new tab)</span></a></article></section><dialog data-live-blog-image-dialog aria-label="Expanded image"><button data-dialog-close>Close image</button><a data-full-image target="_blank" rel="noopener">Open full image</a><img data-expanded-image><figcaption data-image-caption></figcaption></dialog></div>`;
  const root = document.querySelector<HTMLElement>("[data-live-blog]")!;
  const dialog = document.querySelector<HTMLDialogElement>("dialog")!;
  dialog.showModal = modals ? vi.fn(() => { dialog.open = true; }) : undefined as unknown as typeof dialog.showModal;
  dialog.close = vi.fn(() => { dialog.open = false; });
  installLiveBlogImages(root);
  return { root, dialog, link: root.querySelector<HTMLAnchorElement>("a")! };
}
afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });

describe("live update image dialog", () => {
  it("opens the immutable original, preserves description and credit, closes on Escape and restores focus", () => {
    const { link, dialog } = setup();
    link.focus(); link.click();
    expect(dialog.showModal).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(dialog.querySelector("button"));
    expect(link.querySelector<HTMLElement>("[data-live-blog-image-fallback]")?.hidden).toBe(true);
    expect(dialog.querySelector("[data-expanded-image]")?.getAttribute("src")).toBe(link.href);
    expect(dialog.querySelector("[data-expanded-image]")?.getAttribute("alt")).toBe("Voters outside town hall");
    expect(dialog.querySelector("[data-full-image]")?.getAttribute("href")).toBe(link.href);
    expect(dialog.querySelector("[data-image-caption]")?.innerHTML).toBe('Voting begins<span class="cms-image-credit">NJ PBS</span>');
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(link);
  });

  it("consumes image Escape while an underlying reporter card stays open and preserves photo focus", () => {
    const { root, dialog, link } = setup();
    root.insertAdjacentHTML("afterbegin", `<button id="reporter" class="live-blog__reporter-trigger" aria-controls="reporter-card" aria-expanded="false">Reporter</button><div id="reporter-card" class="live-blog__reporter-card" role="dialog" aria-label="Reporter" hidden><button class="live-blog__card-close">Close reporter</button></div>`);
    installLiveBlogInteractions(root);
    const reporter = root.querySelector<HTMLButtonElement>(".live-blog__reporter-trigger")!;
    const card = root.querySelector<HTMLElement>(".live-blog__reporter-card")!;
    reporter.click();
    expect(card.hidden).toBe(false);
    // Keyboard activation has no pointerdown outside the reporter card.
    link.focus(); link.click();
    expect(dialog.open).toBe(true);
    expect(card.hidden).toBe(false);
    dialog.querySelector<HTMLButtonElement>("[data-dialog-close]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(dialog.open).toBe(false);
    expect(card.hidden).toBe(false);
    expect(reporter.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(link);
    // A later Escape outside the closed photo dialog still owns the reporter.
    link.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(card.hidden).toBe(true);
    expect(document.activeElement).toBe(reporter);
  });

  it("discards a closed image before another caption and credit are opened", () => {
    const { root, dialog, link } = setup();
    link.click();
    dialog.querySelector<HTMLButtonElement>("button")!.click();
    const image = dialog.querySelector<HTMLImageElement>("[data-expanded-image]")!;
    expect(image.hasAttribute("src")).toBe(false);
    expect(image.alt).toBe("");
    const next = link.cloneNode(true) as HTMLAnchorElement;
    next.href = "https://media.njpbs.org/second-original.jpg";
    next.querySelector("img")!.alt = "Second photograph";
    next.querySelector("figcaption")!.textContent = "Second caption / Second photographer";
    root.querySelector("article")!.append(next);
    next.click();
    expect(dialog.showModal).toHaveBeenCalledTimes(2);
    expect(image.src).toBe(next.href);
    expect(image.alt).toBe("Second photograph");
    expect(dialog.querySelector("[data-image-caption]")?.textContent).toBe("Second caption / Second photographer");
  });

  it("delegates to refreshed entries once, with focus return when the trigger was replaced", () => {
    const { root, dialog, link } = setup();
    link.click();
    root.querySelector("article")!.innerHTML = link.outerHTML;
    installLiveBlogImages(root);
    const replacement = root.querySelector<HTMLAnchorElement>("a")!;
    dialog.querySelector<HTMLButtonElement>("button")!.click();
    expect(document.activeElement).toBe(replacement);
    replacement.click();
    expect(dialog.showModal).toHaveBeenCalledTimes(2);
    expect(replacement.getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("wraps Tab in both directions and preserves the real link when native modals are unavailable", () => {
    const { link, dialog } = setup();
    link.click();
    const close = dialog.querySelector<HTMLButtonElement>("button")!;
    const full = dialog.querySelector<HTMLAnchorElement>("[data-full-image]")!;
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(full);
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(close);
    // A fresh root in an old engine keeps a normal image link with no modal claim.
    const unsupported = setup(false);
    expect(unsupported.root.dataset.imagesInstalled).toBeUndefined();
    expect(unsupported.link.hasAttribute("aria-haspopup")).toBe(false);
    expect(unsupported.link.querySelector<HTMLElement>("[data-live-blog-image-fallback]")?.hidden).toBe(false);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    unsupported.link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
  });

  it("keeps modified-click and no-modal browser fallbacks as real full-image links", () => {
    const { link, dialog } = setup();
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    expect(dialog.showModal).not.toHaveBeenCalled();
    expect(link.target).toBe("_blank");
  });
});
