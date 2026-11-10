import { describe, expect, it } from "vitest";
import { fitToolbarItems } from "../src/lib/toolbar-overflow";

const items = [
  { key: "filter", width: 100, priority: 3 },
  { key: "sort", width: 150, priority: 2 },
  { key: "select", width: 120, priority: 1 },
];

describe("fitToolbarItems", () => {
  it("shows every item and no More menu when they all fit", () => {
    expect(fitToolbarItems(items, 400, 8, 44)).toEqual({
      visible: ["filter", "sort", "select"],
      overflow: [],
    });
  });

  it("moves the lowest-priority items into More first, keeping document order", () => {
    // 100 + 8 + 150 = 258, plus 8 + 44 for More = 310 fits in 320; select does not.
    expect(fitToolbarItems(items, 320, 8, 44)).toEqual({
      visible: ["filter", "sort"],
      overflow: ["select"],
    });
  });

  it("keeps a higher-priority item even when an earlier one overflows", () => {
    const reordered = [
      { key: "select", width: 120, priority: 1 },
      { key: "filter", width: 100, priority: 3 },
    ];
    expect(fitToolbarItems(reordered, 200, 8, 44)).toEqual({
      visible: ["filter"],
      overflow: ["select"],
    });
  });

  it("stops at the first item that does not fit so the order stays predictable", () => {
    // filter fits (100 + 52 = 152); sort would need 310; select alone would fit but is lower priority.
    expect(fitToolbarItems(items, 280, 8, 44)).toEqual({
      visible: ["filter"],
      overflow: ["sort", "select"],
    });
  });

  it("puts everything in More when nothing fits", () => {
    expect(fitToolbarItems(items, 40, 8, 44)).toEqual({
      visible: [],
      overflow: ["filter", "sort", "select"],
    });
  });

  it("treats an unmeasured width as not fitting rather than guessing", () => {
    const unmeasured = [{ key: "filter", width: Number.NaN, priority: 1 }];
    expect(fitToolbarItems(unmeasured, 500, 8, 44).overflow).toEqual(["filter"]);
  });
});
