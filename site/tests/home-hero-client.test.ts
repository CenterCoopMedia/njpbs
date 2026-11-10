// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountHomeHeroes } from "../src/lib/home-hero-client";

let reduced = false;
beforeEach(() => {
  vi.useFakeTimers();
  // These images stay pending until the test dispatches an error. Happy DOM 21
  // marks disabled image requests complete even though no bytes were loaded.
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
  reduced = false;
  vi.stubGlobal("matchMedia", () => ({ get matches() { return reduced; }, addEventListener() {}, removeEventListener() {} }));
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
});
afterEach(() => {
  window.dispatchEvent(new PageTransitionEvent("pagehide"));
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-motion");
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function fixture() {
  document.body.innerHTML = `<section data-home-hero>
    <div data-home-hero-background><img data-home-hero-image src="/one.jpg" data-fallback-src="/fallback.jpg"></div>
    <div data-home-hero-background hidden><img data-home-hero-image src="/two.jpg" data-fallback-src="/fallback.jpg"></div>
    <div data-home-hero-slide data-title="One"><a href="/one/">One</a></div>
    <div data-home-hero-slide data-title="Two" hidden inert><a href="/two/">Two</a></div>
    <div data-home-hero-controls hidden>
      <button data-home-hero-previous>Previous</button><span data-home-hero-count>1 / 2</span>
      <button data-home-hero-next>Next</button><button data-home-hero-pause>Pause rotation</button>
    </div><p data-home-hero-status></p></section>`;
  mountHomeHeroes();
  return {
    slides: [...document.querySelectorAll<HTMLElement>("[data-home-hero-slide]")],
    backgrounds: [...document.querySelectorAll<HTMLElement>("[data-home-hero-background]")],
    pause: document.querySelector<HTMLButtonElement>("[data-home-hero-pause]")!,
    next: document.querySelector<HTMLButtonElement>("[data-home-hero-next]")!,
    status: document.querySelector<HTMLElement>("[data-home-hero-status]")!,
  };
}
function imageWarmingFixture() {
  document.body.innerHTML = `<section data-home-hero>
    ${Array.from({ length: 5 }, (_, index) => `<div data-home-hero-background${index ? " hidden" : ""}>
      <img data-home-hero-image ${index ? `data-home-hero-src="/${index}.jpg"` : `src="/${index}.jpg"`} loading="${index ? "lazy" : "eager"}" data-fallback-src="/fallback.jpg">
    </div>`).join("")}
    ${Array.from({ length: 5 }, (_, index) => `<div data-home-hero-slide data-title="${index}"${index ? " hidden inert" : ""}>${index}</div>`).join("")}
    <div data-home-hero-controls hidden>
      <button data-home-hero-previous>Previous</button><span data-home-hero-count>1 / 5</span>
      <button data-home-hero-next>Next</button><button data-home-hero-pause>Pause rotation</button>
    </div><p data-home-hero-status></p></section>`;
  const images = [...document.querySelectorAll<HTMLImageElement>("[data-home-hero-image]")];
  const initialSources = images.map(image => image.getAttribute("src"));
  mountHomeHeroes();
  return {
    backgrounds: [...document.querySelectorAll<HTMLElement>("[data-home-hero-background]")],
    images,
    initialSources,
    next: document.querySelector<HTMLButtonElement>("[data-home-hero-next]")!,
  };
}
describe("Home hero controls", () => {
  it("uses the configured fallback when a single slide background fails, then hides a failed fallback", () => {
    document.body.innerHTML = `<section data-home-hero><div data-home-hero-background>
      <img data-home-hero-image src="/missing.jpg" data-fallback-src="/fallback.jpg" data-fallback-position="top" />
    </div><div data-home-hero-slide>Story</div></section>`;
    mountHomeHeroes();
    const image = document.querySelector("img")!;
    image.dispatchEvent(new Event("error"));
    expect(image.getAttribute("src")).toBe("/fallback.jpg");
    expect(image.hidden).toBe(false);
    expect(image.style.objectPosition).toBe("top");
    image.dispatchEvent(new Event("error"));
    expect(image.hidden).toBe(true);
  });
  it("changes backgrounds with automatic and manual navigation without reusing a previous slide image", () => {
    const { backgrounds, slides, next } = fixture();
    vi.advanceTimersByTime(8000);
    expect(backgrounds.map(image => image.hidden)).toEqual([true, false]);
    expect(slides[1].querySelector("a")?.getAttribute("href")).toBe("/two/");
    next.click();
    expect(backgrounds.map(image => image.hidden)).toEqual([false, true]);
    expect(slides[0].hidden).toBe(false);
  });
  it("warms only the selected and adjacent slide images", () => {
    const { backgrounds, images, initialSources, next } = imageWarmingFixture();
    expect(initialSources).toEqual(["/0.jpg", null, null, null, null]);
    expect(backgrounds.map(background => background.hasAttribute("data-home-hero-warm"))).toEqual([true, true, false, false, true]);
    expect(images.map(image => image.loading)).toEqual(["eager", "eager", "lazy", "lazy", "eager"]);
    expect(images.map(image => image.getAttribute("src"))).toEqual(["/0.jpg", "/1.jpg", null, null, "/4.jpg"]);
    images[1].dispatchEvent(new Event("error"));
    expect(images[1].getAttribute("src")).toBe("/fallback.jpg");
    next.click();
    expect(backgrounds.map(background => background.hasAttribute("data-home-hero-warm"))).toEqual([true, true, true, false, false]);
    expect(images.map(image => image.loading)).toEqual(["eager", "eager", "eager", "lazy", "lazy"]);
    expect(images.map(image => image.getAttribute("src"))).toEqual(["/0.jpg", "/fallback.jpg", "/2.jpg", null, "/4.jpg"]);
  });
  it("rotates silently and keeps inactive links inert", () => {
    const { slides, status } = fixture();
    vi.advanceTimersByTime(8000);
    expect(slides[0].hidden).toBe(true);
    expect(slides[0].inert).toBe(true);
    expect(slides[1].hidden).toBe(false);
    expect(slides[1].inert).toBe(false);
    expect(status.textContent).toBe("");
  });
  it("stops on keyboard focus and preserves control focus during manual changes", () => {
    const { slides, next, status } = fixture();
    next.focus();
    vi.advanceTimersByTime(16000);
    expect(slides[0].hidden).toBe(false);
    next.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(slides[1].hidden).toBe(false);
    expect(document.activeElement).toBe(next);
    expect(status.textContent).toContain("2 of 2: Two");
    vi.advanceTimersByTime(8000);
    expect(slides[1].hidden).toBe(false);
  });
  it("a pointer pause click does not resume after focus pauses rotation", () => {
    const { slides, pause } = fixture();
    pause.dispatchEvent(new PointerEvent("pointerdown"));
    pause.focus();
    pause.dispatchEvent(new MouseEvent("click", { detail: 1 }));
    vi.advanceTimersByTime(8000);
    expect(slides[0].hidden).toBe(false);
    expect(pause.textContent).toBe("Resume");
    expect(pause.getAttribute("aria-label")).toBe("Resume rotation");
    pause.click();
    vi.advanceTimersByTime(8000);
    expect(slides[1].hidden).toBe(false);
  });
  it.each(["system", "page"])("honors %s motion preference while allowing manual navigation", setting => {
    if (setting === "system") reduced = true;
    else document.documentElement.dataset.motion = "off";
    const { slides, pause, next } = fixture();
    expect(pause.disabled).toBe(true);
    vi.advanceTimersByTime(8000);
    expect(slides[0].hidden).toBe(false);
    next.click();
    expect(slides[1].hidden).toBe(false);
  });
});
