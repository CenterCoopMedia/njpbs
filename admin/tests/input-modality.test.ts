import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { installPointerFocusTracking } from "../src/lib/input-modality";

describe("pointer focus tracking", () => {
  let dispose: (() => void) | undefined;

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    document.body.replaceChildren();
  });

  it("marks the focusable control behind a pointer target and clears it for keyboard use", () => {
    document.body.innerHTML = '<button type="button"><span>Open</span></button>';
    const button = document.querySelector("button");
    const label = document.querySelector("span");
    if (!button || !label) throw new Error("Missing test control");

    dispose = installPointerFocusTracking(document);
    fireEvent.pointerDown(label);
    expect(button).toHaveAttribute("data-pointer-focus", "true");

    fireEvent.keyDown(document, { key: "Tab" });
    expect(button).not.toHaveAttribute("data-pointer-focus");
  });

  it("clears a pointer marker when focus leaves the control", () => {
    document.body.innerHTML = '<select><option>Home</option></select>';
    const select = document.querySelector("select");
    if (!select) throw new Error("Missing test control");

    dispose = installPointerFocusTracking(document);
    fireEvent.pointerDown(select);
    expect(select).toHaveAttribute("data-pointer-focus", "true");

    fireEvent.focusOut(select);
    expect(select).not.toHaveAttribute("data-pointer-focus");
  });
});
