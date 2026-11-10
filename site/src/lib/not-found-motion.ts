/** A bounded tuning ident. Navigation and content never depend on motion. */
export function mountNotFoundDial(root: HTMLElement): () => void {
  const slider = root.querySelector<HTMLInputElement>("[data-dial-input]");
  const replay = root.querySelector<HTMLButtonElement>("[data-dial-replay]");
  const controls = root.querySelector<HTMLElement>("[data-dial-controls]");
  const hint = root.querySelector<HTMLElement>("[data-dial-hint]");
  if (!slider || !replay || !controls || !hint) return () => {};
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
  const stopped = () => preference.matches || document.documentElement.dataset.motion === "off" ||
    document.documentElement.hasAttribute("data-saver");
  const stop = () => { root.dataset.turning = "false"; };
  const sync = () => {
    slider.disabled = replay.disabled = stopped();
    if (stopped()) {
      stop();
      root.style.setProperty("--dial-offset", "0deg");
      slider.value = "0";
    }
    hint.textContent = stopped() ? "Motion is off in your preferences." : "Turn the dial. The links below are ready now.";
  };
  const play = () => {
    stop();
    if (stopped() || document.hidden) return;
    root.style.setProperty("--dial-offset", "0deg");
    slider.value = "0";
    // Restart only the finite CSS ident; there is no animation loop or timer.
    void root.getBoundingClientRect();
    root.dataset.turning = "true";
  };
  slider.addEventListener("input", () => {
    if (stopped()) return;
    stop();
    const angle = Math.max(-180, Math.min(180, Number(slider.value) || 0));
    root.style.setProperty("--dial-offset", `${angle}deg`);
  }, options);
  replay.addEventListener("click", play, options);
  root.addEventListener("animationend", event => {
    if ((event.target as HTMLElement).hasAttribute("data-dial-outer")) stop();
  }, options);
  document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); }, options);
  preference.addEventListener("change", sync, options);
  const observer = new MutationObserver(sync);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion", "data-saver"] });
  controls.hidden = false;
  sync();
  play();
  return () => { controller.abort(); observer.disconnect(); stop(); };
}
