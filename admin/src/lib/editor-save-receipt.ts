import { isPublicPageId } from "../../../packages/content-core/src/public-pages";
import type { PreviewTarget } from "./saved-preview-operation";

export type SavedEditorReceipt = PreviewTarget;

/** Only a trusted save/read result can supply these values; never mutable editor props. */
export function editorSaveReceipt(
  collection: "cmsPages" | "cmsPosts",
  documentId: unknown,
  sourceVersion: unknown,
): SavedEditorReceipt | undefined {
  if (typeof documentId !== "string" ||
      !(collection === "cmsPages" ? isPublicPageId(documentId) : /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(documentId)) ||
      typeof sourceVersion !== "number" || !Number.isSafeInteger(sourceVersion) || sourceVersion < 1) return undefined;
  return Object.freeze({ collection, documentId, sourceVersion });
}
