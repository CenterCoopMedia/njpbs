import { execFileSync } from "node:child_process";
import { MERGE_GROUP_NOT_ON_MAIN, requireMainCi } from "../.github/scripts/require-main-ci.mjs";
import { providerCall } from "./lib/provider-call.mjs";
import { repositoryIdentity } from "./lib/repository-identity.mjs";

// This read-only Node gate and gh inherit any ambient GH_TOKEN/GITHUB_TOKEN.
// Authentication stays in gh; this gate never extracts a token from its store.
try {
  if (process.argv.length !== 3) throw new Error("Expected one release SHA");
  const sha = process.argv[2];
  const run = await requireMainCi({
    repository: repositoryIdentity().repository,
    sha,
    request: async endpoint => JSON.parse(await providerCall("gh CI read", () => execFileSync("gh", ["api", endpoint], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }))),
  });
  console.log(`Admin release ${sha} passed main CI run ${run}.`);
} catch (error) {
  if (error?.message === MERGE_GROUP_NOT_ON_MAIN) {
    console.error(MERGE_GROUP_NOT_ON_MAIN);
  } else {
    const noProof = error?.message === `No successful main CI/ci proof for deploy SHA ${process.argv[2]}`;
    console.error(noProof ? "Standalone Admin release has no matching main CI proof." :
      "Standalone Admin release CI lookup failed.");
  }
  process.exitCode = 1;
}
