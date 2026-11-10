import { describe, expect, it } from "vitest";
import { placeFloating } from "../src/lib/floating-position";

const viewport = { width: 1280, height: 800 };
const size = { width: 200, height: 120 };
const anchor = (left: number, top: number, width = 40, height = 40) => ({
  left, top, width, height, right: left + width, bottom: top + height,
});

describe("placeFloating", () => {
  it("opens below the anchor, aligned to its start edge", () => {
    expect(placeFloating(anchor(100, 100), size, viewport, "bottom-start")).toEqual({
      left: 100, top: 144, placement: "bottom-start",
    });
  });

  it("aligns to the end edge when asked", () => {
    const placed = placeFloating(anchor(1000, 100), size, viewport, "bottom-end");
    expect(placed.left).toBe(1040 - 200);
  });

  it("flips above when there is no room below", () => {
    const placed = placeFloating(anchor(100, 700), size, viewport, "bottom-start");
    expect(placed).toMatchObject({ top: 700 - 4 - 120, placement: "top-start" });
  });

  it("keeps the panel inside the viewport margin horizontally", () => {
    expect(placeFloating(anchor(1250, 100), size, viewport, "bottom-start").left).toBe(1280 - 8 - 200);
    expect(placeFloating(anchor(2, 100), size, viewport, "bottom-end").left).toBe(8);
  });

  it("stays inside the viewport when it fits neither above nor below", () => {
    const tall = { width: 200, height: 780 };
    const placed = placeFloating(anchor(100, 300), tall, viewport, "bottom-start");
    expect(placed.top).toBeGreaterThanOrEqual(8);
    expect(placed.top + tall.height).toBeLessThanOrEqual(viewport.height);
  });

  it("opens at a pointer, treated as a zero-size anchor", () => {
    expect(placeFloating(anchor(300, 200, 0, 0), size, viewport, "bottom-start")).toEqual({
      left: 300, top: 204, placement: "bottom-start",
    });
  });
});

// #3510: a long Add menu must leave the page actions above its trigger reachable.
describe("menus constrained below their trigger", () => {
  it("uses the available phone height without flipping over the page actions", () => {
    const phone = { width: 390, height: 844 };
    const placed = placeFloating(anchor(41, 117, 89, 44), { width: 320, height: 1000 }, phone, "bottom-start", { fitBelow: true });
    expect(placed).toMatchObject({ top: 165, placement: "bottom-start" });
    expect(placed.top + placed.maxHeight!).toBe(phone.height - 8);
    expect(placed.left).toBeGreaterThanOrEqual(8);
    expect(placed.left + 320).toBeLessThanOrEqual(phone.width - 8);
  });

  it("retains a touch-sized scrolling region for a trigger near the bottom edge", () => {
    const placed = placeFloating(anchor(41, 810), { width: 320, height: 1000 }, { width: 390, height: 844 }, "bottom-start", { fitBelow: true });
    expect(placed.top).toBe(792);
    expect(placed.maxHeight).toBe(44);
  });
});
