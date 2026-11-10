#!/usr/bin/env node
import { assertDevelopmentSource } from "./render-development-config.mjs";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

// Only built-ins evaluate before the protected checkout and explicit target
// are checked. Credentials are consumed later, once, from inherited fd3.
function checkPacket(args) {
  if (![4, 5].includes(args.length) || args[0] !== "--packet" || !args[1] || args[2] !== "--packet-digest" ||
      !/^[a-f0-9]{64}$/.test(args[3] ?? "") || args.length === 5 && args[4] !== "--apply") throw new Error();
  const bytes = readFileSync(args[1]);
  if (!bytes.length || bytes.length > 256 * 1024 || createHash("sha256").update(bytes).digest("hex") !== args[3]) throw new Error();
  const packet = JSON.parse(bytes.toString("utf8")), sha = packet.operatorCommitSha, target = packet.request?.target;
  if (!/^[a-f0-9]{40}$/.test(sha ?? "") || !["development", "production"].includes(target?.environment) ||
      target.projectId !== (target.environment === "development" ? "njpbs-site-dev" : "njpbs-site") ||
      packet.credentialIdentity?.projectId !== target.projectId) throw new Error();
  const options = { cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } };
  const git = args => execFileSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], options).trim();
  if (git(["rev-parse", "HEAD"]) !== sha || !assertDevelopmentSource(options.cwd) ||
      git(["rev-parse", "HEAD^{tree}"]) !== git(["rev-parse", `${sha}^{tree}`])) throw new Error();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => {
    const args = process.argv.slice(2); checkPacket(args);
    const { runPreEnrollmentHistoryOperator } = await import("./lib/pre-enrollment-history-operator.mjs");
    process.stdout.write(`${JSON.stringify(await runPreEnrollmentHistoryOperator(args))}\n`);
  })().catch(() => {
    process.stderr.write("STOP: pre-enrollment history command refused; preserve the listing and original packet\n");
    process.exitCode = 1;
  });
}
