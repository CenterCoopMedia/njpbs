import { afterEach, describe, expect, it } from "vitest";
import { mediaGridKeyAction, type MediaGridPosition } from "../src/lib/media-grid-keys";

// Ten items in rows of four: 0 1 2 3 / 4 5 6 7 / 8 9. Two rows fit on one screen.
const grid = (index: number, overrides: Partial<MediaGridPosition> = {}): MediaGridPosition => ({
  index, columns: 4, count: 10, rowsPerScreen: 2, ...overrides,
});

function key(value: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "target", { value: target });
  return event;
}

afterEach(() => { document.body.innerHTML = ""; });

describe("media grid keys", () => {
  it("moves with the arrows and wraps across rows", () => {
    expect(mediaGridKeyAction(key("ArrowRight"), grid(1))).toEqual({ type: "move", index: 2 });
    expect(mediaGridKeyAction(key("ArrowRight"), grid(3))).toEqual({ type: "move", index: 4 });
    expect(mediaGridKeyAction(key("ArrowLeft"), grid(4))).toEqual({ type: "move", index: 3 });
    expect(mediaGridKeyAction(key("ArrowDown"), grid(1))).toEqual({ type: "move", index: 5 });
    expect(mediaGridKeyAction(key("ArrowUp"), grid(5))).toEqual({ type: "move", index: 1 });
    // The ends stay put rather than wrapping around the whole grid.
    expect(mediaGridKeyAction(key("ArrowLeft"), grid(0))).toEqual({ type: "move", index: 0 });
    expect(mediaGridKeyAction(key("ArrowRight"), grid(9))).toEqual({ type: "move", index: 9 });
    expect(mediaGridKeyAction(key("ArrowUp"), grid(2))).toEqual({ type: "move", index: 2 });
    // Down into a short last row lands on its last item; down from the last row stays.
    expect(mediaGridKeyAction(key("ArrowDown"), grid(7))).toEqual({ type: "move", index: 9 });
    expect(mediaGridKeyAction(key("ArrowDown"), grid(8))).toEqual({ type: "move", index: 8 });
  });

  it("goes to the row ends with Home and End and to the first and last item with Ctrl or Cmd", () => {
    expect(mediaGridKeyAction(key("Home"), grid(6))).toEqual({ type: "move", index: 4 });
    expect(mediaGridKeyAction(key("End"), grid(5))).toEqual({ type: "move", index: 7 });
    expect(mediaGridKeyAction(key("End"), grid(8))).toEqual({ type: "move", index: 9 });
    expect(mediaGridKeyAction(key("Home", { ctrlKey: true }), grid(6))).toEqual({ type: "move", index: 0 });
    expect(mediaGridKeyAction(key("End", { metaKey: true }), grid(2))).toEqual({ type: "move", index: 9 });
  });

  it("moves one screen of rows with PageUp and PageDown and keeps the column", () => {
    expect(mediaGridKeyAction(key("PageDown"), grid(1))).toEqual({ type: "move", index: 9 });
    expect(mediaGridKeyAction(key("PageDown"), grid(0, { count: 20 }))).toEqual({ type: "move", index: 8 });
    expect(mediaGridKeyAction(key("PageDown"), grid(6))).toEqual({ type: "move", index: 9 });
    expect(mediaGridKeyAction(key("PageUp"), grid(9))).toEqual({ type: "move", index: 1 });
    expect(mediaGridKeyAction(key("PageUp"), grid(6))).toEqual({ type: "move", index: 2 });
  });

  it("toggles with Space, extends with Shift+Arrow and opens with Enter", () => {
    expect(mediaGridKeyAction(key(" "), grid(3))).toEqual({ type: "toggle", index: 3 });
    expect(mediaGridKeyAction(key("ArrowRight", { shiftKey: true }), grid(3))).toEqual({ type: "extend", index: 4 });
    expect(mediaGridKeyAction(key("ArrowDown", { shiftKey: true }), grid(1))).toEqual({ type: "extend", index: 5 });
    expect(mediaGridKeyAction(key("Enter"), grid(2))).toEqual({ type: "open", index: 2 });
  });

  it("selects the page with Cmd or Ctrl+A", () => {
    expect(mediaGridKeyAction(key("a", { metaKey: true }), grid(0))).toEqual({ type: "select-page" });
    expect(mediaGridKeyAction(key("A", { ctrlKey: true }), grid(0))).toEqual({ type: "select-page" });
    expect(mediaGridKeyAction(key("a"), grid(0))).toEqual({ type: "none" });
    expect(mediaGridKeyAction(key("a", { ctrlKey: true, shiftKey: true }), grid(0))).toEqual({ type: "none" });
  });

  it("opens Quick Look with Cmd or Ctrl+Y and not from a text field", () => {
    expect(mediaGridKeyAction(key("y", { metaKey: true }), grid(2))).toEqual({ type: "quick-look", index: 2 });
    expect(mediaGridKeyAction(key("Y", { ctrlKey: true }), grid(4))).toEqual({ type: "quick-look", index: 4 });
    expect(mediaGridKeyAction(key("y"), grid(2))).toEqual({ type: "none" });
    expect(mediaGridKeyAction(key("y", { ctrlKey: true, shiftKey: true }), grid(2))).toEqual({ type: "none" });

    const input = document.createElement("input");
    document.body.append(input);
    expect(mediaGridKeyAction(key("y", { ctrlKey: true }, input), grid(2))).toEqual({ type: "none" });
  });

  it("opens the context menu with Shift+F10 and the Menu key", () => {
    expect(mediaGridKeyAction(key("F10", { shiftKey: true }), grid(4))).toEqual({ type: "context-menu", index: 4 });
    expect(mediaGridKeyAction(key("ContextMenu"), grid(4))).toEqual({ type: "context-menu", index: 4 });
    expect(mediaGridKeyAction(key("F10"), grid(4))).toEqual({ type: "none" });
  });

  it("returns escape for Escape and none for other keys or an empty grid", () => {
    expect(mediaGridKeyAction(key("Escape"), grid(4))).toEqual({ type: "escape" });
    expect(mediaGridKeyAction(key("x"), grid(4))).toEqual({ type: "none" });
    expect(mediaGridKeyAction(key("ArrowRight"), grid(0, { count: 0 }))).toEqual({ type: "none" });
    expect(mediaGridKeyAction(key("ArrowRight", { altKey: true }), grid(0))).toEqual({ type: "none" });
  });

  it("does nothing from a text field, a prevented event or while a modal is open", () => {
    for (const tag of ["input", "textarea", "select"]) {
      const field = document.createElement(tag);
      document.body.append(field);
      for (const value of ["ArrowRight", " ", "Enter", "Escape", "a", "y"]) {
        expect(mediaGridKeyAction(key(value, { ctrlKey: value === "a" || value === "y" }, field), grid(1))).toEqual({ type: "none" });
      }
    }
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const inner = document.createElement("span");
    editable.append(inner);
    document.body.append(editable);
    expect(mediaGridKeyAction(key("ArrowRight", {}, inner), grid(1))).toEqual({ type: "none" });

    const prevented = key("ArrowRight");
    prevented.preventDefault();
    expect(mediaGridKeyAction(prevented, grid(1))).toEqual({ type: "none" });

    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.append(modal);
    expect(mediaGridKeyAction(key("ArrowRight"), grid(1))).toEqual({ type: "none" });
    expect(mediaGridKeyAction(key("y", { metaKey: true }), grid(1))).toEqual({ type: "none" });
    modal.remove();
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    expect(mediaGridKeyAction(key("Escape"), grid(1))).toEqual({ type: "none" });
  });

  it("leaves Space and Enter to a focused checkbox or button inside a card but still moves with the arrows", () => {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    const button = document.createElement("button");
    document.body.append(checkbox, button);
    for (const target of [checkbox, button]) {
      expect(mediaGridKeyAction(key(" ", {}, target), grid(1))).toEqual({ type: "none" });
      expect(mediaGridKeyAction(key("Enter", {}, target), grid(1))).toEqual({ type: "none" });
      expect(mediaGridKeyAction(key("ArrowRight", {}, target), grid(1))).toEqual({ type: "move", index: 2 });
    }
  });
});
