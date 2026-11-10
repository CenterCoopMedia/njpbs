import {
  DEFAULT_NJ_DECIDES_SETTINGS, NJ_DECIDES_SETTINGS_ID,
  currentCmsSettingsSchemaFor, relativeLuminance, validateCmsSettingsValues,
  type NjDecidesSettingsValues,
} from "./cms-settings.ts";
import { NJ_DECIDES_LOGO } from "./nj-decides.ts";
import { safeHref } from "./safe-href.ts";

export interface NjDecidesImageAsset {
  url: string;
  mimeType: string;
  width?: number;
  height?: number;
}
export type NjDecidesAssets = Readonly<Record<string, NjDecidesImageAsset>>;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Invalid legacy settings and unavailable media render the approved defaults. */
export function resolveNjDecidesBrand(value?: unknown, assets: NjDecidesAssets = {}) {
  const schema = currentCmsSettingsSchemaFor(NJ_DECIDES_SETTINGS_ID)!;
  const candidate = object(value) ? Object.fromEntries(Object.keys(schema.fields)
    .filter(key => value[key] !== undefined).map(key => [key, value[key]])) : null;
  const values: NjDecidesSettingsValues = candidate && !validateCmsSettingsValues(schema, candidate)
    ? candidate as unknown as NjDecidesSettingsValues : DEFAULT_NJ_DECIDES_SETTINGS;
  const storedAssets = object(value) && object(value.assets) ? value.assets : assets;
  const logo = resolveNjDecidesImage(values.logoAssetId ? storedAssets[values.logoAssetId] : undefined);
  const background = resolveNjDecidesImage(values.backgroundAssetId ? storedAssets[values.backgroundAssetId] : undefined);
  const reversed = relativeLuminance(values.backgroundColor) < 0.179;
  return {
    values,
    dark: reversed,
    logo: logo ? { ...logo, alt: values.logoAlt! } : {
      url: reversed ? NJ_DECIDES_LOGO.reversedSrc : NJ_DECIDES_LOGO.src,
      width: NJ_DECIDES_LOGO.width, height: NJ_DECIDES_LOGO.height, alt: NJ_DECIDES_LOGO.alt,
    },
    background,
  };
}

export function resolveNjDecidesImage(value: unknown): (NjDecidesImageAsset & { width: number; height: number }) | undefined {
  if (!object(value) || typeof value.url !== "string" ||
      !["image/png", "image/jpeg", "image/webp"].includes(String(value.mimeType)) ||
      !Number.isSafeInteger(value.width) || Number(value.width) < 1 ||
      !Number.isSafeInteger(value.height) || Number(value.height) < 1 ||
      Number(value.width) * Number(value.height) > 100_000_000) return undefined;
  try {
    if (safeHref(value.url) !== value.url || (!/^\/(?!\/)/.test(value.url) && new URL(value.url).protocol !== "https:")) return undefined;
  } catch { return undefined; }
  return { url: value.url, mimeType: String(value.mimeType), width: Number(value.width), height: Number(value.height) };
}
