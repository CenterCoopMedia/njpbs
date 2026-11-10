// The build revision an Admin performance receipt is attributed to (#1064).
//
// Deliberately not an environment read. `import.meta.env.KEY` is replaced per key by Vite, but
// an optional or whole-object read expands into the entire environment object and serializes
// every VITE_* value into the client bundle, which the admin public environment boundary
// (tests/preflight/admin-env-boundary.test.js) refuses. So the revision is resolved here at
// build time and handed to the client as one defined constant.
//
// The reviewed build manifest wins because that is what the deployed build already publishes
// as its own identity; the checked-out commit is the fallback for a local or CI build that has
// no manifest. Neither available means no revision, not a guess.

const FULL_REVISION = /^[0-9a-f]{7,40}$/i;
const SHORT_LENGTH = 7;

function shortRevision(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return FULL_REVISION.test(trimmed)
    ? trimmed.slice(0, SHORT_LENGTH).toLowerCase()
    : null;
}

export function resolveAdminBuildRevision({ manifest, gitRevision } = {}) {
  const fromManifest = shortRevision(manifest?.build?.revision);
  if (fromManifest) return fromManifest;
  return shortRevision(gitRevision);
}
