import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertDevDeployCheckout } from "./lib/dev-deploy-source.mjs";
import { readVerifiedDevManifest, runDevCmsFunctionSmoke } from "./smoke-cms-functions.mjs";

let phase = "arguments";
try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== "--manifest-only")) throw new Error("Dev smoke arguments refused");
  phase = "source identity";
  const sourceSha = assertDevDeployCheckout(process.env, new URL("../", import.meta.url));
  phase = "dev manifest";
  const deployedFunctionNames = await readVerifiedDevManifest();
  console.log("CMS development export manifest: matched");
  if (!args.length) {
    phase = "live boundaries";
    const result = await runDevCmsFunctionSmoke({ deployedFunctionNames });
    const receipt = { schemaVersion: 1, environment: "development", sourceSha, releaseChecksSha: sourceSha,
      trustedWorkflowSha: process.env.GITHUB_SHA, functionNames: deployedFunctionNames, ...result };
    phase = "proof receipt";
    writeFileSync(join(process.env.RUNNER_TEMP, "dev-smoke-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  }
} catch {
  console.error(`CMS development smoke refused during ${phase}; raw details withheld`);
  process.exitCode = 1;
}
