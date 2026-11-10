import { describe, expect, it } from "vitest";
import { pbsPlayerPermissions } from "../src/lib/player-permissions";

describe("PBS player permissions", () => {
  it("delegates geolocation only to the GA livestream player", () => {
    expect(pbsPlayerPermissions("livestream")).toBe(
      "geolocation; encrypted-media",
    );
  });

  it("limits an on-demand Partner Player to encrypted media", () => {
    expect(pbsPlayerPermissions("on-demand")).toBe("encrypted-media");
  });
});
