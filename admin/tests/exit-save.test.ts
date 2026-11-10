import { describe, expect, it } from "vitest";
import { describeUnsavedElsewhere } from "../src/lib/exit-save";

// "Save and leave" has to mean saved. The editor can only commit the surface it currently has
// mounted, so when other surfaces in the same session still hold work, the exit reports what is
// still unsaved instead of leaving with it. This is the sentence the person reads at that moment,
// so it names the items rather than counting them.

describe("describeUnsavedElsewhere", () => {
  it("names one outstanding item", () => {
    expect(describeUnsavedElsewhere(["Schedule"])).toBe(
      "Schedule still has unsaved changes. Open it to save that work, or discard it and leave.",
    );
  });

  it("names two outstanding items", () => {
    expect(describeUnsavedElsewhere(["Schedule", "Watch"])).toBe(
      "Schedule and Watch still have unsaved changes. Open each one to save that work, or discard it and leave.",
    );
  });

  it("names three or more with a serial list", () => {
    expect(describeUnsavedElsewhere(["Schedule", "Watch", "Post"])).toBe(
      "Schedule, Watch, and Post still have unsaved changes. Open each one to save that work, or discard it and leave.",
    );
  });

  it("falls back to a plain count past the point a list stays readable", () => {
    expect(
      describeUnsavedElsewhere(["A", "B", "C", "D", "E", "F"]),
    ).toBe(
      "6 other items still have unsaved changes. Open each one to save that work, or discard it and leave.",
    );
  });

  it("says something true when nothing can be named", () => {
    expect(describeUnsavedElsewhere([])).toBe(
      "Some of this session's work is still unsaved. Open it to save that work, or discard it and leave.",
    );
  });
});
