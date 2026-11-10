import { describe, expect, it } from "vitest";
import {
  createLocalBentoStore,
  createMemoryBentoStore,
} from "../src/lib/editor-bento-store";
import {
  defaultBentoLayout,
  movePanel,
  type BentoPanelDef,
} from "../src/lib/editor-bento-layout";

const DEFS: readonly BentoPanelDef[] = [
  { id: "content", defaultZone: "main", allowedZones: ["main"] },
  { id: "metadata", defaultZone: "side" },
  { id: "preview", defaultZone: "side", defaultCollapsed: true },
];

// A minimal Storage stand-in over a Map, so the local store can be exercised without a browser.
function fakeStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  } as Storage;
}

describe("editor bento store", () => {
  it("returns the reconciled default when nothing is stored", () => {
    const store = createLocalBentoStore(fakeStorage());
    expect(store.load("page", DEFS)).toEqual(defaultBentoLayout(DEFS));
  });

  it("persists and reloads a rearranged layout", () => {
    const storage = fakeStorage();
    const store = createLocalBentoStore(storage);
    const moved = movePanel(defaultBentoLayout(DEFS), DEFS, "metadata", "main", 0);
    store.save("page", moved);
    expect(store.load("page", DEFS)).toEqual(moved);
  });

  it("scopes layouts by key", () => {
    const store = createLocalBentoStore(fakeStorage());
    const moved = movePanel(defaultBentoLayout(DEFS), DEFS, "metadata", "main");
    store.save("page", moved);
    // A different key is untouched and falls back to the default.
    expect(store.load("post", DEFS)).toEqual(defaultBentoLayout(DEFS));
  });

  it("clears a saved layout and returns the declared default", () => {
    const storage = fakeStorage();
    const store = createLocalBentoStore(storage);
    const moved = movePanel(defaultBentoLayout(DEFS), DEFS, "metadata", "main");
    store.save("page", moved);

    expect(store.reset("page", DEFS)).toEqual(defaultBentoLayout(DEFS));
    expect(store.load("page", DEFS)).toEqual(defaultBentoLayout(DEFS));
    expect(storage.length).toBe(0);
  });

  it("reconciles a stored layout against a changed panel set on load", () => {
    const storage = fakeStorage();
    const store = createLocalBentoStore(storage);
    store.save("page", defaultBentoLayout(DEFS));
    // A later build removes "preview" and adds "outline".
    const nextDefs: BentoPanelDef[] = [
      { id: "content", defaultZone: "main" },
      { id: "metadata", defaultZone: "side" },
      { id: "outline", defaultZone: "side" },
    ];
    const loaded = store.load("page", nextDefs);
    expect(loaded.map((p) => p.id).sort()).toEqual(["content", "metadata", "outline"]);
    expect(loaded.some((p) => p.id === "preview")).toBe(false);
  });

  it("repairs a legacy Page content placement outside its allowed zone", () => {
    const store = createLocalBentoStore(
      fakeStorage({
        "njpbs.admin.editor-bento.page": JSON.stringify([
          { id: "content", zone: "side", collapsed: false },
          { id: "metadata", zone: "side", collapsed: false },
          { id: "preview", zone: "side", collapsed: true },
        ]),
      }),
    );

    const loaded = store.load("page", DEFS);
    expect(loaded.find((panel) => panel.id === "content")?.zone).toBe("main");
  });

  it("fails safe to defaults when the stored value is corrupt", () => {
    const store = createLocalBentoStore(fakeStorage({ "njpbs.admin.editor-bento.page": "{{{" }));
    expect(store.load("page", DEFS)).toEqual(defaultBentoLayout(DEFS));
  });

  it("fails safe when storage throws, without surfacing the error", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    const store = createLocalBentoStore(throwing);
    expect(store.load("page", DEFS)).toEqual(defaultBentoLayout(DEFS));
    expect(() => store.save("page", defaultBentoLayout(DEFS))).not.toThrow();
  });

  it("provides an in-memory store for tests that reconciles and snapshots", () => {
    const store = createMemoryBentoStore();
    const moved = movePanel(defaultBentoLayout(DEFS), DEFS, "metadata", "main");
    store.save("page", moved);
    expect(store.load("page", DEFS)).toEqual(moved);
    expect(store.snapshot().page.map((p) => p.id)).toEqual(moved.map((p) => p.id));
  });
});
