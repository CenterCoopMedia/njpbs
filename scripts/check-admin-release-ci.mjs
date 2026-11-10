import { execFileSync } from "node:child_process";
import { requireMainCi } from "../.github/scripts/require-main-ci.mjs";
import { repositoryIdentity } from "./lib/repository-identity.mjs";

// This read-only Node gate and gh inherit any ambient GH_TOKEN/GITHUB_TOKEN.
// Authentication stays in gh; this gate never extracts a token from its store.
try {
  if (process.argv.length !== 3) throw new Error("Expected one release SHA");
  const sha = process.argv[2];
  const run = await requireMainCi({
    repository: repositoryIdentity().repository,
    sha,
    request: endpoint => JSON.parse(execFileSync("gh", ["api", endpoint], {
      encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
    })),
  });
  console.log(`Admin release ${sha} passed main CI run ${run}.`);
} catch (error) {
  const noProof = error?.message === `No successful main CI/ci proof for deploy SHA ${process.argv[2]}`;
  console.error(noProof ? "Standalone Admin release has no matching main CI proof." :
    "Standalone Admin release CI lookup failed.");
  process.exitCode = 1;
}
