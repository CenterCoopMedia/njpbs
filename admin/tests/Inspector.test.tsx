import { act, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Inspector, InspectorSection } from "../src/components/ui/Inspector";
import { Menu } from "../src/components/ui/Menu";

function setViewport(width: number) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: /max-width:\s*([\d.]+)rem/.test(query) ? width <= Number(/max-width:\s*([\d.]+)rem/.exec(query)![1]) * 16 : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

function Harness({ dirty = false, heading = "Sunset over Newark", compactQuery, autoFocusOnOpen }: { dirty?: boolean; heading?: string; compactQuery?: string; autoFocusOnOpen?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">Open tile</button>
      <Inspector
        compactQuery={compactQuery}
        autoFocusOnOpen={autoFocusOnOpen}
        dirty={dirty}
        footer={<button type="button">Save details</button>}
        heading={heading}
        label="Image details"
        onClose={() => setOpen(false)}
        open={open}
        storageKey="test"
      >
        <InspectorSection id="details" title="Details"><p>Name field</p></InspectorSection>
        <InspectorSection defaultOpen={false} id="file" title="File information"><p>Size</p></InspectorSection>
      </Inspector>
    </>
  );
}

beforeEach(() => {
  localStorage.clear();
  setViewport(1280);
});
afterEach(() => vi.restoreAllMocks());

describe("Inspector", () => {
  it("resizes from the keyboard within its bounds and stores the width", () => {
    const { unmount } = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open tile" }));
    const handle = screen.getByRole("separator", { name: "Resize details" });
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle).toHaveAttribute("aria-valuenow", "20");
    expect(handle).toHaveAttribute("aria-valuemin", "18");
    expect(handle).toHaveAttribute("aria-valuemax", "28");

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(handle).toHaveAttribute("aria-valuenow", "22");
    expect(screen.getByRole("complementary")).toHaveStyle({ width: "22rem" });
    fireEvent.keyDown(handle, { key: "End" });
    expect(handle).toHaveAttribute("aria-valuenow", "28");
    unmount();

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open tile" }));
    expect(screen.getByRole("separator", { name: "Resize details" })).toHaveAttribute("aria-valuenow", "28");
  });

  it("resizes by dragging the handle", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open tile" }));
    const handle = screen.getByRole("separator", { name: "Resize details" });
    handle.setPointerCapture = vi.fn();
    fireEvent.pointerDown(handle, { button: 0, clientX: 900, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 836, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 836, pointerId: 1 });
    expect(handle).toHaveAttribute("aria-valuenow", "24");
  });

  it("ignores secondary buttons and stores the width when a drag is interrupted", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open tile" }));
    const handle = screen.getByRole("separator", { name: "Resize details" });
    handle.setPointerCapture = vi.fn();
    fireEvent.pointerDown(handle, { button: 2, clientX: 900, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 836, pointerId: 1 });
    expect(handle).toHaveAttribute("aria-valuenow", "20");
    fireEvent.pointerDown(handle, { button: 0, clientX: 900, pointerId: 2 });
    fireEvent.pointerMove(handle, { clientX: 836, pointerId: 2 });
    expect(localStorage.getItem("cms.inspector.test.width")).toBeNull();
    fireEvent.pointerCancel(handle, { pointerId: 2 });
    expect(localStorage.getItem("cms.inspector.test.width")).toBe("24");
    fireEvent.pointerDown(handle, { button: 0, clientX: 900, pointerId: 3 });
    fireEvent.pointerMove(handle, { clientX: 804, pointerId: 3 });
    fireEvent.lostPointerCapture(handle, { pointerId: 3 });
    expect(localStorage.getItem("cms.inspector.test.width")).toBe("28");
  });

  it("keeps width changes usable when browser storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Blocked"); });
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open tile" }));
    const handle = screen.getByRole("separator", { name: "Resize details" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(handle).toHaveAttribute("aria-valuenow", "21");
  });

  it("under 62rem the sheet is modal: the page behind is inert and Tab stays inside", () => {
    setViewport(800);
    const notices = document.createElement("div");
    notices.className = "success-notice-region";
    notices.setAttribute("role", "region");
    notices.setAttribute("aria-label", "Notifications");
    const overlay = document.createElement("div");
    overlay.id = "admin-overlay-root";
    const alreadyInert = document.createElement("div");
    alreadyInert.setAttribute("inert", "");
    // A branch that holds the toast region goes inert around it, not as a whole.
    const shell = document.createElement("div");
    const nav = document.createElement("nav");
    const nestedNotices = document.createElement("div");
    nestedNotices.className = "success-notice-region";
    shell.append(nav, nestedNotices);
    document.body.append(notices, overlay, alreadyInert, shell);
    try {
      render(<Harness />);
      const opener = screen.getByRole("button", { name: "Open tile" });
      opener.focus();
      fireEvent.click(opener);
      expect(opener.closest("[inert]")).not.toBeNull();
      // The toast region stays announced and menus opened from the sheet stay usable.
      expect(notices).not.toHaveAttribute("inert");
      expect(overlay).not.toHaveAttribute("inert");
      expect(shell).not.toHaveAttribute("inert");
      expect(nav).toHaveAttribute("inert");
      expect(nestedNotices).not.toHaveAttribute("inert");

      const close = screen.getByRole("button", { name: "Close details" });
      const save = screen.getByRole("button", { name: "Save details" });
      save.focus();
      fireEvent.keyDown(save, { key: "Tab" });
      expect(close).toHaveFocus();
      fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
      expect(save).toHaveFocus();

      fireEvent.click(close);
      expect([...document.querySelectorAll("[inert]")]).toEqual([alreadyInert]);
      expect(document.querySelector(".ui-inspector-scrim")).toBeNull();
      expect(opener).toHaveFocus();
    } finally {
      notices.remove();
      overlay.remove();
      alreadyInert.remove();
      shell.remove();
    }
  });

  it("wraps Tab past a collapsed section when the sheet has no footer", () => {
    setViewport(800);
    render(
      <Inspector heading="Image" label="Image details" onClose={vi.fn()} open storageKey="test">
        <InspectorSection id="details" title="Details"><input aria-label="Hidden name" /></InspectorSection>
      </Inspector>,
    );
    const close = screen.getByRole("button", { name: "Close details" });
    const section = screen.getByRole("button", { name: "Details" });
    fireEvent.click(section);
    section.focus();
    fireEvent.keyDown(section, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(section).toHaveFocus();
  });

  it("returns Tab from a portaled section menu to its trigger inside the modal sheet", () => {
    setViewport(800);
    const overlay = document.createElement("div");
    overlay.id = "admin-overlay-root";
    document.body.append(overlay);
    try {
      render(
        <Inspector heading="5 items" label="Edit selected" onClose={vi.fn()} open storageKey="test">
          <InspectorSection actions={<Menu items={[{ key: "clear", label: "Clear all tags", onSelect: vi.fn() }]} label="Tag actions" />} id="tags" title="Tags">
            <p>Tags</p>
          </InspectorSection>
        </Inspector>,
      );
      const trigger = screen.getByRole("button", { name: "Tag actions" });
      fireEvent.click(trigger);
      const item = screen.getByRole("menuitem", { name: "Clear all tags" });
      expect(item).toHaveFocus();
      fireEvent.keyDown(item, { key: "Tab" });
      expect(trigger).toHaveFocus();
      expect(screen.queryByRole("menu")).toBeNull();
    } finally {
      overlay.remove();
    }
  });

  it("moves focus into the sheet when a wide open inspector becomes modal", () => {
    let compact = false;
    const listeners = new Set<() => void>();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        get matches() { return /max-width:\s*61\.99rem/.test(query) && compact; },
        media: query,
        addEventListener: (_: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
      }),
    });
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open tile" });
    fireEvent.click(opener);
    opener.focus();
    compact = true;
    act(() => { for (const listener of listeners) listener(); });
    expect(screen.getByRole("dialog", { name: "Image details" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sunset over Newark" })).toHaveFocus();
  });

  it("consumes Escape while there is unsaved work, so an enclosing dialog stays open", () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <Inspector dirty heading="Sunset over Newark" label="Image details" onClose={vi.fn()} open storageKey="test">
          <InspectorSection id="details" title="Details"><p>Name field</p></InspectorSection>
        </Inspector>
      </div>,
    );
    fireEvent.keyDown(screen.getByRole("heading", { name: "Sunset over Newark" }), { key: "Escape" });
    expect(outer).not.toHaveBeenCalled();
  });

  it.each([1280])("never returns focus for a closed Inspector in StrictMode at %i", (width) => {
    setViewport(width);
    const fallback = vi.fn();
    const { unmount } = render(
      <StrictMode>
        <Inspector heading="Closed details" label="Closed details" onClose={vi.fn()} onFocusFallback={fallback} open={false} storageKey="test">
          <p>Closed content</p>
        </Inspector>
      </StrictMode>,
    );
    expect(fallback).not.toHaveBeenCalled();
    unmount();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("restores focus once when an open Inspector closes then unmounts", () => {
    setViewport(1280);
    const fallback = vi.fn();
    const props = { heading: "Details", label: "Details", onClose: vi.fn(), onFocusFallback: fallback, focusReturn: null, storageKey: "test" };
    const { rerender, unmount } = render(<StrictMode><Inspector {...props} open><p>Content</p></Inspector></StrictMode>);
    fallback.mockClear();
    rerender(<StrictMode><Inspector {...props} open={false}><p>Content</p></Inspector></StrictMode>);
    expect(fallback).toHaveBeenCalledTimes(1);
    unmount();
    expect(fallback).toHaveBeenCalledTimes(1);
  });

});
