import { homepageBannerWindow } from "../../../packages/content-core/src/homepage-banner-window";

/** Cached HTML still observes the staff schedule without another publication. */
export function mountHomepageBannerSchedule(element: HTMLElement) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  function update() {
    clearTimeout(timer);
    const now = Date.now();
    const state = homepageBannerWindow({ enabled: true,
      startsAt: element.dataset.startsAt, endsAt: element.dataset.endsAt }, now);
    element.hidden = !state.visible;
    if (state.nextBoundary !== undefined) {
      timer = setTimeout(update, Math.min(2_147_483_647, Math.max(1, state.nextBoundary - now)));
    }
  }
  const visibility = () => { if (!document.hidden) update(); };
  update();
  window.addEventListener("pageshow", update);
  document.addEventListener("visibilitychange", visibility);
  return () => {
    clearTimeout(timer);
    window.removeEventListener("pageshow", update);
    document.removeEventListener("visibilitychange", visibility);
  };
}
