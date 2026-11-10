// @vitest-environment node
// Node env (not the global happy-dom env) so import.meta.url stays a file URL for
// reading source; the DOM comes from an explicit happy-dom Window per test below.
import { describe, it, expect, vi } from "vitest";
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The primary-nav hamburger is the one disclosure the live public shell ships,
// and its keyboard and state contract is exactly the WAI-ARIA disclosure pattern:
// aria-expanded tracks open/closed, Escape closes and returns focus to the
// trigger, a click outside closes, a click inside does not. Every one of those is
// easy to half-drop in a refactor and invisible until a keyboard user hits the
// gap. The dialog primitive next door is pinned this way in report-widget.test.ts;
// this does the same for the disclosure.
//
// The logic lives in an `is:inline` <script> in PublicSiteLayout.astro. Copying it
// into the test would let the copy drift from what ships, so instead this reads
// the shipped script straight from source and executes it against a real DOM. If
// someone drops the Escape branch or the focus return, this goes red.
const LAYOUT = readFileSync(
  fileURLToPath(
    new URL("../src/layouts/PublicSiteLayout.astro", import.meta.url),
  ),
  "utf8",
);

// The shell has several inline scripts; the disclosure is the one that wires the
// nav-toggle. Pin that there is exactly one so a second nav script cannot silently
// shadow this test's target.
const DISCLOSURE_SCRIPTS = [
  ...LAYOUT.matchAll(/<script is:inline>([\s\S]*?)<\/script>/g),
]
  .map((m) => m[1])
  .filter((s) => s.includes("nav-toggle"));

// A fresh window per test so document-level listeners from one case never bleed
// into the next. The script reads a bare `document`, so it runs bound to this
// window's document.
function mountShell() {
  const win = new Window();
  const doc = win.document;
  doc.body.innerHTML = `
    <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="primary-nav">
      <span class="nav-toggle__bars" aria-hidden="true"></span>
    </button>
    <nav class="primary" id="primary-nav" aria-label="Primary">
      <a href="/about" id="inside">About</a>
    </nav>
    <main><a href="/elsewhere" id="outside">Outside</a></main>
  `;
  const toggle = doc.querySelector(".nav-toggle") as unknown as HTMLElement;
  const nav = doc.getElementById("primary-nav")!;
  const inside = doc.getElementById("inside")!;
  const outside = doc.getElementById("outside")!;
  const run = () => new Function("document", DISCLOSURE_SCRIPTS[0])(doc);
  const click = (el: unknown) =>
    (el as { dispatchEvent: (e: unknown) => void }).dispatchEvent(
      new win.MouseEvent("click", { bubbles: true }),
    );
  const escape = () =>
    doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape" }));
  return { win, doc, toggle, nav, inside, outside, run, click, escape };
}

describe("primary-nav disclosure (shipped shell script)", () => {
  it("toggles aria-expanded and data-open on trigger click", () => {
    const { toggle, nav, run, click } = mountShell();
    run();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(nav.hasAttribute("data-open")).toBe(false);

    click(toggle);
    expect(
      toggle.getAttribute("aria-expanded"),
      "the opening click must not self-close: the document click-to-close handler exempts the toggle",
    ).toBe("true");
    expect(nav.hasAttribute("data-open")).toBe(true);

    click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(nav.hasAttribute("data-open")).toBe(false);
  });

  it("Escape closes an open menu and returns focus to the trigger", () => {
    const { toggle, nav, run, click, escape } = mountShell();
    // Spy before the script captures the element, so we prove the script calls
    // focus() rather than relying on happy-dom's activeElement fidelity. The
    // focus return is the part a refactor drops most often.
    const focusSpy = vi.spyOn(toggle, "focus");
    run();
    click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    escape();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // data-open, not just aria-expanded: the CSS keys panel visibility off
    // data-open, so a close path that drops it would leave the panel visible
    // while ARIA reads closed. Assert both move together.
    expect(nav.hasAttribute("data-open")).toBe(false);
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it("Escape is a no-op and does not steal focus when already closed", () => {
    const { toggle, run, escape } = mountShell();
    const focusSpy = vi.spyOn(toggle, "focus");
    run();
    escape();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it("a click outside the nav closes an open menu", () => {
    const { toggle, nav, outside, run, click } = mountShell();
    run();
    click(toggle);
    click(outside);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(nav.hasAttribute("data-open")).toBe(false);
  });

  it("a click inside the nav does not close the menu", () => {
    const { toggle, inside, run, click } = mountShell();
    run();
    click(toggle);
    click(inside);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });
});
