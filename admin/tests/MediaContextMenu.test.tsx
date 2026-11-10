import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaContextMenu, type MediaContextMenuProps } from "../src/components/media/MediaContextMenu";
import { MediaTile } from "../src/components/media/MediaTile";
import { DEFAULT_MEDIA_DISPLAY } from "../src/lib/media-display";
import { categoryLabel, imageAsset, videoAsset } from "./media-tile-fixtures";

// The mirror spec: every way to open a card's menu lists the same items.

afterEach(() => {
  vi.unstubAllGlobals();
});

const asset = imageAsset();

function menu(overrides: Partial<MediaContextMenuProps> & { selected?: boolean; selectionMode?: boolean } = {}) {
  const { selected = false, selectionMode = false, ...rest } = overrides;
  const props: MediaContextMenuProps = {
    tile: { surface: "images", name: asset.name, favorite: false, available: true, selected, canDelete: true, copyFileAddress: true },
    selectionCount: selected ? 1 : 0,
    onAction: vi.fn(),
    onSelectionAction: vi.fn(),
    children: null,
    ...rest,
  };
  const tile = (
    <MediaTile
      asset={asset}
      available={props.tile.available}
      canDelete={props.tile.canDelete}
      categoryLabel={categoryLabel}
      favorite={props.tile.favorite}
      fields={DEFAULT_MEDIA_DISPLAY.fields}
      onAction={props.onAction}
      onOpen={() => {}}
      onSelectChange={() => {}}
      selected={selected}
      selectionMode={selectionMode}
      surface="images"
    />
  );
  return { props, ...render(<MediaContextMenu {...props}>{tile}</MediaContextMenu>) };
}

const labels = () => screen.getAllByRole("menuitem").map((item) => item.textContent);
const openControl = () => screen.getByRole("button", { name: /^Sunset over Newark, image/ });

describe("MediaContextMenu", () => {
  it("offers only Open details, or only Clear selection on a selection, while actions are disabled", () => {
    const { container, unmount } = menu({ actionsDisabled: true });
    fireEvent.contextMenu(container.querySelector(".media-tile-thumb") as HTMLElement);
    expect(labels()).toEqual(["Open details"]);
    unmount();
    const selected = menu({ actionsDisabled: true, selected: true, selectionMode: true, selectionCount: 3 });
    fireEvent.contextMenu(selected.container.querySelector(".media-tile-thumb") as HTMLElement);
    expect(labels()).toEqual(["Clear selection"]);
  });

  it("right-click, Shift+F10 and More open the same items", () => {
    const { container } = menu();
    fireEvent.click(screen.getByRole("button", { name: "More actions: Sunset over Newark" }));
    const fromMore = labels();
    expect(fromMore).toEqual([
      "Open details", "Add to favorites", "Add to collection", "Select", "Copy link", "Copy file address", "Delete from library",
    ]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    fireEvent.contextMenu(container.querySelector(".media-tile-thumb") as HTMLElement, { clientX: 40, clientY: 60 });
    expect(screen.getByRole("menu", { name: "Sunset over Newark" })).toBeInTheDocument();
    expect(labels()).toEqual(fromMore);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    openControl().focus();
    fireEvent.keyDown(openControl(), { key: "F10", shiftKey: true });
    expect(labels()).toEqual(fromMore);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    fireEvent.keyDown(openControl(), { key: "ContextMenu" });
    expect(labels()).toEqual(fromMore);
  });

  it("hidden items are absent, not dimmed", () => {
    const { container } = menu({
      tile: { surface: "images", name: asset.name, favorite: false, available: false, selected: false, canDelete: false },
    });
    fireEvent.contextMenu(container.querySelector(".media-tile-thumb") as HTMLElement);
    expect(labels()).toEqual(["Open details", "Add to collection", "Select", "Copy link"]);
    expect(screen.queryByRole("menuitem", { name: "Delete from library" })).toBeNull();
    expect(screen.getByRole("menu").querySelector("[aria-disabled], [disabled]")).toBeNull();
  });

  it("leaves Favorite out while the favorite state loads or saves", () => {
    const { container } = menu({ favoriteSettled: false });
    fireEvent.contextMenu(container.querySelector(".media-tile-thumb") as HTMLElement);
    expect(labels()).toEqual(["Open details", "Add to collection", "Select", "Copy link", "Copy file address", "Delete from library"]);
  });

  it("Delete is last in danger ink", () => {
    const { container } = menu();
    fireEvent.contextMenu(container.querySelector(".media-tile-thumb") as HTMLElement);
    const items = screen.getAllByRole("menuitem");
    expect(items.at(-1)).toHaveTextContent("Delete from library");
    expect(items.at(-1)).toHaveClass("ui-menu-item-danger");
    expect(items.slice(0, -1).some((item) => item.classList.contains("ui-menu-item-danger"))).toBe(false);
  });

  it("opening the menu makes no request", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { container, props } = menu();
    fireEvent.contextMenu(container.querySelector(".media-tile-thumb") as HTMLElement);
    expect(fetch).not.toHaveBeenCalled();
    expect(props.onAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("menuitem", { name: "Add to collection" }));
    expect(props.onAction).toHaveBeenCalledWith("collect");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("Escape returns focus to the tile", () => {
    const { container } = menu();
    fireEvent.contextMenu(container.querySelector(".media-tile-thumb") as HTMLElement);
    expect(screen.getByRole("menuitem", { name: "Open details" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(openControl()).toHaveFocus();
  });

  it("a multi-selection is titled N items and offers batch favorites for images", () => {
    const { container, props } = menu({ selected: true, selectionMode: true, selectionCount: 5 });
    fireEvent.contextMenu(container.querySelector(".media-tile-thumb") as HTMLElement);
    const surface = screen.getByRole("menu", { name: "5 items" });
    expect(surface.querySelector(".ui-menu-title")).toHaveTextContent("5 items");
    expect(labels()).toEqual(["Add to favorites", "Remove from favorites", "Add to collection", "Clear selection"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear selection" }));
    expect(props.onSelectionAction).toHaveBeenCalledWith("clear-selection");
    expect(props.onAction).not.toHaveBeenCalled();
  });

  it("uses the caller's selection actions when a heart save should hide batch favorites", () => {
    const { container } = menu({
      selected: true,
      selectionMode: true,
      selectionCount: 5,
      selectionActions: [
        { id: "clear-selection", label: "Clear selection", icon: "close", group: "organize", hidden: false },
      ],
    });
    fireEvent.contextMenu(container.querySelector(".media-tile-thumb") as HTMLElement);
    expect(labels()).toEqual(["Clear selection"]);
  });

  it("past the collection cap the multi-selection menu hides Add to collection", () => {
    const { container } = menu({
      tile: { surface: "video", name: "Studio B walkthrough", favorite: false, available: true, selected: true, canDelete: true, uploader: videoAsset().uploadedBy },
      selected: true,
      selectionMode: true,
      selectionCount: 31,
      canEditSelection: true,
    });
    fireEvent.contextMenu(container.querySelector(".media-tile-thumb") as HTMLElement);
    expect(screen.getByRole("menu", { name: "31 items" })).toBeInTheDocument();
    expect(labels()).toEqual(["Add to favorites", "Remove from favorites", "Edit selected", "Clear selection"]);
  });
});
