// Public values only, deliberately synthetic destinations.
export const publicBuildSettings = {
  PUBLIC_GA4_MEASUREMENT_ID: 'G-ABCDEFG123', PUBLIC_REPORT_ENDPOINT: 'https://reports.example.test/submit',
  PUBLIC_TURNSTILE_SITEKEY: 'synthetic-public-sitekey', PUBLIC_SHARE_INTAKE_ENDPOINT: 'https://intake.example.test/',
  PUBLIC_SHARE_UPLOAD_ORIGIN: 'https://uploads.example.test', PUBLIC_SHARE_PAGE: '1',
};
export const imageBuildEnvironment = { ...publicBuildSettings, DATA_HUB_PUBLIC: '1', NODE_ENV: 'production', CMS_CONTENT_MODE: 'published',
  CMS_DEPLOYMENT_ENVIRONMENT: 'production', PUBLIC_GA4_REQUIRED: '1', PUBLIC_REPORT_REQUIRED: '1', PUBLIC_SHARE_REQUIRED: '1' };
