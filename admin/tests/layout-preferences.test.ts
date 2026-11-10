import { describe, expect, it } from "vitest";
import {
  readLayoutDensity,
  readLayoutDisclosure,
  readStoredLayoutDisclosure,
  writeLayoutDensity,
  writeLayoutDisclosure,
} from "../src/lib/layout-preferences";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("admin layout preferences", () => {
  it("defaults only the outline to closed unless storage explicitly opens it", () => {
    const storage = new MemoryStorage();
    for (const value of [null, "invalid", "", "true"]) {
      if (value !== null) storage.setItem("njpbs-admin:outline-collapsed", value);
      expect(readLayoutDisclosure("outline", storage)).toBe(true);
    }
    expect(readLayoutDisclosure("navigation", storage)).toBe(false);
    expect(readLayoutDisclosure("inspector", storage)).toBe(false);
    expect(readLayoutDisclosure("outline", null)).toBe(true);
    writeLayoutDisclosure("outline", false, storage);
    expect(readLayoutDisclosure("outline", storage)).toBe(false);
  });

  it("uses a screen default only until the person stores a disclosure preference", () => {
    const storage = new MemoryStorage();
    expect(readStoredLayoutDisclosure("navigation", storage)).toBeNull();
    expect(readLayoutDisclosure("navigation", storage, true)).toBe(true);
    writeLayoutDisclosure("navigation", false, storage);
    expect(readStoredLayoutDisclosure("navigation", storage)).toBe(false);
    expect(readLayoutDisclosure("navigation", storage, true)).toBe(false);
    expect(readLayoutDisclosure("outline", storage, false)).toBe(false);
    expect(storage.getItem("njpbs-admin:outline-collapsed")).toBeNull();
  });

  it("uses comfortable density by default and ignores an unknown stored value", () => {
    const storage = new MemoryStorage();
    expect(readLayoutDensity(storage)).toBe("comfortable");

    storage.setItem("njpbs-admin:layout-density", "tiny");
    expect(readLayoutDensity(storage)).toBe("comfortable");
  });

  it("persists each density and disclosure without coupling editor content to view state", () => {
    const storage = new MemoryStorage();

    writeLayoutDensity("compact", storage);
    writeLayoutDisclosure("navigation", true, storage);
    writeLayoutDisclosure("outline", true, storage);
    writeLayoutDisclosure("inspector", true, storage);

    expect(readLayoutDensity(storage)).toBe("compact");
    expect(readLayoutDisclosure("navigation", storage)).toBe(true);
    expect(readLayoutDisclosure("outline", storage)).toBe(true);
    expect(readLayoutDisclosure("inspector", storage)).toBe(true);

    writeLayoutDensity("loose", storage);
    writeLayoutDisclosure("outline", false, storage);
    writeLayoutDisclosure("inspector", false, storage);
    expect(readLayoutDensity(storage)).toBe("loose");
    expect(readLayoutDisclosure("outline", storage)).toBe(false);
    expect(readLayoutDisclosure("inspector", storage)).toBe(false);
  });

  it("falls back safely when browser storage is unavailable", () => {
    const unavailable = {
      getItem: () => {
        throw new Error("storage blocked");
      },
      setItem: () => {
        throw new Error("storage blocked");
      },
    };

    expect(readStoredLayoutDisclosure("navigation", unavailable)).toBeNull();
    expect(readLayoutDensity(unavailable)).toBe("comfortable");
    expect(readLayoutDisclosure("navigation", unavailable)).toBe(false);
    expect(readLayoutDisclosure("inspector", unavailable)).toBe(false);
    expect(readLayoutDisclosure("outline", unavailable)).toBe(true);
    expect(() => writeLayoutDensity("compact", unavailable)).not.toThrow();
    expect(() => writeLayoutDisclosure("outline", true, unavailable)).not.toThrow();
  });
});
