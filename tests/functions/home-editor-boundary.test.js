import { expect, it } from "vitest";
import boundary from "../../functions/lib/home-editor-boundary.js";

const { HOME_EDITOR_BOUNDARY_ERROR, homeEditorBoundaryError } = boundary;

const heading = (text = "Stored") => ({
  id: "heading",
  type: "headline",
  order: 0,
  visible: true,
  data: { text },
});
const shelf = (title = "Shelf") => ({
  id: "shelf",
  type: "promotion_playlist",
  order: 1,
  visible: false,
  data: { title, placement: "before_featured", cards: [] },
});

it("preserves ignored Home blocks across add, remove and reorder while leaving other Pages editable", () => {
  const storedBlocks = [heading(), shelf()];
  for (const nextBlocks of [[shelf()], [heading(), { ...heading(), id: "second" }, shelf()]]) {
    expect(homeEditorBoundaryError({ collection: "cmsPages", documentId: "home", storedBlocks, nextBlocks }))
      .toBe(HOME_EDITOR_BOUNDARY_ERROR);
  }
  const divider = { id: "divider", type: "divider", order: 2, visible: true, data: {} };
  expect(homeEditorBoundaryError({ collection: "cmsPages", documentId: "home",
    storedBlocks: [heading(), shelf(), divider], nextBlocks: [divider, shelf(), heading()] })).toBe(HOME_EDITOR_BOUNDARY_ERROR);
  expect(homeEditorBoundaryError({ collection: "cmsPages", documentId: "about",
    storedBlocks: [heading()], nextBlocks: [heading("Changed")] })).toBeNull();
});
