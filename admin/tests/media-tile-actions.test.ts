import { describe, expect, it } from "vitest";
import {
  mediaBarActions,
  mediaMenuItems,
  mediaMenuTitle,
  mediaSelectionActions,
  mediaTileActions,
  lockedMenuActions,
  type MediaTileActionInput,
} from "../src/lib/media-tile-actions";

const image = (overrides: Partial<MediaTileActionInput> = {}): MediaTileActionInput => ({
  surface: "images", name: "Sunset over Newark",
  selected: false, canDelete: true, ...overrides,
});
const video = (overrides: Partial<MediaTileActionInput> = {}): MediaTileActionInput => ({
  surface: "video", name: "Studio B walkthrough",
  selected: false, canDelete: true, uploader: { uid: "u1", name: "Pat Lee" }, ...overrides,
});
const visible = (input: MediaTileActionInput) => mediaTileActions(input).filter((action) => !action.hidden);
const labels = (input: MediaTileActionInput) => visible(input).map((action) => action.label);

describe("media tile actions", () => {
  it("offers a separate file address only for images with a public address", () => {
    expect(labels(image({ copyFileAddress: true }))).toContain("Copy file address");
    expect(labels(image())).not.toContain("Copy file address");
    expect(labels(video({ copyFileAddress: true }))).not.toContain("Copy file address");
  });

  it("images, one item: Open details, Select or Deselect, Copy link, Delete from library last in danger", () => {
    expect(labels(image())).toEqual([
      "Open details", "Select", "Copy link", "Delete from library",
    ]);
    expect(labels(image({ selected: true }))).toEqual([
      "Open details", "Deselect", "Copy link", "Delete from library",
    ]);
    const actions = visible(image());
    expect(actions.at(-1)).toMatchObject({ id: "delete", danger: true, group: "danger" });
    expect(actions.filter((action) => action.danger)).toHaveLength(1);
  });

  it("hides Delete without canManageMediaMetadata", () => {
    expect(labels(image({ canDelete: false }))).not.toContain("Delete from library");
    expect(mediaTileActions(image({ canDelete: false })).find((action) => action.id === "delete")?.hidden).toBe(true);
  });

  it("video: Open and play, Select, Show videos uploaded by NAME only with an uploader uid, Delete only with canDelete, no Copy link", () => {
    expect(labels(video())).toEqual([
      "Open and play", "Select", "Show videos uploaded by Pat Lee", "Delete from library",
    ]);
    expect(labels(video({ uploader: { name: "Pat Lee" } }))).not.toContain("Show videos uploaded by Pat Lee");
    expect(labels(video({ uploader: null }))).toEqual([
      "Open and play", "Select", "Delete from library",
    ]);
    expect(labels(video({ canDelete: false }))).not.toContain("Delete from library");
    expect(labels(video())).not.toContain("Copy link");
  });

  it("every bar action appears in the menu", () => {
    for (const [surface, canEdit] of [["images", true], ["images", false], ["video", true], ["video", false]] as const) {
      const menu = mediaSelectionActions({ surface, count: 12, canEdit });
      const shown = menu.filter((action) => !action.hidden).map((action) => action.id);
      for (const action of mediaBarActions(menu)) expect(shown).toContain(action.id);
    }
  });

  it("a multi-selection menu is titled N items", () => {
    expect(mediaMenuTitle(12, "Sunset over Newark")).toBe("12 items");
    expect(mediaMenuTitle(1, "Sunset over Newark")).toBe("Sunset over Newark");
  });

  it("keeps the edit caps for image and video selections", () => {
    const images = mediaSelectionActions({ surface: "images", count: 12, canEdit: false });
    expect(images.filter((action) => !action.hidden).map((action) => action.label)).toEqual(["Clear selection"]);
    const videos = mediaSelectionActions({ surface: "video", count: 12, canEdit: true });
    expect(videos.filter((action) => !action.hidden).map((action) => action.label)).toEqual(["Edit selected", "Clear selection"]);
    expect(mediaSelectionActions({ surface: "video", count: 12, canEdit: false }).find((action) => action.id === "edit-selected")?.hidden).toBe(true);
    // Over the bulk limit the menu hides Edit tags; the bar shows it disabled with the reason.
    const overBulk = mediaSelectionActions({ surface: "images", count: 101, canEdit: true });
    expect(overBulk.find((action) => action.id === "edit-tags")).toMatchObject({
      hidden: true,
      disabledReason: "Select no more than 100 items in one batch.",
    });
    expect(mediaBarActions(overBulk).map((action) => action.id)).toContain("edit-tags");
    expect(mediaMenuItems(overBulk, () => {}).find((item) => item.key === "edit-tags")?.hidden).toBe(true);
  });

  it("keeps only Open details while details or an upload hold unsaved work", () => {
    const actions = mediaTileActions(image());
    expect(lockedMenuActions(actions, false)).toBe(actions);
    expect(lockedMenuActions(actions, true).map((action) => action.id)).toEqual(["open"]);
  });

  it("images, one item: Open details, Quick Look, Open full size, then the rest in order", () => {
    expect(labels(image({ quickLook: true, openFullSize: true }))).toEqual([
      "Open details", "Quick Look", "Open full size", "Select", "Copy link", "Delete from library",
    ]);
    expect(visible(image({ quickLook: true, openFullSize: true })).slice(1, 3)).toMatchObject([
      { id: "quick-look", group: "open" }, { id: "open-full-size", group: "open" },
    ]);
    // Video gains Quick Look after Open and play; Open full size is for images only.
    expect(labels(video({ quickLook: true, openFullSize: true }))).toEqual([
      "Open and play", "Quick Look", "Select", "Show videos uploaded by Pat Lee", "Delete from library",
    ]);
    // A surface that has not wired them yet shows neither, so no menu item leads nowhere.
    expect(mediaTileActions(image()).map((action) => action.id)).not.toContain("quick-look");
    expect(mediaTileActions(image()).map((action) => action.id)).not.toContain("open-full-size");
    // Unsaved work keeps only Open details.
    expect(lockedMenuActions(mediaTileActions(image({ quickLook: true, openFullSize: true })), true).map((action) => action.id)).toEqual(["open"]);
  });

  it("the images selection offers Edit tags only when the role can edit", () => {
    const shown = (canEdit: boolean) => mediaSelectionActions({ surface: "images", count: 4, canEdit })
      .filter((action) => !action.hidden).map((action) => action.label);
    expect(shown(true)).toEqual(["Edit tags", "Clear selection"]);
    expect(shown(false)).toEqual(["Clear selection"]);
    // Video keeps Edit selected and never offers Edit tags.
    expect(mediaSelectionActions({ surface: "video", count: 4, canEdit: true }).filter((action) => !action.hidden).map((action) => action.label))
      .toEqual(["Edit selected", "Clear selection"]);
  });

  it("builds Menu items that call back with the action id and keep hidden flags", () => {
    const chosen: string[] = [];
    const items = mediaMenuItems(mediaTileActions(image({ canDelete: false })), (id) => chosen.push(id));
    expect(items.map((entry) => [entry.key, entry.hidden ?? false])).toEqual([
      ["open", false], ["select", false], ["copy-link", false], ["delete", true],
    ]);
    items[1].onSelect();
    expect(chosen).toEqual(["select"]);
    expect(items[3]).toMatchObject({ danger: true, icon: "trash", group: "danger" });
  });
});
