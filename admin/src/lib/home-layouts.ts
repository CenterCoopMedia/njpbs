import { editorFieldsForBlock, type EditorField } from "../../../packages/content-core/src/editor-admin";
import type { BlockType } from "../../../packages/content-core/src/content-model";

// Keep production writers compatible until the public site includes #2922.
export function homeLayoutsEnabled(): boolean {
  return import.meta.env.VITE_CMS_HOME_LAYOUTS_ENABLED !== "false";
}

const PRODUCTION_SHELF_ITEM_LIMITS = [4, 8, 12, 16, 24];

export function adminFieldsForBlock(type: BlockType): EditorField[] {
  const fields = editorFieldsForBlock(type);
  if (type !== "content_shelf" || homeLayoutsEnabled()) return fields;
  return fields
    .filter(field => field.key !== "presentation" && field.key !== "columns")
    .map(field => field.key === "itemLimit" ? {
      ...field,
      options: field.options?.filter(option => PRODUCTION_SHELF_ITEM_LIMITS.includes(Number(option.value))),
    } : field);
}
