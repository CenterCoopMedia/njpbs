#!/usr/bin/env node
import { assertDevelopmentSource } from "./render-development-config.mjs";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

// Run the entry code and Node from a trusted checkout. Load no repository
// module or ignored dependency before this tracked-source check. This check
// does not isolate hostile code running under the same user identity.
function checkSource(commitSha) {
  if (typeof commitSha !== "string" || !/^[a-f0-9]{40}$/.test(commitSha)) throw new Error("Operator source refused");
  const options = { cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } };
  const git = args => execFileSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], options).trim();
  if (git(["rev-parse", "HEAD"]) !== commitSha || !assertDevelopmentSource(options.cwd) ||
      git(["rev-parse", "HEAD^{tree}"]) !== git(["rev-parse", `${commitSha}^{tree}`])) throw new Error("Operator source refused");
}
function checkPacket(args) {
  if (![4, 5].includes(args.length) || args[0] !== "--packet" || !args[1] || args[2] !== "--packet-digest" ||
      !/^[a-f0-9]{64}$/.test(args[3] ?? "") || args.length === 5 && !["--apply", "--readback"].includes(args[4])) throw new Error("Operator packet refused");
  const bytes = readFileSync(args[1]);
  if (!bytes.length || bytes.length > 256 * 1024 || createHash("sha256").update(bytes).digest("hex") !== args[3]) throw new Error("Operator packet refused");
  checkSource(JSON.parse(bytes.toString("utf8")).operatorCommitSha);
}

export async function main(args) {
  checkPacket(args);
  const { runProductionPublicReleaseOperator } = await import('./lib/production-public-release-operator.mjs');
  return runProductionPublicReleaseOperator(args);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then(result => {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.stop || result.step === 'pause-recovery' && result.mode !== 'plan' && !result.canContinue) {
    process.stderr.write('STOP: preserve the original production pause and failed-work receipts; production failed-pause recovery/return is unavailable\n');
    process.exitCode = 2;
  }
}).catch(error => {
  process.stderr.write(error?.code === 'production-failed-pause-recovery-unreviewed'
    ? 'STOP: production failed-pause recovery/return is unavailable; preserve the original packet\n'
    : 'Production release operation was not confirmed; preserve the original packet and use --readback\n');
  process.exitCode = 1;
});
