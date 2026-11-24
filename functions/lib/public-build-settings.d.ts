export interface PublicBuildValues {
  PUBLIC_GA4_MEASUREMENT_ID: string;
  PUBLIC_REPORT_ENDPOINT: string;
  PUBLIC_SHARE_INTAKE_ENDPOINT: string;
  PUBLIC_TURNSTILE_SITEKEY: string;
}
export interface PublicBuildSettings {
  schemaVersion: 1;
  commitSha: string;
  /** Present only for a development receipt, whose values are empty. */
  environment?: "development";
  values: PublicBuildValues | Record<string, never>;
  overridesAbsent: boolean;
}
export function createPublicBuildSettings(commitSha: string, compilerEnvironment: Record<string, string | undefined>,
  requestedEnvironment: Record<string, string | undefined>): PublicBuildSettings;
export function assertPreparedPublicBuildSettings(value: unknown, commitSha: string,
  expectedValues?: PublicBuildSettings["values"]): PublicBuildSettings;
