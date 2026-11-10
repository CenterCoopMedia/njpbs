import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

describe("inline media upload responsive contract", () => {
  it("keeps the picker upload form bounded and single-column at narrow widths", () => {
    expect(styles).toMatch(
      /\.media-picker-upload\s*\{[^}]*min-width:\s*0[^}]*overflow-y:\s*auto/,
    );
    expect(styles).toMatch(
      /\.media-picker-heading\s*\{[^}]*flex-wrap:\s*wrap/,
    );
    expect(styles).toMatch(
      /\.media-picker-upload \.media-upload-panel\s*\{[^}]*min-width:\s*0/,
    );
    expect(styles).toMatch(
      /@media \(max-width: 640px\)[\s\S]*?\.media-picker-dialog\s*\{[^}]*width:\s*100%[^}]*max-width:\s*100%/,
    );
    expect(styles).toMatch(
      /@media \(max-width: 640px\)[\s\S]*?\.media-picker-upload \.media-upload-fields\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/,
    );
    expect(styles).toMatch(
      /@media \(max-width: 640px\)[\s\S]*?\.media-picker-upload \.media-form-actions\s*\{[^}]*align-items:\s*stretch[^}]*flex-direction:\s*column/,
    );
    expect(styles).toMatch(
      /@media \(max-width: 720px\)[\s\S]*?\.media-upload-queue\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/,
    );
    expect(styles).toMatch(
      /@media \(max-width: 720px\)[\s\S]*?\.media-upload-heading,[\s\S]*?\.media-upload-current\s*\{[^}]*flex-direction:\s*column/,
    );
    expect(styles).toMatch(
      /\.media-upload-queue-item > span:first-child,[\s\S]*?overflow-wrap:\s*anywhere/,
    );
  });
});
