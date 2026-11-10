const mounted = new WeakSet<HTMLImageElement>();

/** The actual viewport decides which decorative story images need eager loading. */
export function mountHomeStoryImages(root: ParentNode = document): void {
  root.querySelectorAll<HTMLImageElement>("img[srcset]:not([data-home-hero-image]):not([data-home-story-image])").forEach(image => {
    if (mounted.has(image)) return;
    mounted.add(image);
    const retry = () => {
      image.removeAttribute("srcset"); image.removeAttribute("sizes");
    };
    image.addEventListener("error", retry, { once: true });
    if (image.complete && image.naturalWidth === 0) retry();
  });
  root.querySelectorAll<HTMLImageElement>("img[data-home-story-image]").forEach(image => {
    const view = image.ownerDocument.defaultView;
    const box = image.getBoundingClientRect();
    image.loading = view && box.top < view.innerHeight && box.bottom > 0 ? "eager" : "lazy";
    if (mounted.has(image)) return;
    mounted.add(image);
    const hide = () => {
      if (image.hasAttribute("srcset")) {
        image.removeAttribute("srcset"); image.removeAttribute("sizes");
        return;
      }
      image.style.visibility = "hidden";
    };
    image.addEventListener("error", hide);
    if (image.complete && image.naturalWidth === 0) hide();
  });
}
