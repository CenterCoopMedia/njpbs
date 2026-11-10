import { describe, expect, it } from "vitest";
import {
  mediaBarActions,
  mediaClusterActions,
  mediaCollectionSelectionActions,
  mediaCollectionTileActions,
  mediaFavoriteSelectionActions,
  mediaFavoriteTileActions,
  mediaMenuItems,
  mediaMenuTitle,
  mediaSelectionActions,
  mediaTileActions,
  lockedMenuActions,
  settledMenuActions,
  type MediaTileActionInput,
} from "../src/lib/media-tile-actions";

const image = (overrides: Partial<MediaTileActionInput> = {}): MediaTileActionInput => ({
  surface: "images", name: "Sunset over Newark", favorite: false, available: true,
  selected: false, canDelete: true, ...overrides,
});
const video = (overrides: Partial<MediaTileActionInput> = {}): MediaTileActionInput => ({
  surface: "video", name: "Studio B walkthrough", favorite: false, available: true,
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

  it("images, one item: Open details, Add to favorites or Remove from favorites, Add to collection, Select or Deselect, Copy link, Delete from library last in danger", () => {
    expect(labels(image())).toEqual([
      "Open details", "Add to favorites", "Add to collection", "Select", "Copy link", "Delete from library",
    ]);
    expect(labels(image({ favorite: true, selected: true }))).toEqual([
      "Open details", "Remove from favorites", "Add to collection", "Deselect", "Copy link", "Delete from library",
    ]);
    const actions = visible(image());
    expect(actions.at(-1)).toMatchObject({ id: "delete", danger: true, group: "danger" });
    expect(actions.filter((action) => action.danger)).toHaveLength(1);
  });

  it("hides Delete without canManageMediaMetadata and hides favorites for an unavailable item", () => {
    expect(labels(image({ canDelete: false }))).not.toContain("Delete from library");
    expect(mediaTileActions(image({ canDelete: false })).find((action) => action.id === "delete")?.hidden).toBe(true);
    expect(labels(image({ available: false }))).toEqual([
      "Open details", "Add to collection", "Select", "Copy link", "Delete from library",
    ]);
  });

  it("video: Open and play, favorites, Add to collection, Select, Show videos uploaded by NAME only with an uploader uid, Delete only with canDelete, no Copy link", () => {
    expect(labels(video())).toEqual([
      "Open and play", "Add to favorites", "Add to collection", "Select", "Show videos uploaded by Pat Lee", "Delete from library",
    ]);
    expect(labels(video({ uploader: { name: "Pat Lee" } }))).not.toContain("Show videos uploaded by Pat Lee");
    expect(labels(video({ uploader: null }))).toEqual([
      "Open and play", "Add to favorites", "Add to collection", "Select", "Delete from library",
    ]);
    expect(labels(video({ canDelete: false }))).not.toContain("Delete from library");
    expect(labels(video())).not.toContain("Copy link");
  });

  it("gives an available Favorite open, Quick Look, removal, collection and selection actions", () => {
    expect(mediaFavoriteTileActions({ available: true, selected: false, video: false }))
      .toMatchObject([
        { id: "open", label: "Open details", hidden: false },
        { id: "quick-look", label: "Quick Look", hidden: false },
        { id: "favorite", label: "Remove from favorites", hidden: false },
        { id: "collect", label: "Add to collection", hidden: false },
        { id: "select", label: "Select", hidden: false },
      ]);
    expect(mediaFavoriteTileActions({ available: true, selected: true, video: true }))
      .toMatchObject([
        { id: "open", label: "Open and play" },
        { id: "quick-look" },
        { id: "favorite" },
        { id: "collect" },
        { id: "select", label: "Deselect" },
      ]);
  });

  it("gives an unavailable Favorite removal and selection only, without an add-back action", () => {
    const actions = mediaFavoriteTileActions({ available: false, selected: false, video: true });
    expect(actions.map(action => [action.id, action.label])).toEqual([
      ["favorite-remove", "Remove from favorites"],
      ["select", "Select"],
    ]);
    expect(actions.map(action => action.id)).not.toContain("favorite");
    expect(actions.map(action => action.id)).not.toContain("collect");
    expect(actions.map(action => action.id)).not.toContain("open");
  });

  it("gives available collection items open, Quick Look, removal and selection only", () => {
    expect(mediaCollectionTileActions({ available: true, selected: false, video: false }))
      .toMatchObject([
        { id: "open", label: "Open details", hidden: false },
        { id: "quick-look", label: "Quick Look", hidden: false },
        { id: "remove-collection", label: "Remove from collection", hidden: false },
        { id: "select", label: "Select", hidden: false },
      ]);
    const videoActions = mediaCollectionTileActions({ available: true, selected: true, video: true });
    expect(videoActions).toMatchObject([
      { id: "open", label: "Open and play" },
      { id: "quick-look" },
      { id: "remove-collection" },
      { id: "select", label: "Deselect" },
    ]);
    expect(videoActions.map(action => action.id)).not.toContain("collect");
    expect(videoActions.map(action => action.id)).not.toContain("delete");
  });

  it("gives unavailable collection items removal and selection without open or preview", () => {
    const actions = mediaCollectionTileActions({ available: false, selected: false, video: true });
    expect(actions.map(action => [action.id, action.label])).toEqual([
      ["remove-collection", "Remove from collection"],
      ["select", "Select"],
    ]);
    expect(actions.map(action => action.id)).not.toContain("open");
    expect(actions.map(action => action.id)).not.toContain("quick-look");
    expect(actions.map(action => action.id)).not.toContain("collect");
    expect(actions.map(action => action.id)).not.toContain("delete");
  });

  it("every cluster and bar action appears in the menu", () => {
    for (const input of [image(), image({ favorite: true }), video(), video({ available: false })]) {
      const menu = visible(input).map((action) => action.id);
      const cluster = mediaClusterActions(mediaTileActions(input));
      expect(cluster.length).toBeGreaterThan(0);
      for (const action of cluster) expect(menu).toContain(action.id);
      // The cluster is the heart and the folder, each with its always-icon registry id.
      expect(cluster.every((action) => action.registryId === "media-favorite" || action.registryId === "media-collect")).toBe(true);
    }
    for (const [surface, canEdit] of [["images", false], ["video", true], ["video", false]] as const) {
      const menu = mediaSelectionActions({ surface, count: 12, canEdit });
      const shown = menu.filter((action) => !action.hidden).map((action) => action.id);
      for (const action of mediaBarActions(menu)) expect(shown).toContain(action.id);
    }
  });

  it("a multi-selection menu is titled N items", () => {
    expect(mediaMenuTitle(12, "Sunset over Newark")).toBe("12 items");
    expect(mediaMenuTitle(1, "Sunset over Newark")).toBe("Sunset over Newark");
  });

  it("offers image and video batch favorites and keeps the existing collection and edit caps", () => {
    const images = mediaSelectionActions({ surface: "images", count: 12, canEdit: false });
    expect(images.filter((action) => !action.hidden).map((action) => action.label)).toEqual(["Add to favorites", "Remove from favorites", "Add to collection", "Clear selection"]);
    const videos = mediaSelectionActions({ surface: "video", count: 12, canEdit: true });
    expect(videos.filter((action) => !action.hidden).map((action) => action.label)).toEqual(["Add to favorites", "Remove from favorites", "Add to collection", "Edit selected", "Clear selection"]);
    expect(videos.filter((action) => action.id.startsWith("favorite"))).toHaveLength(2);
    expect(mediaSelectionActions({ surface: "video", count: 12, canEdit: false }).find((action) => action.id === "edit-selected")?.hidden).toBe(true);
    // Over the collection limit the menu hides Add to collection; the bar shows it disabled with the reason.
    const over = mediaSelectionActions({ surface: "images", count: 31, canEdit: false });
    const collect = over.find((action) => action.id === "collect");
    expect(collect).toMatchObject({ hidden: true, disabledReason: "Select no more than 30 items for one collection change." });
    expect(mediaBarActions(over).map((action) => action.id)).toContain("collect");
    const overBulk = mediaSelectionActions({ surface: "images", count: 101, canEdit: true });
    expect(overBulk.find((action) => action.id === "edit-tags")).toMatchObject({
      hidden: true,
      disabledReason: "Select no more than 100 items in one batch.",
    });
    expect(mediaMenuItems(overBulk, () => {}).find((item) => item.key === "edit-tags")?.hidden).toBe(true);
  });

  it("includes batch favorites only for image selections of 1 through 100, in both menu and bar", () => {
    for (const count of [0, 1, 100, 101]) {
      const actions = mediaSelectionActions({ surface: "images", count, canEdit: true });
      const expected = count >= 1 && count <= 100 ? ["favorite-add", "favorite-remove"] : [];
      for (const items of [actions, mediaBarActions(actions)]) {
        const favorites = items.filter(action => action.id.startsWith("favorite"));
        expect(favorites.map(action => action.id)).toEqual(expected);
        for (const action of favorites) {
          expect(action.hidden).toBe(false);
          expect(action.disabledReason).toBeUndefined();
        }
      }
    }
  });

  it("offers bounded Favorites selection removal, collection and clear actions", () => {
    const available = mediaFavoriteSelectionActions({ count: 30, allAvailable: true });
    expect(available.filter(action => !action.hidden).map(action => action.id)).toEqual([
      "favorite-remove", "collect", "clear-selection",
    ]);

    const unavailable = mediaFavoriteSelectionActions({ count: 2, allAvailable: false });
    expect(unavailable.find(action => action.id === "collect")).toMatchObject({
      hidden: true,
      disabledReason: "Unavailable favorites cannot be added to a collection.",
    });
    expect(unavailable.find(action => action.id === "favorite-remove")?.hidden).toBe(false);
    expect(mediaBarActions(unavailable).map(action => action.id)).toEqual([
      "favorite-remove", "collect", "clear-selection",
    ]);
  });

  it("keeps Favorites cap messages in the selection bar while hiding capped menu actions", () => {
    expect(mediaFavoriteSelectionActions({ count: 100, allAvailable: true })
      .find(action => action.id === "favorite-remove")?.hidden).toBe(false);

    const overCollectionCap = mediaFavoriteSelectionActions({ count: 31, allAvailable: true });
    expect(overCollectionCap.find(action => action.id === "collect")).toMatchObject({
      hidden: true,
      disabledReason: "Select no more than 30 items for one collection change.",
    });
    expect(overCollectionCap.find(action => action.id === "favorite-remove")?.hidden).toBe(false);

    const overFavoriteCap = mediaFavoriteSelectionActions({ count: 101, allAvailable: true });
    expect(overFavoriteCap.find(action => action.id === "favorite-remove")).toMatchObject({
      hidden: true,
      disabledReason: "Select no more than 100 favorites in one batch.",
    });
    expect(mediaBarActions(overFavoriteCap).map(action => action.id)).toEqual([
      "favorite-remove", "collect", "clear-selection",
    ]);

    const empty = mediaFavoriteSelectionActions({ count: 0, allAvailable: true });
    expect(mediaBarActions(empty).map(action => action.id)).toEqual(["clear-selection"]);
  });

  it("offers one bounded collection removal and clear action without add or delete", () => {
    const bounded = mediaCollectionSelectionActions(30);
    expect(bounded.filter(action => !action.hidden).map(action => action.id)).toEqual([
      "remove-collection", "clear-selection",
    ]);
    expect(bounded.map(action => action.id)).not.toContain("collect");
    expect(bounded.map(action => action.id)).not.toContain("delete");

    const over = mediaCollectionSelectionActions(31);
    expect(over.find(action => action.id === "remove-collection")).toMatchObject({
      hidden: true,
      disabledReason: "Select no more than 30 items for one collection change.",
    });
    expect(mediaBarActions(over).map(action => action.id)).toEqual([
      "remove-collection", "clear-selection",
    ]);
    expect(mediaBarActions(mediaCollectionSelectionActions(0)).map(action => action.id))
      .toEqual(["clear-selection"]);
  });

  it("a menu leaves Favorite out until the favorite state is loaded and not saving", () => {
    const actions = mediaTileActions(image());
    expect(settledMenuActions(actions, true)).toBe(actions);
    expect(settledMenuActions(actions, false).map((action) => action.id)).toEqual([
      "open", "collect", "select", "copy-link", "delete",
    ]);
  });

  it("keeps only Open details while details or an upload hold unsaved work", () => {
    const actions = mediaTileActions(image());
    expect(lockedMenuActions(actions, false)).toBe(actions);
    expect(lockedMenuActions(actions, true).map((action) => action.id)).toEqual(["open"]);
  });

  it("images, one item: Open details, Quick Look, Open full size, then the phase 3 order", () => {
    expect(labels(image({ quickLook: true, openFullSize: true }))).toEqual([
      "Open details", "Quick Look", "Open full size", "Add to favorites", "Add to collection", "Select", "Copy link", "Delete from library",
    ]);
    expect(visible(image({ quickLook: true, openFullSize: true })).slice(1, 3)).toMatchObject([
      { id: "quick-look", group: "open" }, { id: "open-full-size", group: "open" },
    ]);
    // Video gains Quick Look after Open and play; Open full size is for images only.
    expect(labels(video({ quickLook: true, openFullSize: true }))).toEqual([
      "Open and play", "Quick Look", "Add to favorites", "Add to collection", "Select", "Show videos uploaded by Pat Lee", "Delete from library",
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
    expect(shown(true)).toEqual(["Add to favorites", "Remove from favorites", "Add to collection", "Edit tags", "Clear selection"]);
    expect(shown(false)).toEqual(["Add to favorites", "Remove from favorites", "Add to collection", "Clear selection"]);
    // Video keeps Edit selected and never offers Edit tags.
    expect(mediaSelectionActions({ surface: "video", count: 4, canEdit: true }).filter((action) => !action.hidden).map((action) => action.label))
      .toEqual(["Add to favorites", "Remove from favorites", "Add to collection", "Edit selected", "Clear selection"]);
  });

  it("builds Menu items that call back with the action id and keep hidden flags", () => {
    const chosen: string[] = [];
    const items = mediaMenuItems(mediaTileActions(image({ canDelete: false })), (id) => chosen.push(id));
    expect(items.map((entry) => [entry.key, entry.hidden ?? false])).toEqual([
      ["open", false], ["favorite", false], ["collect", false], ["select", false], ["copy-link", false], ["delete", true],
    ]);
    items[2].onSelect();
    expect(chosen).toEqual(["collect"]);
    expect(items[5]).toMatchObject({ danger: true, icon: "trash", group: "danger" });
  });
});
