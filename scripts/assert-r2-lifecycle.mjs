import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const REQUIRED_STAGING_MAX_AGE_SECONDS = 604800; // seven days
const IMMUTABLE_PREFIX = "cms-media/";
const STAGING_PREFIX = "cms-media-staging/";
const LIFECYCLE_ERROR =
  "R2 must delete cms-media-staging/ after seven days and retain cms-media/";

// A delete rule with key prefix P removes every object whose key starts with P,
// so it touches a namespace N when P is a parent of N (N startsWith P) or a child
// of N (P startsWith N). A missing prefix behaves as "" and covers everything.
function overlaps(prefix, namespace) {
  return namespace.startsWith(prefix) || prefix.startsWith(namespace);
}

export function assertR2Lifecycle(response) {
  const rules = response?.result?.rules;
  if (response?.success !== true || !Array.isArray(rules)) {
    throw new Error(LIFECYCLE_ERROR);
  }

  const deletes = rules.filter(
    (rule) =>
      rule?.enabled === true && rule?.deleteObjectsTransition?.condition,
  );

  // The exact retention rule for staging objects must exist.
  const stagingRetained = deletes.some(
    (rule) =>
      rule?.conditions?.prefix === STAGING_PREFIX &&
      rule.deleteObjectsTransition.condition.type === "Age" &&
      rule.deleteObjectsTransition.condition.maxAge ===
        REQUIRED_STAGING_MAX_AGE_SECONDS,
  );

  // No delete rule may reach the immutable cms-media/ namespace, whether its
  // prefix is a parent or a child of it.
  const immutableRisk = deletes.some((rule) =>
    overlaps(rule?.conditions?.prefix ?? "", IMMUTABLE_PREFIX),
  );

  // No rule that overlaps the staging namespace may expire its objects before
  // seven days, even when the correct retention rule also exists.
  const earlyStagingExpiry = deletes.some((rule) => {
    const prefix = rule?.conditions?.prefix ?? "";
    if (!overlaps(prefix, STAGING_PREFIX)) return false;
    const condition = rule.deleteObjectsTransition.condition;
    // Fail closed: only an explicit Age of at least seven days is safe. A
    // non-Age or missing-maxAge condition can expire objects early.
    return !(
      condition.type === "Age" &&
      Number.isFinite(condition.maxAge) &&
      condition.maxAge >= REQUIRED_STAGING_MAX_AGE_SECONDS
    );
  });

  if (!stagingRetained || immutableRisk || earlyStagingExpiry) {
    throw new Error(LIFECYCLE_ERROR);
  }
}

function main(rawJson) {
  if (!rawJson) {
    throw new Error("assert-r2-lifecycle requires the lifecycle JSON argument");
  }
  assertR2Lifecycle(JSON.parse(rawJson));
  console.log("R2 lifecycle rules verified.");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv[2]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
