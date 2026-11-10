import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { FocalPointControl } from "../src/components/FocalPointControl";
import { cropWindow, placementAtPoint } from "../src/lib/focal-placement";

describe("stored crop placement", () => {
  it("preserves CSS object-position for landscape and portrait images", () => {
    expect(cropWindow(800, 400, 1, { x: 0.8, y: 0.2 })).toEqual({ left: 0.4, top: 0, width: 0.5, height: 1 });
    expect(cropWindow(400, 800, 1, { x: 0.8, y: 0.2 })).toEqual({ left: 0, top: 0.1, width: 1, height: 0.5 });
  });

  it("converts a source-image point to crop position and keeps the uncropped axis", () => {
    const current = { x: 0.5, y: 0.2 };
    const crop = cropWindow(800, 400, 1, current)!;
    expect(placementAtPoint({ x: 0.65, y: 0.9 }, crop, current)).toEqual({ x: 0.8, y: 0.2 });
    expect(placementAtPoint({ x: -0.2, y: 2 }, crop, current)).toEqual({ x: 0, y: 0.2 });
    expect(placementAtPoint({ x: 1.2, y: -1 }, crop, current)).toEqual({ x: 1, y: 0.2 });
  });

  it("handles square and extreme images and rejects unusable dimensions", () => {
    expect(cropWindow(400, 400, 1, { x: 0.9, y: 0.1 })).toEqual({ left: 0, top: 0, width: 1, height: 1 });
    expect(cropWindow(40000, 400, 1, { x: 1, y: 0 })).toEqual({ left: 0.99, top: 0, width: 0.01, height: 1 });
    expect(cropWindow(0, 400, 1, { x: 0.5, y: 0.5 })).toBeNull();
    expect(cropWindow(400, Infinity, 1, { x: 0.5, y: 0.5 })).toBeNull();
    expect(cropWindow(800, 400, 1, { x: NaN, y: 2 })).toEqual({ left: 0.25, top: 0, width: 0.5, height: 1 });
  });
});

function setup() {
  const changed = vi.fn();
  function Form() {
    const [value, setValue] = useState({ x: 0.3, y: 0.7 });
    return <FocalPointControl src="/photo.jpg" value={value} onChange={(next) => { changed(next); setValue(next); }} />;
  }
  const view = render(<Form />);
  const image = screen.getByAltText("Original image for crop placement");
  Object.defineProperties(image, { naturalWidth: { value: 800 }, naturalHeight: { value: 400 } });
  vi.spyOn(image, "getBoundingClientRect").mockReturnValue({ left: 100, right: 500, top: 50, bottom: 250, width: 400, height: 200 } as DOMRect);
  fireEvent.load(image);
  const surface = screen.getByRole("button", { name: "Image focal point" });
  surface.setPointerCapture = vi.fn();
  surface.hasPointerCapture = vi.fn(() => true);
  surface.releasePointerCapture = vi.fn();
  const pointer = (type: string, clientX = 300, clientY = 150) => {
    const event = new MouseEvent(type, { bubbles: true, clientX, clientY, button: 0 });
    Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } });
    fireEvent(surface, event);
  };
  return { ...view, changed, image, surface, pointer };
}

describe("image crop interaction", () => {
  it("previews a drag and commits exactly once on release", () => {
    const { changed, pointer } = setup();
    expect(changed).not.toHaveBeenCalled();
    pointer("pointerdown", 300);
    pointer("pointermove", 350);
    pointer("pointermove", 400);
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByAltText("Current crop preview")).toHaveStyle({ objectPosition: "100% 70%" });
    pointer("pointerup", 400);
    expect(changed).toHaveBeenCalledExactlyOnceWith({ x: 1, y: 0.7 });
  });

  it.each(["pointercancel", "Escape"])("cancels %s without changing the saved form value", (cancel) => {
    const { changed, surface, pointer } = setup();
    pointer("pointerdown", 400);
    if (cancel === "Escape") fireEvent.keyDown(surface, { key: "Escape" });
    else pointer(cancel);
    pointer("pointerup", 400);
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByAltText("Current crop preview")).toHaveStyle({ objectPosition: "30% 70%" });
    expect(surface.releasePointerCapture).toHaveBeenCalledWith(1);
  });

  it("supports keyboard moves, non-drag buttons, reset and image failure", () => {
    const { changed, image, surface } = setup();
    fireEvent.keyDown(surface, { key: "ArrowRight", shiftKey: true });
    expect(changed).toHaveBeenLastCalledWith({ x: 0.4, y: 0.7 });
    fireEvent.click(screen.getByRole("button", { name: "Move left" }));
    expect(changed).toHaveBeenLastCalledWith({ x: 0.35, y: 0.7 });
    expect(screen.getByRole("button", { name: "Move up" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Reset to center" }));
    expect(changed).toHaveBeenLastCalledWith({ x: 0.5, y: 0.5 });
    fireEvent.error(image);
    expect(screen.getByRole("button", { name: "Move right" })).toBeDisabled();
    expect(screen.getByText(/image could not be loaded/)).toBeVisible();
    expect(changed).toHaveBeenCalledTimes(3);
  });
});
