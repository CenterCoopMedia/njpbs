import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { BlockEditor } from "../src/components/BlockEditor";
import type { AdminBlock } from "../src/lib/block-factory";
import {
  GALLERY_PRESENTATIONS,
  GALLERY_PRESENTATION_SPECS,
} from "../../packages/content-core/src/content-model";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function counterIds() {
  let n = 0;
  return () => `b${++n}`;
}

function gallery(
  count: number,
  presentation?: "grid" | "carousel",
): AdminBlock {
  return {
    id: "g1",
    type: "image_gallery",
    order: 0,
    visible: true,
    data: {
      images: Array.from({ length: count }, (_, index) => ({
        assetId: `asset-${index + 1}`,
        alt: `Gallery image ${index + 1}`,
        altDecorative: false,
        caption: `Caption ${index + 1}`,
      })),
      ...(presentation ? { presentation } : {}),
    },
  };
}

function openGallerySettings() {
  fireEvent.click(screen.getByRole("button", { name: "Edit image gallery 1" }));
  return screen.getByRole("complementary", { name: "image gallery 1 settings" });
}

const spec = (value: string) =>
  GALLERY_PRESENTATION_SPECS.find((candidate) => candidate.value === value)!;

// A gallery now carries how it is presented publicly, chosen in the block's settings the way a
// heading's rank is (#1034). The choice is content, not a view preference: it is stored with the
// block and it is what the published page renders.
describe("choosing a gallery presentation (#1034)", () => {
  it("offers exactly the modes the public renderer has, and no others", () => {
    render(
      <BlockEditor section="home" initialBlocks={[gallery(3)]} newId={counterIds()} />,
    );
    const settings = openGallerySettings();
    const controls = within(settings).getAllByRole("radio") as HTMLInputElement[];
    expect(controls.map(option => option.value)).toEqual([
      ...GALLERY_PRESENTATIONS,
    ]);
  });

  it("shows a gallery stored before the choice existed as the grid it already renders as", () => {
    render(
      <BlockEditor section="home" initialBlocks={[gallery(3)]} newId={counterIds()} />,
    );
    const settings = openGallerySettings();
    expect(within(settings).getByRole("radio", { name: "Grid" })).toBeChecked();
  });

  it("stores the chosen mode with the block so the published page renders it", () => {
    const onSave = vi.fn();
    render(
      <BlockEditor
        section="home"
        initialBlocks={[gallery(2)]}
        newId={counterIds()}
        onSave={onSave}
      />,
    );
    const settings = openGallerySettings();
    fireEvent.click(within(settings).getByRole("radio", { name: "Carousel" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Save page" }));

    expect(onSave).toHaveBeenCalledWith([
      expect.objectContaining({
        data: expect.objectContaining({ presentation: "carousel" }),
      }),
    ]);
  });

  it("takes the choice back with the editor's own undo", () => {
    render(
      <BlockEditor
        section="home"
        initialBlocks={[gallery(2, "carousel")]}
        newId={counterIds()}
      />,
    );
    const settings = openGallerySettings();
    const control = within(settings).getByRole("radio", { name: "Grid" });
    fireEvent.click(control);
    expect(control).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    openGallerySettings();
    expect(screen.getByRole("radio", { name: "Carousel" })).toBeChecked();
  });
});

// The second half of the ask: an editor should not have to publish the page to learn what
// happens when a visitor clicks an image. Today the honest answer is "nothing", in both modes,
// and it is read from the same mode registry the renderer uses.
describe("explaining what the public page does (#1034)", () => {
  it("describes the selected mode's layout and its click result", () => {
    render(
      <BlockEditor section="home" initialBlocks={[gallery(3)]} newId={counterIds()} />,
    );
    const settings = openGallerySettings();
    const summary = within(settings).getByText("How this gallery behaves");
    const disclosure = summary.closest("details");
    expect(disclosure).not.toHaveAttribute("open");
    fireEvent.click(summary);
    expect(disclosure).toHaveAttribute("open");
    expect(within(settings).getByText(spec("grid").layout)).toBeTruthy();
    expect(within(settings).getByText(spec("grid").clickBehavior)).toBeTruthy();

    fireEvent.click(within(settings).getByRole("radio", { name: "Carousel" }));
    const updated = screen.getByRole("complementary", { name: "image gallery 1 settings" });
    expect(within(updated).getByText(spec("carousel").layout)).toBeTruthy();
    expect(within(updated).getByText(spec("carousel").clickBehavior)).toBeTruthy();
  });

  it("never promises a lightbox or a link, because the renderer emits neither", () => {
    for (const presentation of GALLERY_PRESENTATIONS) {
      cleanup();
      render(
        <BlockEditor
          section="home"
          initialBlocks={[gallery(2, presentation)]}
          newId={counterIds()}
        />,
      );
      const settings = openGallerySettings();
      expect(settings.textContent, presentation).toMatch(/Clicking an image does nothing/);
      expect(settings.textContent, presentation).not.toMatch(/opens|full screen viewer/i);
    }
  });
});

// The editing surface has to arrange itself the way the page will, or the choice is a promise the
// editor cannot check. A grid edits as a wrapping grid; a carousel edits as one scrolling row.
describe("editor and public rendering share the selected mode (#1034)", () => {
  it("edits a grid gallery as a wrapping grid", () => {
    const { container } = render(
      <BlockEditor section="home" initialBlocks={[gallery(3)]} newId={counterIds()} />,
    );
    openGallerySettings();
    const surface = container.querySelector(".inline-image-gallery")!;
    expect(surface.getAttribute("data-presentation")).toBe("grid");
    expect(container.querySelector(".image-gallery--carousel")).toBeNull();
  });

  it("edits a carousel gallery as one scrolling row it can reach by keyboard", () => {
    const { container } = render(
      <BlockEditor
        section="home"
        initialBlocks={[gallery(3, "carousel")]}
        newId={counterIds()}
      />,
    );
    openGallerySettings();
    const surface = container.querySelector(".inline-image-gallery")!;
    expect(surface.getAttribute("data-presentation")).toBe("carousel");
    const row = container.querySelector(".image-gallery")!;
    expect(row.classList.contains("image-gallery--carousel")).toBe(true);
    const hint = screen.getByText("Scroll horizontally to see all images");
    expect(hint).toBeVisible();
    expect(row.getAttribute("aria-describedby")).toContain(hint.id);
    // A scroll container a keyboard cannot reach is the accessibility trap this mode would
    // otherwise introduce, in the editor exactly as on the page.
    expect(row.getAttribute("tabindex")).toBe("0");
  });

  it("follows the mode as soon as it is changed, without a save or a reload", () => {
    const { container } = render(
      <BlockEditor section="home" initialBlocks={[gallery(3)]} newId={counterIds()} />,
    );
    const settings = openGallerySettings();
    fireEvent.click(within(settings).getByRole("radio", { name: "Carousel" }));
    expect(
      container.querySelector(".inline-image-gallery")!.getAttribute("data-presentation"),
    ).toBe("carousel");
  });
});

// One item, two items and the review maximum retain every named control in both modes.
describe.each(GALLERY_PRESENTATIONS)("a %s gallery at every item count (#1034)", (presentation) => {
  it.each([1, 2, 12])(
    "keeps every control reachable with %i images",
    (count) => {
      const { container } = render(
        <BlockEditor
          section="home"
          initialBlocks={[gallery(count, presentation)]}
          newId={counterIds()}
        />,
      );
      openGallerySettings();
      const items = container.querySelectorAll(".inline-gallery-item");
      expect(items).toHaveLength(count);

      for (const [index, item] of Array.from(items).entries()) {
        const controls = within(item as HTMLElement);
        expect(controls.getByRole("textbox", { name: `Alt text ${index + 1}` })).toBeVisible();
        expect(controls.getByRole("button", { name: `Move up: image ${index + 1}` })).toBeVisible();
        expect(
          controls.getByRole("button", { name: `Move down: image ${index + 1}` }),
        ).toBeVisible();
        expect(
          controls.getByRole("button", { name: `Remove image ${index + 1} from gallery` }),
        ).toBeVisible();
      }
    },
  );
});
