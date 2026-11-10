// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountNotFoundDial } from "../src/lib/not-found-motion";

let reduced = false;
let preferenceChange: (() => void) | undefined;
beforeEach(() => {
  reduced = false;
  preferenceChange = undefined;
  vi.stubGlobal("matchMedia", () => ({
    get matches() { return reduced; },
    addEventListener(_type: string, listener: () => void) { preferenceChange = listener; },
    removeEventListener() {},
  }));
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
});
afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-motion");
  document.documentElement.removeAttribute("data-saver");
  vi.unstubAllGlobals();
});

function fixture() {
  document.body.innerHTML = `<section data-not-found-dial>
    <div data-dial-outer></div>
    <div data-dial-controls hidden>
      <input type="range" min="-180" max="180" value="0" step="1" data-dial-input />
      <button type="button" data-dial-replay>Replay</button>
      <p data-dial-hint></p>
    </div></section>`;
  const root = document.querySelector<HTMLElement>("[data-not-found-dial]")!;
  return {
    root,
    cleanup: mountNotFoundDial(root),
    slider: root.querySelector<HTMLInputElement>("[data-dial-input]")!,
    replay: root.querySelector<HTMLButtonElement>("[data-dial-replay]")!,
    controls: root.querySelector<HTMLElement>("[data-dial-controls]")!,
    hint: root.querySelector<HTMLElement>("[data-dial-hint]")!,
    outer: root.querySelector<HTMLElement>("[data-dial-outer]")!,
  };
}

describe("not-found tuning dial", () => {
  it("stops motion for the system setting, the saved setting and data saver", () => {
    const { root, slider, replay, hint } = fixture();
    reduced = true;
    preferenceChange?.();
    expect(slider.disabled).toBe(true);
    expect(replay.disabled).toBe(true);
    expect(root.dataset.turning).toBe("false");
    expect(hint.textContent).toBe("Motion is off in your preferences.");
    reduced = false;
    preferenceChange?.();
    expect(slider.disabled).toBe(false);

    document.documentElement.dataset.motion = "off";
    const saved = fixture();
    expect(saved.slider.disabled).toBe(true);
    expect(saved.root.dataset.turning).toBe("false");
    document.documentElement.removeAttribute("data-motion");

    document.documentElement.setAttribute("data-saver", "");
    const saver = fixture();
    expect(saver.replay.disabled).toBe(true);
    expect(saver.root.dataset.turning).toBe("false");
  });
});
