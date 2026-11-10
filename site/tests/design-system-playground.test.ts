// @vitest-environment node

import { describe, expect, it } from "vitest";
import { serializeDesignTokenCss, serializeDesignTokenJson, validateDesignTokenOverride } from "../src/lib/design-system-playground";

describe("design-system playground", () => {
  it("accepts bounded values and normalizes them before preview or export", () => {
    expect(validateDesignTokenOverride("--pbs-blue", " #AABBCC ")).toEqual({
      valid: true,
      value: "#aabbcc",
    });
    expect(validateDesignTokenOverride("--space-4", "1.25rem")).toEqual({
      valid: true,
      value: "1.25rem",
    });
    expect(validateDesignTokenOverride("--radius-control", "12px")).toEqual({
      valid: true,
      value: "12px",
    });
    expect(validateDesignTokenOverride("--heading-tracking", "-0.05em")).toEqual({
      valid: true,
      value: "-0.05em",
    });
    expect(validateDesignTokenOverride("--motion-duration-standard", "250ms")).toEqual({
      valid: true,
      value: "250ms",
    });
  });

  it("rejects unknown, network-capable, mismatched, and out-of-range values", () => {
    for (const [name, value] of [
      ["--not-allowlisted", "1rem"],
      ["--pbs-blue", "url(https://example.com/pixel)"],
      ["--pbs-blue", "#12345"],
      ["--space-4", "20rem"],
      ["--space-4", "12px"],
      ["--heading-tracking", "1em"],
      ["--motion-duration-standard", "5s"],
    ] as const) {
      expect(validateDesignTokenOverride(name, value).valid, `${name}: ${value}`).toBe(false);
    }
  });

  it("produces deterministic experimental CSS and JSON drafts", () => {
    const overrides = {
      "--space-4": "1.25rem",
      "--pbs-blue": "#3344cc",
    };
    const css = serializeDesignTokenCss(overrides);
    const json = JSON.parse(serializeDesignTokenJson(overrides));

    expect(css).toContain("NJ PBS Design and Asset Lab draft");
    expect(css).toContain("Status: experimental; not approved for production");
    expect(css.indexOf("--pbs-blue")).toBeLessThan(css.indexOf("--space-4"));
    expect(json).toEqual({
      schema: "njpbs-design-token-draft",
      status: "experimental",
      basedOnVersion: "0.3.1",
      overrides: {
        "--pbs-blue": "#3344cc",
        "--space-4": "1.25rem",
      },
    });
  });

  it("refuses to export an invalid draft", () => {
    expect(() => serializeDesignTokenCss({ "--pbs-blue": "url(https://example.com)" })).toThrow(
      /invalid override/i,
    );
  });
});
