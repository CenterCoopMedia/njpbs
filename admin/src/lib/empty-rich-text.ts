import type { RichTextDoc } from "../../../packages/content-core/src/content-model";

// A fresh, valid empty document: one empty paragraph. Satisfies `isRichTextDoc`, so a
// required rich-text field starts from a real value the save boundary accepts rather
// than `undefined`. Kept apart from the TipTap glue so cms-api can bundle the block factory.
export function emptyRichTextDoc(): RichTextDoc {
  return { type: "doc", content: [{ type: "paragraph" }] };
}
