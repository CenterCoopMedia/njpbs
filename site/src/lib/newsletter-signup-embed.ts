/** The target stays in the page so the consent-gated campaign can size itself. */
export function observeNewsletterSignupEmbeds(document: Document, Observer = document.defaultView?.ResizeObserver): void {
  const targets = document.querySelectorAll(".newsletter-signup-embed__target");
  if (!Observer || !targets.length) return;
  const observer = new Observer(entries => {
    for (const { target, contentRect } of entries) {
      target.parentElement?.toggleAttribute("data-signup-form", contentRect.height > 0);
    }
  });
  targets.forEach(target => observer.observe(target));
}
