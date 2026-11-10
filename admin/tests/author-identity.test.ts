import { describe, expect, it } from "vitest";
import { authorInitials, avatarPresentation, focalObjectPosition } from "../src/lib/author-identity";

describe("author initials", () => {
  it("takes the first letter of the first two words", () => {
    expect(authorInitials("Sam Morgan")).toBe("SM");
    expect(authorInitials("jordan avery brown")).toBe("JA");
    expect(authorInitials("  Cher  ")).toBe("C");
  });

  it("never renders empty", () => {
    expect(authorInitials("")).toBe("NP");
    expect(authorInitials("   ")).toBe("NP");
    expect(authorInitials(undefined as unknown as string)).toBe("NP");
  });
});

describe("avatar presentation", () => {
  it("falls back to initials while no photo url is resolved", () => {
    expect(avatarPresentation({ displayName: "Sam Morgan" })).toEqual({
      kind: "initials",
      initials: "SM",
    });
    expect(
      avatarPresentation({ displayName: "Sam Morgan", photoUrl: "  " }),
    ).toEqual({ kind: "initials", initials: "SM" });
  });

  it("uses a resolved photo url when one is supplied", () => {
    expect(
      avatarPresentation({
        displayName: "Sam Morgan",
        photoUrl: "https://example.org/photo.jpg",
      }),
    ).toEqual({
      kind: "photo",
      url: "https://example.org/photo.jpg",
      initials: "SM",
      objectPosition: "50% 50%",
    });
  });

  it("turns a stored focal point into the crop position, centering a bad one", () => {
    expect(
      avatarPresentation({
        displayName: "Sam Morgan",
        photoUrl: "https://example.org/photo.jpg",
        focalX: 0.25,
        focalY: 0.8,
      }),
    ).toMatchObject({ objectPosition: "25% 80%" });
    expect(focalObjectPosition(null, null)).toBe("50% 50%");
    // A coordinate outside the image centers rather than throwing: an odd crop
    // still beats no photograph.
    expect(focalObjectPosition(-1, 4)).toBe("50% 50%");
    expect(focalObjectPosition(Number.NaN, 0)).toBe("50% 0%");
  });
});
