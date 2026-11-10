import { describe, expect, it } from "vitest";
import {
  isMenuNavigationKey,
  nextMenuIndex,
} from "../src/lib/menu-navigation";

describe("menu navigation keys", () => {
  it("names only the keys a menu owns", () => {
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) {
      expect(isMenuNavigationKey(key)).toBe(true);
    }
    // Tab and Escape are handled as dismissals, not as movement inside the menu,
    // so they must not be claimed here.
    for (const key of ["Tab", "Escape", "Enter", " ", "ArrowLeft"]) {
      expect(isMenuNavigationKey(key)).toBe(false);
    }
  });

  it("wraps in both directions", () => {
    expect(nextMenuIndex("ArrowDown", 0, 3)).toBe(1);
    expect(nextMenuIndex("ArrowDown", 2, 3)).toBe(0);
    expect(nextMenuIndex("ArrowUp", 0, 3)).toBe(2);
    expect(nextMenuIndex("ArrowUp", 2, 3)).toBe(1);
  });

  it("jumps to the ends", () => {
    expect(nextMenuIndex("Home", 2, 3)).toBe(0);
    expect(nextMenuIndex("End", 0, 3)).toBe(2);
  });

  it("treats an unknown current position as entering from the top or bottom", () => {
    expect(nextMenuIndex("ArrowDown", -1, 3)).toBe(0);
    expect(nextMenuIndex("ArrowUp", -1, 3)).toBe(2);
  });

  it("returns null when there is nothing to move to", () => {
    expect(nextMenuIndex("ArrowDown", 0, 0)).toBeNull();
    expect(nextMenuIndex("Enter", 0, 3)).toBeNull();
  });
});
