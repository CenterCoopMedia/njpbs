import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { installReaderTextSize, READER_TEXT_SIZE_KEY } from "../src/lib/reader-text-size";

function picker() {
  document.body.innerHTML = `<div data-reader-text-size-picker hidden><fieldset><legend>Text size</legend>
    <input type="radio" name="reader-text-size" value="standard" aria-label="Standard text size" checked>
    <input type="radio" name="reader-text-size" value="large" aria-label="Large text size">
    <input type="radio" name="reader-text-size" value="largest" aria-label="Largest text size">
  </fieldset></div><div class="cms-block--prose"><p>Reading copy.</p></div>`;
  return document.querySelector<HTMLElement>("[data-reader-text-size-picker]")!;
}
function choose(value: string) {
  const input = document.querySelector<HTMLInputElement>(`input[value="${value}"]`)!;
  input.checked = true;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  delete document.documentElement.dataset.readerTextSize;
  window.localStorage.clear();
});

describe("reader text size", () => {
  const base = readFileSync("src/layouts/Base.astro", "utf8");
  const bootstrap = base.match(/<script is:inline>\s*(\(function \(\) \{\s*var size = "standard";[\s\S]*?)<\/script>/)![1];

  it.each([null, "standard", "large", "largest", "invalid"])("restores %s in the synchronous head bootstrap", saved => {
    if (saved !== null) window.localStorage.setItem(READER_TEXT_SIZE_KEY, saved);
    window.eval(bootstrap);
    expect(document.documentElement.dataset.readerTextSize).toBe(
      saved === "large" || saved === "largest" ? saved : "standard",
    );
    expect(base.indexOf(bootstrap)).toBeLessThan(base.indexOf("<title>"));
  });

  it("sets the early standard size when storage is denied", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new Error("blocked"); });
    window.eval(bootstrap);
    expect(document.documentElement.dataset.readerTextSize).toBe("standard");
  });

  it("preserves the head preference if storage becomes unavailable before enhancement", () => {
    picker();
    document.documentElement.dataset.readerTextSize = "large";
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new Error("blocked"); });
    const cleanup = installReaderTextSize(document, window);
    expect(document.documentElement.dataset.readerTextSize).toBe("large");
    expect(document.querySelector<HTMLInputElement>('input[value="large"]')?.checked).toBe(true);
    cleanup();
  });

  it("preserves the standard size until enhancement is available", () => {
    const root = picker();
    expect(root.hidden).toBe(true);
    const cleanup = installReaderTextSize(document, window);
    expect(root.hidden).toBe(false);
    expect(document.documentElement.dataset.readerTextSize).toBe("standard");
    expect(document.querySelector<HTMLInputElement>('input[value="standard"]')?.checked).toBe(true);
    cleanup();
  });

  it("saves a chosen size, restores it on another Page or Post and resets to standard", () => {
    picker();
    const cleanup = installReaderTextSize(document, window);
    choose("largest");
    expect(document.documentElement.dataset.readerTextSize).toBe("largest");
    expect(window.localStorage.getItem(READER_TEXT_SIZE_KEY)).toBe("largest");
    cleanup();
    picker();
    const cleanupNext = installReaderTextSize(document, window);
    expect(document.querySelector<HTMLInputElement>('input[value="largest"]')?.checked).toBe(true);
    choose("standard");
    expect(document.documentElement.dataset.readerTextSize).toBe("standard");
    expect(window.localStorage.getItem(READER_TEXT_SIZE_KEY)).toBe("standard");
    cleanupNext();
  });

  it("ignores an invalid saved preference", () => {
    window.localStorage.setItem(READER_TEXT_SIZE_KEY, "oversized");
    picker();
    const cleanup = installReaderTextSize(document, window);
    expect(document.documentElement.dataset.readerTextSize).toBe("standard");
    cleanup();
  });

  it("continues to work when the browser denies storage access", () => {
    picker();
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new Error("blocked"); });
    const cleanup = installReaderTextSize(document, window);
    choose("large");
    window.dispatchEvent(new Event("pageshow"));
    expect(document.documentElement.dataset.readerTextSize).toBe("large");
    expect(document.querySelector<HTMLInputElement>('input[value="large"]')?.checked).toBe(true);
    cleanup();
  });

  it("updates a restored page and reacts to preference changes in other tabs", () => {
    picker();
    const cleanup = installReaderTextSize(document, window);
    window.localStorage.setItem(READER_TEXT_SIZE_KEY, "large");
    window.dispatchEvent(new Event("pageshow"));
    expect(document.documentElement.dataset.readerTextSize).toBe("large");
    window.localStorage.setItem(READER_TEXT_SIZE_KEY, "largest");
    window.dispatchEvent(new StorageEvent("storage", { key: READER_TEXT_SIZE_KEY, newValue: "largest" }));
    expect(document.querySelector<HTMLInputElement>('input[value="largest"]')?.checked).toBe(true);
    window.localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(document.documentElement.dataset.readerTextSize).toBe("standard");
    cleanup();
  });

  it("does not touch pages without a picker", () => {
    window.localStorage.setItem(READER_TEXT_SIZE_KEY, "largest");
    const cleanup = installReaderTextSize(document, window);
    expect(document.documentElement.dataset.readerTextSize).toBeUndefined();
    cleanup();
  });

  it("keeps the picker hidden on pages with no reading copy", () => {
    const root = picker();
    document.querySelector(".cms-block--prose")?.remove();
    const cleanup = installReaderTextSize(document, window);
    expect(root.hidden).toBe(true);
    expect(document.documentElement.dataset.readerTextSize).toBeUndefined();
    cleanup();
  });

  it("keeps the Data Hub picker with its movable introduction", () => {
    const control = picker();
    control.dataset.readerWithin = "data-hub";
    const hub = document.createElement("div");
    hub.className = "data-hub";
    hub.innerHTML = '<section class="intro"><div class="intro__inner"><h1>New Jersey by the Numbers</h1></div></section>';
    document.body.append(hub);
    const cleanup = installReaderTextSize(document, window);
    expect(hub.querySelector(".intro__inner")?.contains(control)).toBe(true);
    expect(document.querySelectorAll("[data-reader-text-size-picker]")).toHaveLength(1);
    cleanup();
  });
});
