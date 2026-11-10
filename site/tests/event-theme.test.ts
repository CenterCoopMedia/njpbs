// @vitest-environment node
import { describe, it, expect } from "vitest";
import { contrastRatio, meetsAA } from "../src/lib/contrast";
import { EVENT_DATE_SURFACE, EVENT_DATE_ACCENT } from "../src/lib/event-theme";
import { resolveTokenColor } from "./color-token-test-utils";

// The Events date labels (.feature__month / .ev__month) are small uppercase text
// on the dark date plate. They must clear WCAG 2.1 AA for normal text (4.5:1).
// This guards against a regression to a too-dark accent (the prior #4d5ee8
// reached only ~3.9:1 here and failed axe color-contrast).
describe("Events date-label contrast", () => {
  it("clears AA for normal text on the date-plate surface", () => {
    const ratio = contrastRatio(
      resolveTokenColor(EVENT_DATE_ACCENT),
      resolveTokenColor(EVENT_DATE_SURFACE),
    );
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    expect(meetsAA(ratio)).toBe(true);
  });
});
