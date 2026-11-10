// Resolves the stored public-site chrome setting into the header newsletter
// action. The public layout calls this module directly, so it stays free of
// build-loader imports and renders the same way in the static build and in the
// compiled preview renderer.

import {
  DEFAULT_PUBLIC_SITE_CHROME_SETTINGS,
  PUBLIC_SITE_CHROME_SETTINGS_ID,
  cmsSettingsSchemaFor,
  validateCmsSettingsValues,
  type PublicSiteChromeSettingsValues,
} from "./cms-settings.ts";

export interface PublicSiteChromeNewsletter {
  readonly enabled: boolean;
  readonly label: string;
  readonly href: string;
  readonly opensInNewTab: boolean;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return the four stored values when they pass the current schema, or null. */
export function validPublicSiteChromeValues(value: unknown): PublicSiteChromeSettingsValues | null {
  if (!plainObject(value)) return null;
  const values = {
    newsletterEnabled: value.newsletterEnabled,
    newsletterLabel: value.newsletterLabel,
    newsletterHref: value.newsletterHref,
    newsletterOpensInNewTab: value.newsletterOpensInNewTab,
  };
  const schema = cmsSettingsSchemaFor(PUBLIC_SITE_CHROME_SETTINGS_ID, 1);
  if (!schema || validateCmsSettingsValues(schema, values) !== null) return null;
  return values as PublicSiteChromeSettingsValues;
}

/**
 * Resolve the header newsletter action from a stored or projected setting.
 *
 * An absent or invalid value renders the source default. The Kids-page
 * exclusion stays with the layout.
 */
export function resolvePublicSiteChromeNewsletter(value: unknown): PublicSiteChromeNewsletter {
  const values = validPublicSiteChromeValues(value) ?? DEFAULT_PUBLIC_SITE_CHROME_SETTINGS;
  return {
    enabled: values.newsletterEnabled,
    label: values.newsletterLabel,
    href: values.newsletterHref,
    opensInNewTab: values.newsletterOpensInNewTab && /^https?:\/\//i.test(values.newsletterHref),
  };
}
