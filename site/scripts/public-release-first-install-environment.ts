import protocol from '../../functions/lib/public-release-pair.js';
import { publicPostRenderEnvironment } from './public-post-render-environment';
import { firstInstallRefused as refuse } from './public-release-first-install-files';

export type FirstInstallPublicBuildSettings = {
  PUBLIC_GA4_MEASUREMENT_ID: string; PUBLIC_REPORT_ENDPOINT: string;
  PUBLIC_TURNSTILE_SITEKEY: string; PUBLIC_SHARE_INTAKE_ENDPOINT: string;
  PUBLIC_SHARE_PAGE: string; PUBLIC_SHARE_UPLOAD_ORIGIN?: string;
};
const fields = ['PUBLIC_GA4_MEASUREMENT_ID', 'PUBLIC_REPORT_ENDPOINT', 'PUBLIC_TURNSTILE_SITEKEY', 'PUBLIC_SHARE_INTAKE_ENDPOINT', 'PUBLIC_SHARE_PAGE'] as const;

/** Use the normal production compiler's public-setting checks and allowlist.
 * No ambient environment, credential or caller-supplied requirement flag. */
export function firstInstallBuildEnvironment(environment: 'development' | 'production', settings?: FirstInstallPublicBuildSettings) {
  if (environment === 'production') {
    const hasUploadOrigin = Object.hasOwn(settings ?? {}, 'PUBLIC_SHARE_UPLOAD_ORIGIN');
    protocol.exact(settings, [...fields, ...(hasUploadOrigin ? ['PUBLIC_SHARE_UPLOAD_ORIGIN'] : [])]);
    if (fields.some(key => typeof settings?.[key] !== 'string' || !settings[key].trim() || settings[key].length > 2048 || /[\r\n]/.test(settings[key]))) refuse();
    if (!['0', '1'].includes(settings!.PUBLIC_SHARE_PAGE)) refuse();
    const uploadOrigin = settings?.PUBLIC_SHARE_UPLOAD_ORIGIN;
    if (hasUploadOrigin && (typeof uploadOrigin !== 'string' || uploadOrigin.length > 2048 || /[\r\n]/.test(uploadOrigin))) refuse();
  } else if (environment !== 'development' || settings !== undefined) refuse();
  return publicPostRenderEnvironment({ ...settings, CMS_DEPLOYMENT_ENVIRONMENT: environment, DATA_HUB_PUBLIC: '1' });
}

export function firstInstallImageBuildArgs(environment: 'development' | 'production', settings?: FirstInstallPublicBuildSettings) {
  const checked = firstInstallBuildEnvironment(environment, settings);
  return { CMS_DEPLOYMENT_ENVIRONMENT: environment,
    ...(environment === 'production' ? Object.fromEntries(fields.map(key => [key, key === 'PUBLIC_SHARE_PAGE' ? settings![key] : checked[key]])) : {}),
    ...(checked.PUBLIC_SHARE_UPLOAD_ORIGIN ? { PUBLIC_SHARE_UPLOAD_ORIGIN: checked.PUBLIC_SHARE_UPLOAD_ORIGIN } : {}) };
}
