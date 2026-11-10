import {
  NJ_DECIDES_SETTINGS_ID, currentCmsSettingsSchemaFor, projectPublishedCmsSettings,
  validateCmsSettingsValues, type CmsSettingsPublishedSnapshot, type NjDecidesSettingsValues,
} from "../../../packages/content-core/src/cms-settings.ts";
import { resolveNjDecidesImage, type NjDecidesAssets } from "../../../packages/content-core/src/nj-decides-brand.ts";

export interface NjDecidesBuildData extends NjDecidesSettingsValues {
  settingId: typeof NJ_DECIDES_SETTINGS_ID;
  sourceVersion: number;
  publishedAt: string;
  assets: NjDecidesAssets;
}

export function projectNjDecidesSettings(document: { id: string; [key: string]: unknown } | undefined,
  assets: ReadonlyMap<string, unknown> = new Map()):
  { status: "published"; data: NjDecidesBuildData; publishedSnapshot: CmsSettingsPublishedSnapshot }
  | { status: "missing" | "unpublished" }
  | { status: "invalid"; sourceVersion: number | null } {
  if (!document) return { status: "missing" };
  try {
    const snapshot = projectPublishedCmsSettings({ documentId: NJ_DECIDES_SETTINGS_ID, document });
    if (!snapshot) return { status: "unpublished" };
    const values = snapshot.values as unknown as NjDecidesSettingsValues;
    const selected: Record<string, NonNullable<ReturnType<typeof resolveNjDecidesImage>>> = {};
    for (const id of [values.logoAssetId, values.backgroundAssetId]) {
      const image = id ? resolveNjDecidesImage(assets.get(id)) : undefined;
      if (id && image) selected[id] = image;
    }
    return { status: "published", publishedSnapshot: snapshot, data: {
      settingId: NJ_DECIDES_SETTINGS_ID, ...values, assets: selected,
      sourceVersion: snapshot.sourceVersion, publishedAt: snapshot.publishedAt,
    } };
  } catch {
    const published = document.published as Record<string, unknown> | undefined;
    return { status: "invalid", sourceVersion: Number.isSafeInteger(published?.sourceVersion) && Number(published?.sourceVersion) > 0 ? Number(published?.sourceVersion) : null };
  }
}

export function isNjDecidesBuildData(value: unknown): value is NjDecidesBuildData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const schema = currentCmsSettingsSchemaFor(NJ_DECIDES_SETTINGS_ID)!;
  const allowed = new Set([...Object.keys(schema.fields), "settingId", "sourceVersion", "publishedAt", "assets"]);
  if (Object.keys(row).some(key => !allowed.has(key)) || row.settingId !== NJ_DECIDES_SETTINGS_ID ||
      !Number.isSafeInteger(row.sourceVersion) || Number(row.sourceVersion) < 1 || typeof row.publishedAt !== "string" ||
      Number.isNaN(Date.parse(row.publishedAt)) || new Date(row.publishedAt).toISOString() !== row.publishedAt ||
      !row.assets || typeof row.assets !== "object" || Array.isArray(row.assets)) return false;
  const values = Object.fromEntries(Object.keys(schema.fields).filter(key => row[key] !== undefined).map(key => [key, row[key]]));
  if (validateCmsSettingsValues(schema, values)) return false;
  const refs = new Set([values.logoAssetId, values.backgroundAssetId].filter(Boolean));
  return Object.entries(row.assets).every(([id, asset]) => refs.has(id) && resolveNjDecidesImage(asset) !== undefined &&
    Object.keys(asset as object).every(key => ["url", "mimeType", "width", "height"].includes(key)));
}
