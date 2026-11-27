import { describe, expect, it, vi } from "vitest";
import { isStaleModuleError, markAndReload, staleModuleReloadKey } from "../src/lib/stale-module-reload";

const firefox = new TypeError(
  "error loading dynamically imported module: https://admin.njpbs.org/assets/profile-chunk-B1v1id_I.js",
);

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe("stale page file reload", () => {
  it("recognizes the missing-file error from each browser and nothing else", () => {
    expect(isStaleModuleError(firefox)).toBe(true);
    expect(isStaleModuleError(new TypeError("Failed to fetch dynamically imported module: https://x/a.js"))).toBe(true);
    expect(isStaleModuleError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isStaleModuleError(new Error("Unable to preload CSS for /assets/WhatsNew-x1.css"))).toBe(true);
    expect(isStaleModuleError(new TypeError("Cannot read properties of undefined"))).toBe(false);
    expect(isStaleModuleError("error loading dynamically imported module")).toBe(false);
  });

  it("reloads once per missing file, then leaves the error panel", () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    const key = staleModuleReloadKey(firefox, storage, "f6be4ef");
    expect(key).not.toBeNull();
    expect(markAndReload(storage, key!, reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(staleModuleReloadKey(firefox, storage, "f6be4ef")).toBeNull();

    const nextRelease = new TypeError(
      "error loading dynamically imported module: https://admin.njpbs.org/assets/profile-chunk-Zz9.js",
    );
    expect(staleModuleReloadKey(nextRelease, storage, "f6be4ef")).not.toBeNull();
  });

  it("gives each loaded build its own attempt when the browser names no file", () => {
    const storage = memoryStorage();
    const safari = new TypeError("Importing a module script failed.");
    markAndReload(storage, staleModuleReloadKey(safari, storage, "aaa1111")!, vi.fn());
    expect(staleModuleReloadKey(safari, storage, "aaa1111")).toBeNull();
    expect(staleModuleReloadKey(safari, storage, "bbb2222")).not.toBeNull();
  });

  it("does not reload when the marker cannot be stored", () => {
    const reload = vi.fn();
    expect(markAndReload({ setItem: () => { throw new Error("quota"); } }, "k", reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(staleModuleReloadKey(firefox, null, "f6be4ef")).toBeNull();
  });
});
