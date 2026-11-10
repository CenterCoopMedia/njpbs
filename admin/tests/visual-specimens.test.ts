import { describe, expect, it } from "vitest";
import { MissingVisualSpecimenError, PRESENTATION_PINNED_SPECIMEN_IDS, VISUAL_SPECIMEN_IDS, visualSpecimenName, visualSpecimenPairs, type GallerySpecimen } from "../src/lib/visual-specimens";

const registry: GallerySpecimen[] = [
  { id: "newsroom-home", title: "Newsroom home" },
  { id: "queue", title: "Publish queue" },
  { id: "page-narrow", title: "Content studio narrow", width: 320 },
];

describe("visualSpecimenPairs", () => {
  it("fails loudly when a selected specimen has left the registry", () => {
    expect(() =>
      visualSpecimenPairs(registry, { selected: ["newsroom-home", "gone"] }),
    ).toThrow(MissingVisualSpecimenError);
    try {
      visualSpecimenPairs(registry, { selected: ["gone", "also-gone"] });
      expect.unreachable("expected a MissingVisualSpecimenError");
    } catch (error) {
      expect((error as MissingVisualSpecimenError).missing).toEqual([
        "gone",
        "also-gone",
      ]);
    }
  });

});

describe("the recorded selection", () => {
  it("never captures a specimen that pins its own control presentation", () => {
    const overlap = VISUAL_SPECIMEN_IDS.filter((id) =>
      PRESENTATION_PINNED_SPECIMEN_IDS.includes(id),
    );
    expect(overlap).toEqual([]);
  });

});

describe("visualSpecimenName", () => {
  it("gives every default pair a distinct baseline name", () => {
    const full: GallerySpecimen[] = VISUAL_SPECIMEN_IDS.map((id) => ({
      id,
      title: id,
    }));
    const names = visualSpecimenPairs(full).map(visualSpecimenName);
    expect(new Set(names).size).toBe(names.length);
  });
});
