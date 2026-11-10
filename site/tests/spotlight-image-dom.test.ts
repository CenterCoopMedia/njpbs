import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountSpotlightImages } from "../../packages/content-core/src/spotlight-image-dom";
import { mountHomeHeroes } from "../src/lib/home-hero-client";

beforeEach(() => {
  // Keep fixture images pending until explicit errors; Happy DOM 21 considers
  // disabled requests complete. The already-failed case overrides this itself.
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
});
afterEach(() => vi.restoreAllMocks());

describe("Spotlight image load fallback", () => {
  it.each([true, false])("has one fallback owner when public hero handlers also mount (%s)", heroFirst => {
    const root = document.createElement("div");
    root.innerHTML = '<section data-home-hero><img src="/missing.jpg" data-home-hero-image data-fallback-src="/brand/spotlight/budget.jpg" data-spotlight-fallback="/brand/spotlight/budget.jpg"></section>';
    if (heroFirst) { mountHomeHeroes(root); mountSpotlightImages(root); }
    else { mountSpotlightImages(root); mountHomeHeroes(root); }
    const image = root.querySelector("img")!;
    image.dispatchEvent(new Event("error"));
    expect(image.getAttribute("src")).toBe("/brand/spotlight/budget.jpg");
    expect(image.hidden).toBe(false);
    expect(image.style.visibility).not.toBe("hidden");
  });
  it("retains dimensions and uses topic art once, then hides an unavailable local fallback", () => {
    const root = document.createElement("div");
    root.innerHTML = '<img src="https://www.njspotlightnews.org/wp-content/uploads/sites/123/2025/01/drinking-water-tap-cup-768x432.jpg" alt="" width="640" height="360" loading="lazy" data-spotlight-fallback="/brand/spotlight/energy-environment.jpg">';
    const image = root.querySelector("img")!;
    mountSpotlightImages(root);
    mountSpotlightImages(root);
    image.dispatchEvent(new Event("error"));
    expect(image.getAttribute("src")).toBe("/brand/spotlight/energy-environment.jpg");
    expect(image.width).toBe(640);
    expect(image.height).toBe(360);
    expect(image.loading).toBe("lazy");
    expect(image.alt).toBe("");
    image.dispatchEvent(new Event("error"));
    expect(image.style.visibility).toBe("hidden");
  });
  it("ignores untrusted fallback markers and handles an already failed image", () => {
    const root = document.createElement("div");
    root.innerHTML = '<img src="/missing.jpg" data-spotlight-fallback="https://evil.test/image.jpg"><img src="/missing.jpg" data-spotlight-fallback="/brand/spotlight/budget.jpg">';
    const images = root.querySelectorAll("img");
    Object.defineProperty(images[1], "complete", { value: true });
    Object.defineProperty(images[1], "naturalWidth", { value: 0 });
    mountSpotlightImages(root);
    images[0].dispatchEvent(new Event("error"));
    expect(images[0].getAttribute("src")).toBe("/missing.jpg");
    expect(images[1].getAttribute("src")).toBe("/brand/spotlight/budget.jpg");
  });
});
