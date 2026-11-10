import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContextMenuArea, Menu, type MenuItem } from "../src/components/ui/Menu";

function items(onSelect = vi.fn()): MenuItem[] {
  return [
    { key: "open", label: "Open", onSelect },
    { key: "favorite", label: "Favorite", icon: "heart", onSelect },
    { key: "hidden", label: "Download original", hidden: true, onSelect },
    { key: "delete", label: "Delete from library", danger: true, group: "danger", onSelect },
  ];
}

describe("Menu", () => {
  it("keeps a prerequisite focusable and explained without activating or dismissing", () => {
    const select = vi.fn();
    render(<Menu label="Download" items={[
      { key: "avid", label: "Avid markers", disabledReason: "Choose a frame rate in export settings.", onSelect: select },
      { key: "settings", label: "Export settings", onSelect: select },
    ]} />);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    const unavailable = screen.getByRole("menuitem", { name: "Avid markers Choose a frame rate in export settings." });
    expect(unavailable).toHaveFocus();
    expect(unavailable).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(unavailable);
    expect(select).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(unavailable, { key: "ArrowDown" });
    const settings = screen.getByRole("menuitem", { name: "Export settings" });
    expect(settings).toHaveFocus();
    fireEvent.click(settings);
    expect(select).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download" })).toHaveFocus();
  });
  it("does not let the reduced-motion rule animate the menu's visibility, so the first item can take focus once placed", () => {
    // The global reduced-motion rule gives every property a 0.01ms transition. The menu is
    // hidden until placed, so a transitioned visibility is still hidden when focus moves in.
    const css = readFileSync(resolve(process.cwd(), "src/components/ui/Menu.css"), "utf8");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.ui-menu,\s*\.ui-menu \* \{\s*transition-property: none;/);
  });

  it("moves with wrapping arrows, Home and End", () => {
    render(<Menu items={items()} label="More actions" />);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    const menu = screen.getByRole("menu");

    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(screen.getByRole("menuitem", { name: "Delete from library" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Open" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "End" });
    expect(screen.getByRole("menuitem", { name: "Delete from library" })).toHaveFocus();
  });

  it("runs the chosen item, closes and returns focus to the trigger", () => {
    const onSelect = vi.fn();
    render(<Menu items={items(onSelect)} label="More actions" />);
    const trigger = screen.getByRole("button", { name: "More actions" });
    fireEvent.click(trigger);

    fireEvent.click(screen.getByRole("menuitem", { name: "Favorite" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("closes on Escape with focus back on the trigger", () => {
    render(<Menu items={items()} label="More actions" />);
    const trigger = screen.getByRole("button", { name: "More actions" });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("opens from the keyboard at the first or last item", () => {
    render(<Menu items={items()} label="More actions" />);
    fireEvent.keyDown(screen.getByRole("button", { name: "More actions" }), { key: "ArrowUp" });
    expect(screen.getByRole("menuitem", { name: "Delete from library" })).toHaveFocus();
  });
});

describe("Menu with nothing available", () => {
  it("does not open an empty menu", () => {
    const hiddenOnly: MenuItem[] = [{ key: "a", label: "Download original", hidden: true, onSelect: vi.fn() }];
    render(<Menu items={hiddenOnly} label="More actions" />);
    const trigger = screen.getByRole("button", { name: "More actions" });
    expect(trigger).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});

describe("ContextMenuArea", () => {
  it("leaves the browser menu alone when nothing is available", () => {
    render(
      <ContextMenuArea items={[{ key: "a", label: "Open", hidden: true, onSelect: vi.fn() }]} label="Item">
        <button type="button">Item</button>
      </ContextMenuArea>,
    );
    const notPrevented = fireEvent.contextMenu(screen.getByRole("button", { name: "Item" }));
    expect(notPrevented).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens the same actions on right-click, titled for the selection", () => {
    const onSelect = vi.fn();
    render(
      <ContextMenuArea items={items(onSelect)} label="12 items">
        <button type="button">Sunset over Newark</button>
      </ContextMenuArea>,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: "Sunset over Newark" }), {
      clientX: 200,
      clientY: 150,
    });
    expect(screen.getByRole("menu", { name: "12 items" })).toBeInTheDocument();
    expect(screen.getByText("12 items")).toHaveClass("ui-menu-title");
    expect(screen.getByRole("menu").style.left).toBe("200px");
    fireEvent.contextMenu(screen.getByRole("button", { name: "Sunset over Newark" }), {
      clientX: 400,
      clientY: 150,
    });
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(screen.getByRole("menu").style.left).toBe("400px");
    fireEvent.click(screen.getByRole("menuitem", { name: "Open" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("opens from the keyboard with Shift+F10 and returns focus on Escape", () => {
    render(
      <ContextMenuArea items={items()} label="Sunset over Newark">
        <button type="button">Sunset over Newark</button>
      </ContextMenuArea>,
    );
    const tile = screen.getByRole("button", { name: "Sunset over Newark" });
    tile.focus();
    fireEvent.keyDown(tile, { key: "F10", shiftKey: true });
    expect(screen.getByRole("menuitem", { name: "Open" })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(tile).toHaveFocus();
  });
});
