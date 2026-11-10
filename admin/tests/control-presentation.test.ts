import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTROL_PRESENTATION,
  readControlPresentation,
} from "../src/lib/control-presentation";

describe("control presentation preference", () => {
  it.each(["text", "icons"] as const)("accepts the stored %s value", (value) => {
    expect(
      readControlPresentation({
        preferences: { display: { controlPresentation: value } },
      }),
    ).toBe(value);
  });

  it.each([
    null,
    undefined,
    {},
    { preferences: null },
    { preferences: [] },
    { preferences: { display: "icons" } },
    { preferences: { display: { controlPresentation: "compact" } } },
    { preferences: { display: { controlPresentation: ["icons"] } } },
  ])("falls back to icons for missing or malformed profile data", (profile) => {
    expect(readControlPresentation(profile)).toBe(DEFAULT_CONTROL_PRESENTATION);
  });

  it("uses icons as the baseline without replacing an explicit text choice", () => {
    expect(DEFAULT_CONTROL_PRESENTATION).toBe("icons");
    expect(
      readControlPresentation({
        preferences: { display: { controlPresentation: "text" } },
      }),
    ).toBe("text");
  });
});
