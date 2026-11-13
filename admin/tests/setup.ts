import { repositoryFixture } from "../../tests/helpers/repository-identity.mjs";
Object.assign(process.env, repositoryFixture);
import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";
import { afterAll, vi } from "vitest";

// findBy and waitFor give up after 1 s by default. On a shared CI host a heavy
// editor render can take longer, so allow 5 s before reporting a missing element.
configure({ asyncUtilTimeout: 5_000 });

// jsdom has no layout and omits Range geometry used by ProseMirror's selection
// scrolling. Browser tests verify actual geometry; component tests need the API.
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect();

// @tiptap/react destroys an unmounted editor on a 1 ms timer. Testing Library
// unmounts after the last test, and jsdom is torn down right after the file
// finishes, so on a slow runner that timer ran without `window` and Vitest
// reported an uncaught ReferenceError. Let pending timers run first.
afterAll(async () => {
  vi.useRealTimers(); // a file that left fake timers on would otherwise stall this wait
  await new Promise((resolve) => setTimeout(resolve, 20));
});

// jsdom has the dialog element but not its native modal methods. Browser tests
// separately verify top-layer focus and inertness; component tests need lifecycle.
if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
}
if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.close) {
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}
