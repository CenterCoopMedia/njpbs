import { spotlightFallbackImage } from "./spotlight-image.mjs";

const mounted = new WeakSet<HTMLImageElement>();

/** Works in public documents and script-free preview iframes from their parent. */
export function mountSpotlightImages(root: ParentNode = document): void {
  root.querySelectorAll<HTMLImageElement>("img[data-spotlight-fallback]").forEach(image => {
    if (mounted.has(image)) return;
    mounted.add(image);
    const fallback = spotlightFallbackImage(image.dataset.spotlightFallback);
    if (!fallback) return;
    const showFallback = () => {
      if (image.getAttribute("src") !== fallback) {
        image.removeAttribute("srcset");
        image.setAttribute("src", fallback);
      } else image.style.visibility = "hidden";
    };
    image.addEventListener("error", showFallback);
    if (image.hasAttribute("src") && image.complete && image.naturalWidth === 0) showFallback();
  });
}
