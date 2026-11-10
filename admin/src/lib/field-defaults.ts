import { emptyRichTextDoc } from "./empty-rich-text";
import type { EditorField } from "../../../packages/content-core/src/editor-admin";

// The value a brand-new field starts from, by widget kind. A required field needs a real
// starting value (not undefined) so the save boundary has something to validate: a toggle
// is off, a rich-text body is a valid empty document (not ""), a repeatable list is empty,
// and every text-like field is a blank string. Pure, so the field renderer, the record
// forms, and the block factory all seed from the same source.
export function defaultValueForField(field: EditorField): unknown {
  if (field.key === "contentLinkNewTab") return true;
  switch (field.kind) {
    case "toggle":
      return false;
    case "richText":
      return emptyRichTextDoc();
    case "list":
      return [];
    // An empty byline (#1040). RecordForm seeds the real starting credits before
    // this runs -- the record's own, a converted legacy author, or the signed-in
    // author -- so this is only the shape a byline field falls back to.
    case "storyCredits":
      return [];
    case "select":
      return field.options?.[0]?.value ?? "";
    case "number":
      return undefined;
    default:
      return "";
  }
}

// A brand-new list item, every sub-field seeded from its own descriptor. Derived rather
// than hand-written so an added sub-field cannot be silently missed by one of the surfaces
// that create items.
export function emptyItem(itemFields: readonly EditorField[]): Record<string, unknown> {
  const item: Record<string, unknown> = {};
  for (const field of itemFields) {
    const value = defaultValueForField(field);
    if (value !== undefined) item[field.key] = value;
  }
  return item;
}
