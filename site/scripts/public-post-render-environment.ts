import { dataHubPageEnabled } from "../src/lib/build-target.ts";
import { resolveShareUploadOrigin } from "../../packages/content-core/src/share-upload-origin";
import { isGa4MeasurementId } from "../src/lib/analytics-consent";
import { createRequire } from "node:module";
const { publicationTarget } = createRequire(import.meta.url)("../../functions/lib/publication-target.js") as typeof import("../../functions/lib/publication-target");

/** Only public rendering settings may cross the credential-free compiler boundary. */
export function publicPostRenderEnvironment(env: Record<string, string | undefined>): Record<string,string> {
  const dataHub: Record<string,string> = dataHubPageEnabled(env) ? { DATA_HUB_PUBLIC: "1" } : {};
  const target = publicationTarget(env.CMS_DEPLOYMENT_ENVIRONMENT ?? "production");
  if (env.FIREBASE_PROJECT_ID !== undefined && env.FIREBASE_PROJECT_ID !== target.projectId) {
    throw new Error("Public Post compiler target differs");
  }
  if (target.environment === "development") {
    return { ...dataHub, NODE_ENV: "production", CMS_CONTENT_MODE: "published", CMS_DEPLOYMENT_ENVIRONMENT: "development",
      PUBLIC_GA4_REQUIRED: "0", PUBLIC_REPORT_REQUIRED: "0", PUBLIC_SHARE_REQUIRED: "0" };
  }
  const sharePage = env.PUBLIC_SHARE_PAGE?.trim() === "1";
  const uploadOrigin = resolveShareUploadOrigin(env.PUBLIC_SHARE_UPLOAD_ORIGIN, sharePage);
  const measurementId = env.PUBLIC_GA4_MEASUREMENT_ID?.trim();
  const reportEndpoint = env.PUBLIC_REPORT_ENDPOINT?.trim();
  const sitekey = env.PUBLIC_TURNSTILE_SITEKEY?.trim();
  if (!isGa4MeasurementId(measurementId) || !reportEndpoint || !sitekey) {
    throw new Error("Public Post compilation requires analytics and report settings");
  }
  const report = new URL(reportEndpoint);
  const intake = new URL(env.PUBLIC_SHARE_INTAKE_ENDPOINT?.trim() || "https://intake.njpbs.org");
  if (report.protocol !== "https:" || intake.protocol !== "https:") {
    throw new Error("Public Post endpoints must use HTTPS");
  }
  return { ...dataHub, NODE_ENV: "production", CMS_CONTENT_MODE: "published", CMS_DEPLOYMENT_ENVIRONMENT: "production",
    PUBLIC_GA4_REQUIRED: "1", PUBLIC_GA4_MEASUREMENT_ID: measurementId,
    PUBLIC_REPORT_REQUIRED: "1", PUBLIC_REPORT_ENDPOINT: report.href,
    PUBLIC_TURNSTILE_SITEKEY: sitekey, PUBLIC_SHARE_REQUIRED: "1", PUBLIC_SHARE_INTAKE_ENDPOINT: intake.href,
    ...(env.PUBLIC_SHARE_UPLOAD_ORIGIN ? { PUBLIC_SHARE_UPLOAD_ORIGIN: uploadOrigin } : {}),
    ...(sharePage ? { PUBLIC_SHARE_PAGE: "1" } : {}) };
}
