import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  INSPECTOR_DEFAULT_REM,
  INSPECTOR_MAX_REM,
  INSPECTOR_MIN_REM,
  clampInspectorWidth,
  readStoredInspectorWidth,
  stepInspectorWidth,
} from "../src/lib/inspector-width";

describe("inspector width", () => {
  it("matches the inspector tokens", () => {
    const tokens = JSON.parse(readFileSync(resolve(process.cwd(), "src/design-system/tokens.json"), "utf8"));
    const flat = JSON.stringify(tokens);
    expect(flat).toContain(`"inspector-width":"${INSPECTOR_DEFAULT_REM}rem"`);
    expect(flat).toContain(`"inspector-min":"${INSPECTOR_MIN_REM}rem"`);
    expect(flat).toContain(`"inspector-max":"${INSPECTOR_MAX_REM}rem"`);
  });

  it("clamps to the bounds and rounds to a quarter rem", () => {
    expect(clampInspectorWidth(10)).toBe(18);
    expect(clampInspectorWidth(40)).toBe(28);
    expect(clampInspectorWidth(21.3)).toBe(21.25);
    expect(clampInspectorWidth(Number.NaN)).toBe(20);
  });

  it("steps with the window-splitter keys; the handle is on the left edge, so left widens", () => {
    expect(stepInspectorWidth(20, "ArrowLeft")).toBe(21);
    expect(stepInspectorWidth(20, "ArrowRight")).toBe(19);
    expect(stepInspectorWidth(18, "ArrowRight")).toBe(18);
    expect(stepInspectorWidth(22, "Home")).toBe(18);
    expect(stepInspectorWidth(22, "End")).toBe(28);
    expect(stepInspectorWidth(22, "Enter")).toBeNull();
  });

  it("reads a stored width and falls back on anything unusable", () => {
    expect(readStoredInspectorWidth("24")).toBe(24);
    expect(readStoredInspectorWidth("99")).toBe(28);
    expect(readStoredInspectorWidth(null)).toBe(20);
    expect(readStoredInspectorWidth("wide")).toBe(20);
    expect(readStoredInspectorWidth("")).toBe(20);
  });
});
