import { expect, test } from "./fixtures";
import {
  PRESENTATION_PINNED_SPECIMEN_IDS,
  unselectedSpecimenIds,
  visualSpecimenPairs,
  type GallerySpecimen,
} from "../../src/lib/visual-specimens";
import { GALLERY_PATH } from "./capture";
import { specimenCapturePairs } from "./specimen-selection";

// The registry gate. The captured set is a subset of the gallery, and this is what keeps
// that subset honest: it enumerates the live registry the gallery publishes and fails when
// a selected specimen has been renamed or removed, rather than letting a baseline quietly
// stop being captured. It also records everything the selection leaves out, so the exclusion
// is visible in the run rather than hidden in a cap.
test("the capture selection resolves against the live gallery registry", async ({
  page,
}) => {
  await page.goto(GALLERY_PATH, { waitUntil: "domcontentloaded" });
  const registry = await page.evaluate<GallerySpecimen[]>(async () => {
    // Published while the gallery module evaluates, before the all-states view renders,
    // so this resolves without waiting for every specimen to mount.
    const deadline = Date.now() + 20_000;
    while (!window.__ADMIN_GALLERY_SPECIMENS__ && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return window.__ADMIN_GALLERY_SPECIMENS__ ?? [];
  });

  expect(registry.length).toBeGreaterThan(0);

  // Throws MissingVisualSpecimenError, naming the drifted ids, if the selection no longer
  // resolves.
  const selected = [...new Set(specimenCapturePairs.map(pair => pair.id))];
  expect(selected.filter(id => PRESENTATION_PINNED_SPECIMEN_IDS.includes(id))).toEqual([]);
  const pairs = visualSpecimenPairs(registry, { selected });
  expect(pairs.length).toBe(selected.length * 4);

  const excluded = unselectedSpecimenIds(registry, selected);
  await test.info().attach("excluded-specimens.txt", {
    body: `${registry.length} specimens in the gallery registry, ${specimenCapturePairs.length} capture pairs across ${selected.length} specimens.\n\nNo representative capture:\n${excluded.join("\n")}\n`,
    contentType: "text/plain",
  });
});
