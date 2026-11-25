// The CMS deploy target that the cms-staging-deploy `target` input selects
// through CMS_TARGET. Production and development share one Cloudflare account,
// and a Workers token can edit every Worker in it, so this record is the guard:
// a development target names only dev resources. Dev names come from the
// CMS_DEV_* variables the workflow sets for a development run only.
export class CmsTargetError extends Error { name = "CmsTargetError"; }

const PRODUCTION = Object.freeze({
  environment: "production",
  projectId: "njpbs-site",
  codebase: "default",
  firebaseConfig: "firebase.json",
  deploymentConfig: "config/functions-deployment.json",
  adminOrigin: "https://admin.njpbs.org",
  publicOrigin: "https://njpbs.org",
  mediaOrigin: "https://media.njpbs.org",
  cmsApiWorker: "njpbs-cms-api",
  rendererWorker: "njpbs-cms-preview-renderer",
  adminPages: "njpbs-admin",
});
const PRODUCTION_NAMES = new Set([PRODUCTION.cmsApiWorker, PRODUCTION.rendererWorker, PRODUCTION.adminPages,
  "njpbs-production", "njpbs-cms-publisher", "njpbs-media", "njpbs-cms-previews", "njpbs-cms-publication"]);

// A dev Cloudflare name carries a `dev` segment; a dev hostname starts with a `dev` label.
export function isDevelopmentName(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(value)
    && value.split("-").includes("dev") && !PRODUCTION_NAMES.has(value);
}
export function isDevelopmentHostname(value) {
  const first = typeof value === "string" ? value.toLowerCase().split(".")[0] : "";
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value ?? "") && (first === "dev" || first.startsWith("dev-"));
}

export function devName(env, key) {
  // config-input: CMS_DEV_API_WORKER, CMS_DEV_PREVIEW_RENDERER, CMS_DEV_ADMIN_PAGES, CMS_DEV_STUDIO_BUCKET, CMS_DEV_MEDIA_BUCKET, CMS_DEV_PREVIEW_BUCKET
  // config-input: CMS_DEV_PREVIEW_STAFF_WORKER, CMS_DEV_PREVIEW_WORKER, CMS_DEV_SITE_PAGES, CLOUDFLARE_DEV_PUBLIC_WORKER
  const value = env[key]?.trim();
  if (!isDevelopmentName(value)) throw new CmsTargetError(`${key} must name a development resource`);
  return value;
}
export function devOrigin(env, key) {
  // config-input: CMS_DEV_ADMIN_ORIGIN, CMS_DEV_API_ORIGIN, CMS_DEV_PUBLIC_ORIGIN, CMS_DEV_MEDIA_ORIGIN, CMS_DEV_PREVIEW_ORIGIN
  const value = env[key]?.trim() ?? "";
  let url;
  try { url = new URL(value); } catch { throw new CmsTargetError(`${key} must be a development origin`); }
  if (url.protocol !== "https:" || url.origin !== value || !isDevelopmentHostname(url.hostname)) {
    throw new CmsTargetError(`${key} must be a development origin`);
  }
  return url.origin;
}

export function cmsTarget(env = process.env) {
  const environment = env.CMS_TARGET || "production";
  if (environment === "production") {
    return Object.freeze({ ...PRODUCTION, apiOrigin: env.CMS_PRODUCTION_API_ORIGIN || "",
      functionsOrigin: `https://us-central1-${PRODUCTION.projectId}.cloudfunctions.net` });
  }
  if (environment !== "development") throw new CmsTargetError("CMS_TARGET must be production or development");
  return Object.freeze({
    environment,
    projectId: "njpbs-site-dev",
    codebase: "dev",
    firebaseConfig: "firebase.dev.json",
    deploymentConfig: "config/functions-deployment.development.json",
    adminOrigin: devOrigin(env, "CMS_DEV_ADMIN_ORIGIN"),
    apiOrigin: devOrigin(env, "CMS_DEV_API_ORIGIN"),
    publicOrigin: devOrigin(env, "CMS_DEV_PUBLIC_ORIGIN"),
    mediaOrigin: devOrigin(env, "CMS_DEV_MEDIA_ORIGIN"),
    functionsOrigin: "https://us-central1-njpbs-site-dev.cloudfunctions.net",
    cmsApiWorker: devName(env, "CMS_DEV_API_WORKER"),
    rendererWorker: devName(env, "CMS_DEV_PREVIEW_RENDERER"),
    adminPages: devName(env, "CMS_DEV_ADMIN_PAGES"),
  });
}

// Wrangler deploys whatever a config names. Before a development deploy, the
// rendered config must name the target Worker, route only dev hostnames and
// bind only dev services and buckets.
export function assertDevelopmentWorkerConfig(config, { name, hostnames }) {
  const routes = [...(config?.routes ?? []), ...(config?.route ? [config.route] : [])];
  const bound = [...(config?.services ?? []).map(binding => binding?.service),
    ...(config?.r2_buckets ?? []).map(binding => binding?.bucket_name)];
  if (!config || config.name !== name || !isDevelopmentName(name) || config.workers_dev !== false ||
      routes.some(route => !hostnames.includes(typeof route === "string" ? route : route?.pattern)) ||
      hostnames.some(host => !isDevelopmentHostname(host)) || bound.some(value => !isDevelopmentName(value)) ||
      config.vars?.FIREBASE_PROJECT_ID !== undefined && config.vars.FIREBASE_PROJECT_ID !== "njpbs-site-dev") {
    throw new CmsTargetError("The development Worker config names a production resource");
  }
  return config;
}

// Pages takes no --config: it deploys whatever admin/wrangler.jsonc names, and
// Pages bindings replace the project's own. A development upload may name only
// its own project and the dev CMS API; any other key or name stops it.
export function assertDevelopmentPagesConfig(config, { adminPages, cmsApiWorker }) {
  const service = config?.services?.[0];
  if (!config || Object.keys(config).sort().join() !== "compatibility_date,name,pages_build_output_dir,services" ||
      config.name !== adminPages || !isDevelopmentName(adminPages) || config.pages_build_output_dir !== "./dist" ||
      config.services.length !== 1 || Object.keys(service).sort().join() !== "binding,entrypoint,service" ||
      service.binding !== "STAFF_ACCESS" || service.service !== cmsApiWorker || !isDevelopmentName(cmsApiWorker) ||
      service.entrypoint !== "StaffSiteEntrypoint") {
    throw new CmsTargetError("The development Admin Pages config names a production resource");
  }
  return config;
}
