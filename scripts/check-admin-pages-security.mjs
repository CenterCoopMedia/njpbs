#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const PROJECT_NAME = "njpbs-admin";
const EXPECTED_BINDING = {
  name: "STAFF_ACCESS",
  service: "njpbs-cms-api",
  entrypoint: "StaffSiteEntrypoint",
};
const EXPECTED_GUIDE_VIDEOS = {
  name: "GUIDE_VIDEOS",
  bucket: "njpbs-admin-guide",
};
const GUIDE_ROUTE = "/*";
const GUIDE_PROBES = [
  { path: "/guide-content/manifest.json", status: 401 },
  { path: "/guide-content/resources/nj-politics.json", status: 401 },
  { path: "/guide-content/resources%2fnj-politics.json" },
  { path: "/%67uide-content/resources/nj-politics.json" },
  { path: "/guide-content/resources/nj-election-2026.json", status: 401 },
  { path: "/guide-content/resources%2fnj-election-2026.json" },
  { path: "/%67uide-content/resources/nj-election-2026.json" },
  { path: "/guide-content/search.json", status: 401 },
  { path: "/guide-content/pages/overview.md", status: 401 },
  { path: "/guide-content/images/home.webp", status: 401 },
  { path: "/guide-content/videos/shared-video-library.mp4", status: 401 },
  { path: "/guide-content/videos/shared-video-library.jpg", status: 401 },
  { path: "/guide-content/videos/shared-video-library.vtt", status: 401 },
  { path: "/guide-content/videos/shared-video-library.txt", status: 401 },
  { path: "/guide-content/%6danifest.json" },
  { path: "/guide-content//manifest.json" },
  { path: "/guide-content/pages%2foverview.md" },
  { path: "/guide-content%2fimages%2fhome.webp" },
  { path: "/%67uide-content/manifest.json" },
  { path: "/%67uide-content/%zzmanifest.json" },
];
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

function r2Bindings(config) {
  const buckets = config?.r2_buckets;
  if (Array.isArray(buckets)) {
    return buckets.map((binding) => ({
      name: binding?.binding,
      bucket: binding?.bucket_name,
    }));
  }
  if (!buckets || typeof buckets !== "object") return [];
  return Object.entries(buckets).map(([name, binding]) => ({
    name,
    bucket: typeof binding === "string" ? binding : binding?.bucket_name ?? binding?.name,
  }));
}

function serviceBindings(config) {
  const services = config?.services;
  if (Array.isArray(services)) {
    return services.map((binding) => ({ name: binding?.binding, ...binding }));
  }
  if (!services || typeof services !== "object") return [];
  return Object.entries(services).map(([name, binding]) => ({ name, ...binding }));
}

export function adminPagesSecurityErrors(project, { requireBinding = false } = {}) {
  const errors = [];
  for (const environment of ["production", "preview"]) {
    const config = project?.deployment_configs?.[environment];
    if (config?.fail_open !== false) {
      errors.push(`${environment} Pages Functions must use fail closed`);
    }
    if (!requireBinding) continue;

    const binding = serviceBindings(config).find(
      (candidate) => candidate.name === EXPECTED_BINDING.name,
    );
    if (
      binding?.service !== EXPECTED_BINDING.service ||
      binding?.entrypoint !== EXPECTED_BINDING.entrypoint
    ) {
      errors.push(
        `${environment} ${EXPECTED_BINDING.name} must bind to ` +
          `${EXPECTED_BINDING.service}:${EXPECTED_BINDING.entrypoint}`,
      );
    }
    const videos = r2Bindings(config).find(
      (candidate) => candidate.name === EXPECTED_GUIDE_VIDEOS.name,
    );
    if (videos?.bucket !== EXPECTED_GUIDE_VIDEOS.bucket) {
      errors.push(
        `${environment} ${EXPECTED_GUIDE_VIDEOS.name} must bind to ${EXPECTED_GUIDE_VIDEOS.bucket}`,
      );
    }
  }
  return errors;
}

export function adminPagesRoutesErrors(routes) {
  const errors = [];
  if (routes?.version !== 1) errors.push("Admin Pages routes must use version 1");
  if (!Array.isArray(routes?.include) || !routes.include.includes(GUIDE_ROUTE)) {
    errors.push(`Admin Pages routes must include ${GUIDE_ROUTE} for guide URL aliases`);
  }
  if (!Array.isArray(routes?.exclude) || routes.exclude.length !== 0) {
    errors.push("Admin Pages routes must not exclude protected guide paths");
  }
  return errors;
}

export function guideVideoExposureErrors(managed, customDomains) {
  const errors = [];
  const domains = Array.isArray(customDomains) ? customDomains : customDomains?.domains;
  if (typeof managed?.enabled !== "boolean" || !Array.isArray(domains)) {
    return ["Guide video bucket privacy metadata is invalid"];
  }
  if (managed?.enabled === true) {
    errors.push("njpbs-admin-guide must not enable its r2.dev domain");
  }
  if (domains.some((domain) => !domain || domain.enabled !== false)) {
    errors.push("njpbs-admin-guide must not have a public custom domain");
  }
  return errors;
}

export function guideProbeError(pathname, status, expectedStatus) {
  if (expectedStatus !== undefined) {
    return status === expectedStatus
      ? null
      : `${pathname} returned ${status}; expected ${expectedStatus}`;
  }
  return status >= 400 && status < 500
    ? null
    : `${pathname} returned ${status}; expected a client error`;
}

async function cloudflareRequest(token, path) {
  const response = await fetch(`${CLOUDFLARE_API}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.success !== true) {
    const details = Array.isArray(body?.errors)
      ? body.errors.map((error) => error?.message).filter(Boolean).join("; ")
      : "";
    throw new Error(
      `Cloudflare Pages check failed (${response.status})${details ? `: ${details}` : ""}`,
    );
  }
  return body.result;
}

async function loadAdminProject(token) {
  const accounts = await cloudflareRequest(token, "/accounts?per_page=100");
  const matches = [];
  for (const account of accounts) {
    const response = await fetch(
      `${CLOUDFLARE_API}/accounts/${account.id}/pages/projects/${PROJECT_NAME}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (response.status === 404) continue;
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.success !== true) {
      throw new Error(`Cloudflare Pages project check failed (${response.status})`);
    }
    matches.push({ project: body.result, accountId: account.id });
  }
  if (matches.length !== 1) {
    throw new Error(`Expected one ${PROJECT_NAME} Pages project; found ${matches.length}`);
  }
  return matches[0];
}

async function assertGuideVideoBucketPrivate(token, accountId) {
  const bucket = EXPECTED_GUIDE_VIDEOS.bucket;
  const managed = await cloudflareRequest(
    token,
    `/accounts/${accountId}/r2/buckets/${bucket}/domains/managed`,
  );
  const custom = await cloudflareRequest(
    token,
    `/accounts/${accountId}/r2/buckets/${bucket}/domains/custom`,
  );
  const errors = guideVideoExposureErrors(managed, custom);
  if (errors.length > 0) throw new Error(errors.join("; "));
}

async function loadRoutes() {
  const source = await readFile(`${REPO_ROOT}admin/dist/_routes.json`, "utf8");
  return JSON.parse(source);
}

async function probeGuideHost(origin, { optional = false } = {}) {
  let reachable = false;
  for (const probe of GUIDE_PROBES) {
    let response;
    try {
      response = await fetch(new URL(probe.path, origin), {
        cache: "no-store",
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      if (optional && !reachable) {
        console.warn(`Admin Pages guide probe skipped unreachable ${origin}: ${error.message}`);
        return;
      }
      throw error;
    }
    reachable = true;
    const error = guideProbeError(probe.path, response.status, probe.status);
    if (error) throw new Error(`Admin Pages guide probe failed for ${origin}: ${error}`);
  }
  console.log(`Admin Pages guide boundary: unauthenticated probes passed for ${origin}.`);
}

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is required");
  const requireBinding = process.argv[2] === "postdeploy";
  if (process.argv[2] !== "predeploy" && !requireBinding) {
    throw new Error("Use predeploy or postdeploy");
  }

  const loaded = await loadAdminProject(token);
  const project = loaded.project;
  const errors = adminPagesSecurityErrors(project, { requireBinding });
  if (errors.length > 0) throw new Error(errors.join("; "));
  if (requireBinding) {
    await assertGuideVideoBucketPrivate(token, loaded.accountId);
    const routeErrors = adminPagesRoutesErrors(await loadRoutes());
    if (routeErrors.length > 0) throw new Error(routeErrors.join("; "));
    await probeGuideHost("https://admin.njpbs.org");
    if (typeof project.subdomain === "string" && project.subdomain.endsWith(".pages.dev")) {
      await probeGuideHost(`https://${project.subdomain}`, { optional: true });
    }
  }
  console.log(
    requireBinding
      ? "Admin Pages guide boundary: fail closed with the staff admission binding."
      : "Admin Pages guide boundary: fail closed.",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  });
}
