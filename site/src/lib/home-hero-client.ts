import { mountHomeStoryImages } from "../../../packages/content-core/src/home-story-image-dom";

const ROTATION_MS = 8_000;
const mounted = new WeakSet<HTMLElement>();

export function mountHomeHeroes(root: ParentNode = document): void {
  mountHomeStoryImages(root);
  root.querySelectorAll<HTMLElement>("[data-home-hero]").forEach(mountHomeHero);
}

function mountHomeHero(hero: HTMLElement): void {
  if (mounted.has(hero)) return;
  hero.querySelectorAll<HTMLImageElement>("[data-home-hero-image]").forEach(image => {
    // Spotlight's shared handler also owns script-free saved/phone previews.
    if (image.hasAttribute("data-spotlight-fallback")) return;
    const showFallback = () => {
      if (image.hasAttribute("srcset")) {
        image.removeAttribute("srcset");
        image.removeAttribute("sizes");
        return; // A missing derivative retries the original before topic art.
      }
      const fallback = image.dataset.fallbackSrc;
      if (fallback && image.getAttribute("src") !== fallback) {
        image.style.objectPosition = image.dataset.fallbackPosition ?? "center";
        image.src = fallback;
      }
      else image.hidden = true;
    };
    image.addEventListener("error", showFallback);
    if (image.hasAttribute("src") && image.complete && image.naturalWidth === 0) showFallback();
  });
  const backgrounds = [...hero.querySelectorAll<HTMLElement>("[data-home-hero-background]")];
  const slides = [...hero.querySelectorAll<HTMLElement>("[data-home-hero-slide]")];
  const controls = hero.querySelector<HTMLElement>("[data-home-hero-controls]");
  const previous = hero.querySelector<HTMLButtonElement>("[data-home-hero-previous]");
  const next = hero.querySelector<HTMLButtonElement>("[data-home-hero-next]");
  const pause = hero.querySelector<HTMLButtonElement>("[data-home-hero-pause]");
  const count = hero.querySelector<HTMLElement>("[data-home-hero-count]");
  const status = hero.querySelector<HTMLElement>("[data-home-hero-status]");
  if (slides.length < 2 || !controls || !previous || !next || !pause || !count || !status) return;
  const ui = { pause, count, status };
  mounted.add(hero);
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  let index = 0;
  let paused = false;
  let hovered = false;
  let pauseBeforePointerFocus: boolean | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const motionOff = () => media.matches || document.documentElement.dataset.motion === "off";

  function warmImages(center: number): void {
    const nearby = new Set([center, (center - 1 + slides.length) % slides.length, (center + 1) % slides.length]);
    backgrounds.forEach((background, position) => {
      background.toggleAttribute("data-home-hero-warm", nearby.has(position));
      const image = background.querySelector<HTMLImageElement>("[data-home-hero-image]");
      if (!image) return;
      image.loading = nearby.has(position) ? "eager" : "lazy";
      const source = image.dataset.homeHeroSrc;
      if (nearby.has(position) && source && !image.hasAttribute("src")) {
        if (image.dataset.homeHeroSrcset) {
          image.sizes = image.dataset.homeHeroSizes ?? "100vw";
          image.srcset = image.dataset.homeHeroSrcset;
          delete image.dataset.homeHeroSrcset;
          delete image.dataset.homeHeroSizes;
        }
        delete image.dataset.homeHeroSrc;
        image.src = source;
      }
    });
  }

  function stopTimer(): void {
    clearTimeout(timer);
    timer = undefined;
  }

  function schedule(): void {
    stopTimer();
    ui.pause.disabled = motionOff();
    ui.pause.textContent = motionOff() ? "Off" : paused ? "Resume" : "Pause";
    ui.pause.setAttribute("aria-label", motionOff() ? "Rotation off" : paused ? "Resume rotation" : "Pause rotation");
    if (paused || hovered || motionOff() || document.hidden) return;
    timer = setTimeout(() => show(index + 1, false), ROTATION_MS);
  }

  function show(target: number, announce: boolean): void {
    index = (target + slides.length) % slides.length;
    warmImages(index);
    slides.forEach((slide, position) => {
      slide.hidden = position !== index;
      slide.inert = position !== index;
    });
    backgrounds.forEach((background, position) => { background.hidden = position !== index; });
    ui.count.textContent = `${index + 1} / ${slides.length}`;
    // Automatic rotation does not repeatedly interrupt screen-reader output.
    if (announce) ui.status.textContent = `${index + 1} of ${slides.length}: ${slides[index].dataset.title}`;
    schedule();
  }

  previous.addEventListener("click", () => { paused = true; show(index - 1, true); });
  next.addEventListener("click", () => { paused = true; show(index + 1, true); });
  pause.addEventListener("pointerdown", () => { pauseBeforePointerFocus = paused; });
  pause.addEventListener("pointercancel", () => { pauseBeforePointerFocus = undefined; });
  pause.addEventListener("click", (event) => {
    paused = !(event.detail > 0 ? pauseBeforePointerFocus ?? paused : paused);
    pauseBeforePointerFocus = undefined;
    schedule();
  });
  hero.addEventListener("focusin", () => { paused = true; schedule(); });
  hero.addEventListener("mouseenter", () => { hovered = true; schedule(); });
  hero.addEventListener("mouseleave", () => { hovered = false; schedule(); });
  hero.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    // Keep focus on the control; changing a focused slide would hide its link.
    if (!controls.contains(document.activeElement)) return;
    event.preventDefault();
    paused = true;
    show(index + (event.key === "ArrowRight" ? 1 : -1), true);
  });
  media.addEventListener("change", schedule);
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
  document.addEventListener("visibilitychange", schedule);
  const pagehide = (event: PageTransitionEvent) => {
    stopTimer();
    if (event.persisted) return;
    observer.disconnect();
    media.removeEventListener("change", schedule);
    document.removeEventListener("visibilitychange", schedule);
    window.removeEventListener("pageshow", schedule);
    window.removeEventListener("pagehide", pagehide);
  };
  window.addEventListener("pagehide", pagehide);
  window.addEventListener("pageshow", schedule);
  warmImages(index);
  controls.hidden = false;
  schedule();
}
