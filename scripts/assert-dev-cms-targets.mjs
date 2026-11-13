import { repositoryMatches } from "./lib/repository-identity.mjs";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import devReaders from "../functions/lib/dev-reader-deployment.js";

export const DEV_TARGETS = Object.freeze({
  FIREBASE_PROJECT_ID: "njpbs-site-dev",
  FIREBASE_WEB_APP_ID: (process.env.CMS_DEV_FIREBASE_WEB_APP_ID ?? ""),
  CMS_API_WORKER: "template-dev-cms-api",
  CMS_PREVIEW_WORKER: "template-dev-cms-preview",
  CMS_PREVIEW_RENDERER: "template-dev-cms-preview-renderer",
  CMS_PREVIEW_STAFF_WORKER: "template-dev-preview-staff-sites",
  CMS_SITE_PAGES: "template-dev",
  CMS_ADMIN_PAGES: "template-dev-admin",
  CMS_MEDIA_BUCKET: "template-dev-media",
  CMS_PREVIEW_BUCKET: "template-dev-cms-previews",
  CMS_ADMIN_ORIGIN: "https://dev-admin.example.org",
  CMS_API_ORIGIN: "https://dev-api.example.org",
  CMS_PREVIEW_ORIGIN: "https://dev-preview.example.org",
  CMS_SITE_ORIGIN: "https://dev-public.example.org",
  CMS_MEDIA_ORIGIN: "https://dev-media.example.org",
  FUNCTIONS_ORIGIN: "https://us-central1-njpbs-site-dev.cloudfunctions.net",
  CMS_DEPLOYMENT_ENVIRONMENT: "development",
  CLOUDFLARE_ACCOUNT_ID: (process.env.CMS_DEV_CLOUDFLARE_ACCOUNT_ID ?? ""),
  CMS_ADMIN_PAGES_BRANCH: "main",
});

export function assertDevTargets(actual) {
  const failures = [];
  if (!/^1:[0-9]+:web:[a-f0-9]+$/.test(DEV_TARGETS.FIREBASE_WEB_APP_ID)) failures.push("FIREBASE_WEB_APP_ID");
  if (!/^[a-f0-9]{32}$/.test(DEV_TARGETS.CLOUDFLARE_ACCOUNT_ID)) failures.push("CLOUDFLARE_ACCOUNT_ID");
  for (const [key, expected] of Object.entries(DEV_TARGETS)) {
    if (!expected || actual[key] !== expected) failures.push(key);
  }
  if (failures.length) throw new Error(`Dev target tuple refused: ${failures.join(", ")}`);
  return true;
}

// The deploy workflow appends these after rendering; the tracked file holds no identity literal.
export function devPublicationIdentity(env) {
  const identity = { CMS_PUBLISH_GITHUB_REPOSITORY: env.CANONICAL_GITHUB_REPOSITORY,
    CMS_PUBLISH_GITHUB_APP_ID: env.CMS_PUBLISH_GITHUB_APP_ID, CMS_PUBLISH_GITHUB_INSTALLATION_ID: env.CMS_PUBLISH_GITHUB_INSTALLATION_ID };
  if (!repositoryMatches(identity.CMS_PUBLISH_GITHUB_REPOSITORY, env) ||
      ![identity.CMS_PUBLISH_GITHUB_APP_ID, identity.CMS_PUBLISH_GITHUB_INSTALLATION_ID].every(id => /^[1-9][0-9]*$/.test(id ?? ""))) {
    throw new Error("Dev publication identity refused");
  }
  return identity;
}

export function assertDevConfigs(root = new URL("../", import.meta.url), deploymentEnv = process.env) {
  const api = JSON.parse(readFileSync(new URL("cms-api/wrangler.dev.jsonc", root), "utf8"));
  const renderer = JSON.parse(readFileSync(new URL("preview-renderer/wrangler.dev.jsonc", root), "utf8"));
  const staffPreview = JSON.parse(readFileSync(new URL("workers/wrangler.staff-preview.dev.jsonc", root), "utf8"));
  const gateway = JSON.parse(readFileSync(new URL("workers/wrangler.preview.dev.jsonc", root), "utf8")
    .replace(/^\s*\/\/.*$/gm, ""));
  const firebase = JSON.parse(readFileSync(new URL("firebase.dev.json", root), "utf8"));
  const env = readFileSync(new URL("functions/.env.njpbs-site-dev", root), "utf8");
  const functionVars = Object.fromEntries(env.split(/\r?\n/)
    .filter(line => line && !line.startsWith("#"))
    .map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  // Every stage checks the configured identity. Before the deploy step appends it,
  // the file holds none of it; afterwards it holds exactly these values.
  const identity = devPublicationIdentity(deploymentEnv);
  const appended = Object.keys(identity).filter(key => Object.hasOwn(functionVars, key));
  const identityRefused = appended.length !== 0 && (appended.length !== Object.keys(identity).length ||
    appended.some(key => functionVars[key] !== identity[key]));
  const readerVars = deploymentEnv.CMS_READER_BRIDGE_ENABLED === "true" && deploymentEnv.CMS_DEV_INSTALL_READER_BRIDGE !== "true"
    ? devReaders.devReaderUpdateDeployment(deploymentEnv) : devReaders.devReaderDeployment(deploymentEnv);
  for (const key of ["CMS_READER_BRIDGE_ENABLED", "CMS_READER_BRIDGE_OPERATION_ID",
    "CMS_READER_BRIDGE_FUNCTIONS_CANDIDATE", "CMS_READER_BRIDGE_CMS_API_CANDIDATE"]) {
    if ((functionVars[key] ?? "") !== (readerVars[key] ?? "") || (api.vars?.[key] ?? "") !== (readerVars[key] ?? "")) {
      throw new Error("Dev reader deployment config refused");
    }
  }
  for (const key of ["PUBLIC_RELEASE_READERS_ENABLED", "PUBLIC_RELEASE_COMPOSED_READERS_ENABLED"]) {
    if (functionVars[key] !== readerVars[key]) throw new Error("Dev public reader deployment config refused");
  }
  if (api.name !== DEV_TARGETS.CMS_API_WORKER ||
      api.services?.length !== 1 || api.services[0].binding !== "PREVIEW_RENDERER" ||
      api.services[0].service !== DEV_TARGETS.CMS_PREVIEW_RENDERER || api.services[0].entrypoint !== undefined ||
      api.vars?.FIREBASE_PROJECT_ID !== DEV_TARGETS.FIREBASE_PROJECT_ID ||
      api.vars?.FUNCTIONS_ORIGIN !== DEV_TARGETS.FUNCTIONS_ORIGIN ||
      api.vars?.ADMIN_ORIGIN !== DEV_TARGETS.CMS_ADMIN_ORIGIN ||
      api.vars?.CMS_DEPLOYMENT_ENVIRONMENT !== "development" ||
      api.vars?.CMS_DEV_REPORT_INTAKE_MODE !== "stored-only" ||
      api.workers_dev !== false || api.preview_urls !== false ||
      api.routes?.[0]?.pattern !== new URL(DEV_TARGETS.CMS_API_ORIGIN).hostname ||
      renderer.name !== DEV_TARGETS.CMS_PREVIEW_RENDERER ||
      renderer.containers?.[0]?.name !== DEV_TARGETS.CMS_PREVIEW_RENDERER ||
      renderer.vars?.CMS_DEPLOYMENT_ENVIRONMENT !== "development" ||
      renderer.vars?.FIREBASE_PROJECT_ID !== DEV_TARGETS.FIREBASE_PROJECT_ID ||
      renderer.vars?.PREVIEW_RENDERER_ENABLED !== "false" ||
      !["CMS_DEV_ACCESS_CLIENT_ID", "CMS_DEV_ACCESS_CLIENT_SECRET"]
        .every(name => renderer.secrets?.required?.includes(name)) ||
      renderer.workers_dev !== false || renderer.preview_urls !== false ||
      gateway.name !== DEV_TARGETS.CMS_PREVIEW_WORKER ||
      gateway.r2_buckets?.[0]?.bucket_name !== DEV_TARGETS.CMS_PREVIEW_BUCKET ||
      gateway.routes !== undefined || gateway.route !== undefined ||
      gateway.workers_dev !== false || gateway.preview_urls !== false ||
      staffPreview.name !== DEV_TARGETS.CMS_PREVIEW_STAFF_WORKER ||
      staffPreview.main !== "src/dev-preview-staff-worker.ts" ||
      staffPreview.workers_dev !== false || staffPreview.preview_urls !== false ||
      staffPreview.routes?.length !== 1 ||
      staffPreview.routes[0].pattern !== new URL(DEV_TARGETS.CMS_PREVIEW_ORIGIN).hostname ||
      staffPreview.routes[0].custom_domain !== true ||
      staffPreview.services?.length !== 2 ||
      !staffPreview.services.some(binding => binding.binding === "DEV_STAFF_ACCESS" &&
        binding.service === DEV_TARGETS.CMS_API_WORKER && binding.entrypoint === "StaffSiteEntrypoint") ||
      !staffPreview.services.some(binding => binding.binding === "DEV_PREVIEW" &&
        binding.service === DEV_TARGETS.CMS_PREVIEW_WORKER && binding.entrypoint === undefined) ||
      firebase.functions?.source !== "functions" ||
      firebase.functions?.codebase !== "dev" ||
      firebase.firestore?.rules !== "firestore.rules" ||
      firebase.firestore?.indexes !== "firestore.indexes.json" ||
      functionVars.CMS_DEPLOYMENT_ENVIRONMENT !== "development" ||
      functionVars.CMS_DEV_REPORT_INTAKE_MODE !== "stored-only" ||
      functionVars.CMS_WRITEBACK_CONFIGURED !== "true" ||
      !((functionVars.CMS_PREVIEW_SERIALIZER_READY === "false" && functionVars.CMS_PREVIEW_RENDERER_SHA === "") ||
        (functionVars.CMS_PREVIEW_SERIALIZER_READY === "true" && /^[a-f0-9]{40}$/.test(deploymentEnv.CMS_DEV_RENDERER_SOURCE_SHA ?? "") &&
          functionVars.CMS_PREVIEW_RENDERER_SHA === deploymentEnv.CMS_DEV_RENDERER_SOURCE_SHA)) ||
      functionVars.CMS_MEDIA_R2_BUCKET !== DEV_TARGETS.CMS_MEDIA_BUCKET ||
      functionVars.CMS_MEDIA_PUBLIC_ORIGIN !== DEV_TARGETS.CMS_MEDIA_ORIGIN ||
      identityRefused ||
      Object.entries(functionVars).some(([name, value]) => name !== "CMS_PUBLISH_GITHUB_REPOSITORY" &&
        /(^|[^a-z])njpbs-site(?!-dev)|https:\/\/(?:admin|preview|media|cms-api)\.njpbs\.org/.test(value))) {
    throw new Error("Dev deployment config refused");
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertDevTargets(process.env);
  assertDevConfigs();
  process.stdout.write("Dev target tuple verified\n");
}
