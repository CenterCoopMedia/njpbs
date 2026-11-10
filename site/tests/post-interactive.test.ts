import { describe, expect, it } from "vitest";
import type { PageBlock } from "../../packages/content-core/src/content-model";
import {
  assertInteractiveInventory,
  interactiveInventoryText,
  interactivePostInventory,
} from "../src/lib/post-interactive";

function embed(
  id: string,
  url: string,
  caption?: string,
  visible = true,
): PageBlock {
  return {
    id,
    type: "embed",
    order: 0,
    visible,
    data: {
      url,
      ...(caption === undefined ? {} : { caption }),
    },
  };
}

describe("interactivePostInventory", () => {
  it("counts visible launchable modules and missing editorial labels", () => {
    expect(
      interactivePostInventory([
        embed("map", "https://example.org/map", "Explore the statewide map"),
        embed("calculator", "/tools/calculator/", " "),
        embed("hidden", "https://example.org/hidden", undefined, false),
      ]),
    ).toEqual({ modules: 2, unlabeledModules: 1, unsafeModules: 0 });
  });

  it("counts only complete visible data figures as modules", () => {
    const figure: PageBlock = { id: "figure", type: "data_figure", order: 0, visible: true,
      data: { datasetId: "jobs-rate", version: { mode: "pinned", releaseId: "september-2026" }, display: "expanded" } };
    expect(interactivePostInventory([figure])).toEqual({ modules: 1, unlabeledModules: 0, unsafeModules: 0 });
    expect(() => assertInteractiveInventory(interactivePostInventory([figure]))).not.toThrow();
    expect(interactivePostInventory([{ ...figure, visible: false }])).toEqual({ modules: 0, unlabeledModules: 0, unsafeModules: 0 });
    expect(interactivePostInventory([{ ...figure, data: { ...figure.data, datasetId: "" } }])).toEqual({ modules: 0, unlabeledModules: 0, unsafeModules: 1 });
  });

  it("counts a custom HTML block as a module named by its frame title", () => {
    const html = (id: string, title?: string): PageBlock => ({
      id, type: "html", order: 0, visible: true,
      data: { html: "<p>Chart</p>", ...(title === undefined ? {} : { title }) },
    });
    expect(interactivePostInventory([html("named", "School funding chart"), html("unnamed")]))
      .toEqual({ modules: 2, unlabeledModules: 1, unsafeModules: 0 });
  });

  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["unsafe scheme", "javascript:alert(1)"],
    ["protocol relative", "//example.org/map"],
  ])("records an unusable %s embed instead of calling it a module", (_label, url) => {
    expect(
      interactivePostInventory([
        embed("bad-link", url, "Open the experience"),
      ]),
    ).toEqual({ modules: 0, unlabeledModules: 0, unsafeModules: 1 });
  });

  it("ignores every block that is not an interactive link", () => {
    const prose: PageBlock = {
      id: "prose",
      type: "prose",
      order: 0,
      visible: true,
      data: { content: { type: "doc", content: [] } },
    };
    expect(interactivePostInventory([prose])).toEqual({
      modules: 0,
      unlabeledModules: 0,
      unsafeModules: 0,
    });
  });
});

describe("Interactive/Data Lab readiness", () => {
  it("refuses an unsafe or blank module link", () => {
    expect(() =>
      assertInteractiveInventory({
        modules: 0,
        unlabeledModules: 0,
        unsafeModules: 1,
      }),
    ).toThrow(/approved, nonblank link/);
  });

  it("requires at least one launchable module", () => {
    expect(() =>
      assertInteractiveInventory({
        modules: 0,
        unlabeledModules: 0,
        unsafeModules: 0,
      }),
    ).toThrow(/at least one/);
  });

  it("requires a concise editorial label for every module", () => {
    expect(() =>
      assertInteractiveInventory({
        modules: 2,
        unlabeledModules: 1,
        unsafeModules: 0,
      }),
    ).toThrow(/needs a concise caption/);
    expect(() =>
      assertInteractiveInventory({
        modules: 2,
        unlabeledModules: 0,
        unsafeModules: 0,
      }),
    ).not.toThrow();
  });

  it("states the module and section inventory without padded numbering", () => {
    expect(
      interactiveInventoryText(
        { modules: 1, unlabeledModules: 0, unsafeModules: 0 },
        0,
      ),
    ).toBe("1 interactive module");
    expect(
      interactiveInventoryText(
        { modules: 2, unlabeledModules: 0, unsafeModules: 0 },
        3,
      ),
    ).toBe("2 interactive modules · 3 reporting sections");
  });
});
