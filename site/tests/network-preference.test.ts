import { describe, expect, it } from "vitest";
import {
  isConstrainedConnection,
  isDataSaver,
  isSlowConnection,
  shouldLoadHeavyEnhancement,
  shouldLoadWebFonts,
  type ConnectionLike,
} from "../src/lib/network-preference";

describe("network preference — default to the full experience", () => {
  // The load-bearing guarantee: when the signal is absent (Safari/Firefox/SSR)
  // or unknown, every predicate must keep the full experience. A missing signal
  // can never subtract from the page.
  const absent: Array<ConnectionLike | null | undefined> = [
    null,
    undefined,
    {},
    { effectiveType: undefined },
    { saveData: false },
    { saveData: false, effectiveType: "4g" },
    // A garbage/unknown bucket from a future browser must not constrain.
    { effectiveType: "5g" },
  ];

  for (const conn of absent) {
    it(`treats ${JSON.stringify(conn)} as unconstrained`, () => {
      expect(isDataSaver(conn)).toBe(false);
      expect(isSlowConnection(conn)).toBe(false);
      expect(isConstrainedConnection(conn)).toBe(false);
      expect(shouldLoadHeavyEnhancement(conn)).toBe(true);
      expect(shouldLoadWebFonts(conn)).toBe(true);
    });
  }
});

describe("isDataSaver", () => {
  it("is true only when Save-Data is explicitly on", () => {
    expect(isDataSaver({ saveData: true })).toBe(true);
    expect(isDataSaver({ saveData: false })).toBe(false);
    expect(isDataSaver({})).toBe(false);
  });

  it("overrides a fast effectiveType — the user asked to conserve data", () => {
    expect(isDataSaver({ saveData: true, effectiveType: "4g" })).toBe(true);
    expect(isConstrainedConnection({ saveData: true, effectiveType: "4g" })).toBe(true);
    expect(shouldLoadHeavyEnhancement({ saveData: true, effectiveType: "4g" })).toBe(false);
    expect(shouldLoadWebFonts({ saveData: true, effectiveType: "4g" })).toBe(false);
  });
});

describe("isSlowConnection", () => {
  it("flags the 2g buckets by default, not 3g", () => {
    expect(isSlowConnection({ effectiveType: "slow-2g" })).toBe(true);
    expect(isSlowConnection({ effectiveType: "2g" })).toBe(true);
    expect(isSlowConnection({ effectiveType: "3g" })).toBe(false);
    expect(isSlowConnection({ effectiveType: "4g" })).toBe(false);
  });

  it("includes 3g only when asked", () => {
    expect(isSlowConnection({ effectiveType: "3g" }, { include3g: true })).toBe(true);
    expect(isSlowConnection({ effectiveType: "4g" }, { include3g: true })).toBe(false);
    expect(isSlowConnection({ effectiveType: "2g" }, { include3g: true })).toBe(true);
  });
});

describe("shouldLoadHeavyEnhancement — the WebGL hero gate", () => {
  it("skips on 3g and slower, and on Save-Data", () => {
    expect(shouldLoadHeavyEnhancement({ effectiveType: "slow-2g" })).toBe(false);
    expect(shouldLoadHeavyEnhancement({ effectiveType: "2g" })).toBe(false);
    expect(shouldLoadHeavyEnhancement({ effectiveType: "3g" })).toBe(false);
    expect(shouldLoadHeavyEnhancement({ saveData: true })).toBe(false);
  });

  it("loads on a fast connection", () => {
    expect(shouldLoadHeavyEnhancement({ effectiveType: "4g" })).toBe(true);
  });
});

describe("shouldLoadWebFonts — the 118 KB font gate", () => {
  it("skips on Save-Data and 2g, but keeps fonts on 3g", () => {
    // Fonts are far lighter than the WebGL engine, so 3g still gets them.
    expect(shouldLoadWebFonts({ saveData: true })).toBe(false);
    expect(shouldLoadWebFonts({ effectiveType: "2g" })).toBe(false);
    expect(shouldLoadWebFonts({ effectiveType: "3g" })).toBe(true);
    expect(shouldLoadWebFonts({ effectiveType: "4g" })).toBe(true);
  });
});
