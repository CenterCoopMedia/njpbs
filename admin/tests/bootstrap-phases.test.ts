import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_PHASES,
  bootstrapPhase,
  bootstrapPhaseViews,
  bootstrapStageIndex,
} from "../src/lib/bootstrap-phases";

describe("bootstrap phases", () => {
  it("lists the admission path in the order it runs", () => {
    expect(BOOTSTRAP_PHASES.map((phase) => phase.stage)).toEqual([
      "session",
      "admission",
      "profile",
      "workspace",
    ]);
    for (const phase of BOOTSTRAP_PHASES) {
      expect(phase.title).not.toMatch(/[.…]$/);
      expect(phase.details.length).toBeGreaterThan(0);
      for (const detail of phase.details) expect(detail).not.toMatch(/[.…]$/);
    }
  });

  it("marks earlier phases done, the current one active, and later ones pending", () => {
    expect(bootstrapPhaseViews("session").map((phase) => phase.state)).toEqual([
      "active",
      "pending",
      "pending",
      "pending",
    ]);
    expect(bootstrapPhaseViews("profile").map((phase) => phase.state)).toEqual([
      "done",
      "done",
      "active",
      "pending",
    ]);
    expect(bootstrapPhaseViews("workspace").map((phase) => phase.state)).toEqual([
      "done",
      "done",
      "done",
      "active",
    ]);
  });

  it("resolves a stage to its phase and index", () => {
    expect(bootstrapStageIndex("admission")).toBe(1);
    expect(bootstrapPhase("admission").title).toBe("Confirming staff access");
  });
});
