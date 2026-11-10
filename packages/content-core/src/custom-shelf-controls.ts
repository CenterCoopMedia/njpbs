/** Native scrolling works without this enhancement. The buttons stay local to one shelf. */
export function installCustomShelfControls(root: ParentNode): () => void {
  const dispose: (() => void)[] = [];
  for (const shelf of root.querySelectorAll<HTMLElement>(".custom-shelf--rail")) {
    const track = shelf.querySelector<HTMLElement>(".custom-shelf__track");
    const controls = shelf.querySelector<HTMLElement>(".custom-shelf__controls");
    if (!track || !controls) continue;
    const buttons = Array.from(controls.querySelectorAll<HTMLButtonElement>("button"));
    const update = () => {
      const maximum = track.scrollWidth - track.clientWidth;
      controls.hidden = maximum <= 1;
      for (const button of buttons) {
        button.disabled = button.dataset.shelfDirection === "-1"
          ? track.scrollLeft <= 1 : track.scrollLeft >= maximum - 1;
      }
    };
    const move = (event: Event) => {
      const button = (event.target as Element).closest<HTMLButtonElement>("button[data-shelf-direction]");
      if (!button) return;
      track.scrollBy({ left: Number(button.dataset.shelfDirection) * track.clientWidth * 0.8,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    };
    const observer = new ResizeObserver(update);
    observer.observe(track);
    controls.addEventListener("click", move);
    track.addEventListener("scroll", update, { passive: true });
    update();
    dispose.push(() => {
      observer.disconnect();
      controls.removeEventListener("click", move);
      track.removeEventListener("scroll", update);
    });
  }
  return () => dispose.forEach(cleanup => cleanup());
}
