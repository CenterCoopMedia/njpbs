import { describe, expect, it } from "vitest";
import formDefaults from "../../packages/content-core/fixtures/library-card-form-defaults.json";
import { recordFieldsFor } from "../../packages/content-core/src/editor-admin";
import { defaultValueForField } from "../src/lib/field-defaults";

// Characterize the existing form defaults for the Site's save-policy and renderer
// contract tests. Both packages check this fixture using their own dependencies.
describe("library card form defaults", () => {
  it.each(["sponsor", "newsletter"] as const)("matches the %s defaults used by the public contract", kind => {
    const defaults = Object.fromEntries(recordFieldsFor(kind).filter(field => !field.path)
      .map(field => [field.key, defaultValueForField(field)]));
    expect(defaults).toStrictEqual(formDefaults[kind]);
  });
});
