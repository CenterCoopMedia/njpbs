#!/usr/bin/env node
import { assertDevelopmentSource } from "./render-development-config.mjs";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// As with the original ingress operator, protected entry code checks tracked
// source before loading any repository or ignored dependency module.
function prelaunch(args) {
  if (![4, 5].includes(args.length) || args[0] !== "--packet" || !args[1] || args[2] !== "--packet-digest" ||
      !/^[a-f0-9]{64}$/.test(args[3] ?? "") || args.length === 5 && args[4] !== "--apply") throw new Error();
  const bytes = readFileSync(args[1]);
  if (!bytes.length || bytes.length > 256 * 1024 || createHash("sha256").update(bytes).digest("hex") !== args[3]) throw new Error();
  const commitSha = JSON.parse(bytes.toString("utf8")).operatorCommitSha;
  if (!/^[a-f0-9]{40}$/.test(commitSha ?? "")) throw new Error();
  const options = { cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } };
  const git = args => execFileSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], options).trim();
  if (git(["rev-parse", "HEAD"]) !== commitSha || !assertDevelopmentSource(options.cwd)) throw new Error();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => {
    const args = process.argv.slice(2); prelaunch(args);
    const { runIngressRateEvidenceOperator } = await import("./lib/public-release-rate-control-command.mjs");
    process.stdout.write(`${JSON.stringify(await runIngressRateEvidenceOperator(args))}\n`);
  })().catch(() => { process.stderr.write("Rate-control evidence was not confirmed; preserve the exact packet\n"); process.exitCode = 1; });
}
