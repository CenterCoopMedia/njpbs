// Build-target gates for root public pages, CMS routes and internal surfaces.
//
// PUBLIC_ONLY restricts the build to its landing page. When set, public root
// dynamic routes emit zero pages.
//
// CMS-derived Post, Program, Event and author routes have a second deployment gate.
// Ordinary credentialed builds may render them. A reserved artifact build may
// render them only from the validated v3 cutoff bundle. PUBLIC_ONLY and the
// unsupported production Workers lane stay closed.
//
// Maintainer-only surfaces require the explicit INTERNAL_SURFACES opt-in.
// PUBLIC_ONLY suppresses these routes even when INTERNAL_SURFACES is truthy.
//
// The public OKF wiki (/wiki/) is governed independently of these gates.

const TRUTHY = new Set(["1", "true", "yes", "on"]);

type Env = Record<string, string | undefined>;

export function isPublicOnlyBuild(env: Env = {}): boolean {
  return TRUTHY.has((env.PUBLIC_ONLY ?? "").trim().toLowerCase());
}

export function publicRootRoutesEnabled(env: Env = {}): boolean {
  return !isPublicOnlyBuild(env);
}

/**
 * The /share/ submission page requires the explicit PUBLIC_SHARE_PAGE switch.
 */
export function sharePageEnabled(env: Env = {}): boolean {
  return publicRootRoutesEnabled(env) && TRUTHY.has((env.PUBLIC_SHARE_PAGE ?? "").trim().toLowerCase());
}

/** The Data Hub route requires the public publication build flag. */
export function dataHubPageEnabled(env: Env = {}): boolean {
  return publicRootRoutesEnabled(env) && TRUTHY.has((env.DATA_HUB_PUBLIC ?? "").trim().toLowerCase());
}

/**
 * Whether open-set CMS routes may be emitted by this build.
 *
 * A public-artifact build is fail-closed unless its v3 bundle includes those
 * exact snapshots and media owners. Testing and non-deploy credentialed builds
 * remain available without a bundle.
 */
export function cmsRoutedContentEnabled(env: Env = {}): boolean {
  if (!publicRootRoutesEnabled(env)) return false;
  if (env.WORKERS_CI === "1") return false;
  const buildBatchId = (env.PUBLIC_BUILD_BATCH_ID ?? "").trim();
  if (buildBatchId === "") return true;
  return (
    (env.PUBLIC_ARTIFACT_BUNDLE_PATH ?? "").trim() !== "" &&
    (env.PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION ?? "").trim() === "3"
  );
}

export function internalSurfaceRoutesEnabled(env: Env = {}): boolean {
  return (
    !isPublicOnlyBuild(env) &&
    TRUTHY.has((env.INTERNAL_SURFACES ?? "").trim().toLowerCase())
  );
}
