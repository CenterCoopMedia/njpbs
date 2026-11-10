import { vi } from "vitest";

// jsdom has no layout. These stubs give elements the few measurements a component reads.

/**
 * Gives an OverflowToolbar root a width, and each other element the width in its
 * data-width attribute, or the sum of its data-width descendants with 8px gaps.
 */
export function stubWidths(root: number) {
  return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const sum = (element: HTMLElement) => Array.from(element.querySelectorAll<HTMLElement>("[data-width]"))
      .reduce((total, child, index) => total + Number(child.dataset.width) + (index > 0 ? 8 : 0), 0);
    const width = this.classList.contains("ui-overflow-toolbar") ? root
      : this.dataset.width ? Number(this.dataset.width)
        : sum(this);
    return { width, height: 44, top: 0, left: 0, right: width, bottom: 44, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
}

/**
 * Gives a scroll container fixed scrollWidth and clientWidth and a writable scrollLeft.
 * Returns the writes to scrollLeft, in order.
 */
export function stubScroll(
  element: HTMLElement,
  { clientWidth, scrollLeft = 0, scrollWidth }: { clientWidth: number; scrollLeft?: number; scrollWidth: number },
) {
  let left = scrollLeft;
  const writes: number[] = [];
  Object.defineProperties(element, {
    clientWidth: { configurable: true, get: () => clientWidth },
    scrollWidth: { configurable: true, get: () => scrollWidth },
    scrollLeft: {
      configurable: true,
      get: () => left,
      set: (value: number) => {
        left = value;
        writes.push(value);
      },
    },
  });
  return writes;
}

/** Gives an element a fixed offsetLeft and offsetWidth inside its scroll container. */
export function stubOffset(element: HTMLElement, { offsetLeft, offsetWidth }: { offsetLeft: number; offsetWidth: number }) {
  Object.defineProperties(element, {
    offsetLeft: { configurable: true, get: () => offsetLeft },
    offsetWidth: { configurable: true, get: () => offsetWidth },
  });
}
