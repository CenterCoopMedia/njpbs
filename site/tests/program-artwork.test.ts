import { describe, expect, it } from "vitest";
import { isIncorrectProgramArtwork } from "../src/lib/program-artwork";

const affairsLogo = { assetId: "8ba39d8d-adc2-47d9-af5f-c07dcdf3f10b" };

describe("the State of the Arts artwork correction", () => {
  it("omits the verified wrong logo only on State of the Arts", () => {
    expect(isIncorrectProgramArtwork("/programs/state-of-the-arts/", affairsLogo)).toBe(true);
    expect(isIncorrectProgramArtwork("/programs/state-of-affairs/", affairsLogo)).toBe(false);
    expect(isIncorrectProgramArtwork("/programs/another-show/", affairsLogo)).toBe(false);
  });

  it("accepts replacement artwork and the existing no-image state", () => {
    const path = "/programs/state-of-the-arts/";
    expect(isIncorrectProgramArtwork(path, { assetId: "approved-arts-artwork" })).toBe(false);
    expect(isIncorrectProgramArtwork(path, null)).toBe(false);
    expect(isIncorrectProgramArtwork(path, undefined)).toBe(false);
  });
});
