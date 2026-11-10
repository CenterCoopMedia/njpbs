import { describe, expect, it } from "vitest";
import {
  defaultBentoLayout,
  movePanel,
  panelsInZone,
  parseBentoLayout,
  reconcileBentoLayout,
  reorderPanel,
  serializeBentoLayout,
  setPanelCollapsed,
  type BentoPanelDef,
  type BentoPanelState,
} from "../src/lib/editor-bento-layout";

const DEFS: readonly BentoPanelDef[] = [
  { id: "content", defaultZone: "main", allowedZones: ["main"] },
  { id: "metadata", defaultZone: "side" },
  { id: "preview", defaultZone: "side", defaultCollapsed: true },
];

function ids(panels: readonly BentoPanelState[]): string[] {
  return panels.map((p) => p.id);
}

describe("editor bento layout", () => {
  it("seeds each panel at its declared default zone and collapse", () => {
    const layout = defaultBentoLayout(DEFS);
    expect(ids(panelsInZone(layout, "main"))).toEqual(["content"]);
    expect(ids(panelsInZone(layout, "side"))).toEqual(["metadata", "preview"]);
    expect(layout.find((p) => p.id === "preview")?.collapsed).toBe(true);
    expect(layout.find((p) => p.id === "content")?.collapsed).toBe(false);
  });

  it("moves a panel to the other zone, appended at the end by default", () => {
    const layout = defaultBentoLayout(DEFS);
    const next = movePanel(layout, DEFS, "metadata", "main");
    expect(ids(panelsInZone(next, "main"))).toEqual(["content", "metadata"]);
    expect(ids(panelsInZone(next, "side"))).toEqual(["preview"]);
  });

  it("inserts a moved panel at a requested index within the target zone", () => {
    const layout = defaultBentoLayout(DEFS);
    // metadata -> main, before content (index 0).
    const next = movePanel(layout, DEFS, "metadata", "main", 0);
    expect(ids(panelsInZone(next, "main"))).toEqual(["metadata", "content"]);
  });

  it("refuses to move a panel outside its allowed zones", () => {
    const layout = defaultBentoLayout(DEFS);
    const next = movePanel(layout, DEFS, "content", "side");

    expect(ids(panelsInZone(next, "main"))).toEqual(["content"]);
    expect(ids(panelsInZone(next, "side"))).toEqual(["metadata", "preview"]);
  });

  it("reorders within a zone up and down without changing the other zone", () => {
    const layout = defaultBentoLayout(DEFS);
    const down = reorderPanel(layout, DEFS, "metadata", 1);
    expect(ids(panelsInZone(down, "side"))).toEqual(["preview", "metadata"]);
    expect(ids(panelsInZone(down, "main"))).toEqual(["content"]);
    const backUp = reorderPanel(down, DEFS, "metadata", -1);
    expect(ids(panelsInZone(backUp, "side"))).toEqual(["metadata", "preview"]);
  });

  it("is a no-op to reorder past the ends of a zone", () => {
    const layout = defaultBentoLayout(DEFS);
    expect(ids(reorderPanel(layout, DEFS, "metadata", -1))).toEqual(ids(layout));
    expect(ids(reorderPanel(layout, DEFS, "preview", 1))).toEqual(ids(layout));
  });

  it("does not mutate its input", () => {
    const layout = defaultBentoLayout(DEFS);
    const before = ids(layout);
    movePanel(layout, DEFS, "content", "side");
    setPanelCollapsed(layout, "content", true);
    reorderPanel(layout, DEFS, "metadata", 1);
    expect(ids(layout)).toEqual(before);
    expect(layout.find((p) => p.id === "content")?.zone).toBe("main");
  });

  it("toggles a single panel's collapsed flag and leaves the rest alone", () => {
    const layout = defaultBentoLayout(DEFS);
    const next = setPanelCollapsed(layout, "content", true);
    expect(next.find((p) => p.id === "content")?.collapsed).toBe(true);
    expect(next.find((p) => p.id === "metadata")?.collapsed).toBe(false);
  });

  it("reconciles a saved layout: keeps order, drops unknown ids, appends new panels at default", () => {
    const saved: BentoPanelState[] = [
      { id: "preview", zone: "main", collapsed: false },
      { id: "gone", zone: "main", collapsed: false },
      { id: "content", zone: "side", collapsed: true },
    ];
    const reconciled = reconcileBentoLayout(saved, DEFS);
    // Known ids keep their saved order where placement is allowed; the unknown id is dropped.
    // A legacy placement outside the panel's allowed zones repairs to its default.
    expect(ids(panelsInZone(reconciled, "main"))).toEqual(["preview", "content"]);
    expect(ids(panelsInZone(reconciled, "side"))).toEqual(["metadata"]);
    // A panel absent from the save is appended at its default zone.
    expect(reconciled.find((p) => p.id === "metadata")?.zone).toBe("side");
  });

  it("inserts a new main panel before later main panels from the current definitions", () => {
    const defs: readonly BentoPanelDef[] = [
      { id: "page-title", defaultZone: "main", allowedZones: ["main"] },
      ...DEFS,
    ];
    const reconciled = reconcileBentoLayout(defaultBentoLayout(DEFS), defs);
    expect(ids(panelsInZone(reconciled, "main"))).toEqual(["page-title", "content"]);
  });

  it("repairs a missing restricted panel whose declared default is not allowed", () => {
    const defs: readonly BentoPanelDef[] = [
      { id: "content", defaultZone: "side", allowedZones: ["main"] },
      { id: "metadata", defaultZone: "side" },
    ];
    const reconciled = reconcileBentoLayout(
      [{ id: "metadata", zone: "side", collapsed: false }],
      defs,
    );

    expect(reconciled.find((panel) => panel.id === "content")?.zone).toBe("main");
  });

  it("round-trips through serialize/parse", () => {
    const layout = setPanelCollapsed(
      movePanel(defaultBentoLayout(DEFS), DEFS, "metadata", "main", 0),
      "content",
      true,
    );
    const parsed = parseBentoLayout(serializeBentoLayout(layout));
    expect(parsed).toEqual(layout.map((p) => ({ id: p.id, zone: p.zone, collapsed: p.collapsed })));
  });

  it("parses leniently: skips malformed entries, returns null on non-arrays", () => {
    expect(parseBentoLayout("not json")).toBeNull();
    expect(parseBentoLayout(JSON.stringify({ not: "an array" }))).toBeNull();
    const parsed = parseBentoLayout(
      JSON.stringify([
        { id: "content", zone: "main", collapsed: false },
        { id: 42, zone: "main", collapsed: false },
        { id: "metadata", zone: "nowhere", collapsed: "no" },
      ]),
    );
    // The valid entry is kept; the numeric-id entry is skipped; a bad zone/collapsed is left absent
    // so reconciliation can restore the panel's default rather than a hardcoded value.
    expect(parsed).toEqual([
      { id: "content", zone: "main", collapsed: false },
      { id: "metadata" },
    ]);
  });

  it("reconciles a corrupt stored field to the panel's default, not a hardcoded value", () => {
    // A partially-corrupt entry must fail safe per field: metadata's default zone is side (not the
    // hardcoded main a coercion would have produced), and preview's default collapse is true.
    const parsed = parseBentoLayout(
      JSON.stringify([
        { id: "metadata", zone: "bogus" },
        { id: "preview", collapsed: "maybe" },
      ]),
    );
    const reconciled = reconcileBentoLayout(parsed ?? [], DEFS);
    expect(reconciled.find((p) => p.id === "metadata")?.zone).toBe("side");
    expect(reconciled.find((p) => p.id === "preview")?.collapsed).toBe(true);
  });
});
