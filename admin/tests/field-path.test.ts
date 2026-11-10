import { describe, expect, it } from "vitest";
import {
  fieldPathKey,
  hasFieldValue,
  readFieldValue,
  removeFieldValue,
  writeFieldValue,
} from "../src/lib/field-path";
import type { EditorField } from "../../packages/content-core/src/editor-admin";

const rootField: EditorField = {
  key: "title",
  label: "Title",
  help: "",
  kind: "text",
  required: true,
};

const seoField: EditorField = {
  ...rootField,
  path: ["seo"],
  label: "Search title",
};

describe("nested editor field paths", () => {
  it("keeps root and nested fields with the same leaf key distinct", () => {
    expect(fieldPathKey(rootField)).toBe("title");
    expect(fieldPathKey(seoField)).toBe("seo.title");
    const value = { title: "Page title", seo: { title: "Search title" } };
    expect(readFieldValue(value, rootField)).toBe("Page title");
    expect(readFieldValue(value, seoField)).toBe("Search title");
  });

  it("distinguishes an absent nested field from a present empty value", () => {
    expect(hasFieldValue({}, seoField)).toBe(false);
    expect(hasFieldValue({ seo: {} }, seoField)).toBe(false);
    expect(hasFieldValue({ seo: { title: "" } }, seoField)).toBe(true);
  });

  it("writes a nested field immutably and preserves unknown sibling metadata", () => {
    const before = {
      title: "Page",
      seo: { title: "Old", description: "Keep", legacyPluginValue: "keep too" },
    };
    const after = writeFieldValue(before, seoField, "New");

    expect(after).toEqual({
      title: "Page",
      seo: { title: "New", description: "Keep", legacyPluginValue: "keep too" },
    });
    expect(after).not.toBe(before);
    expect(after.seo).not.toBe(before.seo);
    expect(before.seo.title).toBe("Old");
  });

  it("creates a missing nested object without mutating the source", () => {
    const before = { title: "Page" };
    expect(writeFieldValue(before, seoField, "Search")).toEqual({
      title: "Page",
      seo: { title: "Search" },
    });
    expect(before).toEqual({ title: "Page" });
  });

  it("removes a nested field, preserves siblings, and leaves the source untouched", () => {
    const before = {
      title: "Page",
      seo: { title: "Search", description: "Keep", legacyPluginValue: "keep too" },
    };
    const after = removeFieldValue(before, seoField);

    expect(after).toEqual({
      title: "Page",
      seo: { description: "Keep", legacyPluginValue: "keep too" },
    });
    expect(after).not.toBe(before);
    expect(after.seo).not.toBe(before.seo);
    expect(before.seo.title).toBe("Search");
  });

  it("prunes a newly introduced empty group but preserves a stored empty group shape", () => {
    const edited = { title: "Page", seo: { title: "Temporary" } };
    expect(removeFieldValue(edited, seoField, { title: "Page" })).toEqual({ title: "Page" });
    expect(removeFieldValue(edited, seoField, { title: "Page", seo: {} })).toEqual({
      title: "Page",
      seo: {},
    });
  });
});
