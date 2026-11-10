import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { restoreDevelopmentTemplates } from "../../scripts/render-development-config.mjs";

// Run only from the trusted current main checkout, before executing selected code.
// An accepted queue can retain an older renderer release. It cannot select code
// from an unmerged branch or outside a verified recovery run's history.
export function assertDevPublicationSourceHistory(env, { cwd = process.cwd() } = {}) {
  const source = env.SOURCE_SHA;
  const trusted = env.GITHUB_SHA;
  const originalRun = env.DEV_RECONCILE_RUN_SHA;
  const sha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
  if (!sha(source) || !sha(trusted) || originalRun !== undefined && !sha(originalRun)) {
    throw new Error("Invalid dev source ancestry input");
  }
  const git = args => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (git(["rev-parse", "HEAD"]) !== trusted) throw new Error("Dev source selection requires the trusted checkout");
  try {
    if (originalRun) git(["merge-base", "--is-ancestor", originalRun, trusted]);
    git(["merge-base", "--is-ancestor", source, originalRun ?? trusted]);
  } catch {
    throw new Error("Accepted dev source is outside trusted main history");
  }
  return source;
}

export function checkoutDevPublicationSource(env, { cwd = process.cwd() } = {}) {
  const source = assertDevPublicationSourceHistory(env, { cwd });
  restoreDevelopmentTemplates(cwd, env);
  execFileSync("git", ["-c", "advice.detachedHead=false", "checkout", "--detach", source],
    { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === "verify") assertDevPublicationSourceHistory(process.env);
    else if (process.argv[2] === undefined) checkoutDevPublicationSource(process.env);
    else throw new Error("Invalid dev source command");
  }
  catch { console.error("Dev source checkout refused"); process.exitCode = 1; }
}
