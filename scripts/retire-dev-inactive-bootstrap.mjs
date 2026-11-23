#!/usr/bin/env node
import { assertDevelopmentSource } from "./render-development-config.mjs";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

// Only local source validation runs before the protected development target checks.
function checkPacket(args, stage) {
  if (![4, 5].includes(args.length) || args[0] !== "--packet" || !args[1] || args[2] !== "--packet-digest" ||
      !/^[a-f0-9]{64}$/.test(args[3] ?? "") || args.length === 5 && !["--inspect", "--dry-run", "--apply", "--readback"].includes(args[4])) throw new Error();
  const bytes = readFileSync(args[1]);
  if (!bytes.length || bytes.length > 256 * 1024 || createHash("sha256").update(bytes).digest("hex") !== args[3]) throw new Error();
  const packet = JSON.parse(bytes.toString("utf8")), sha = packet.operatorCommitSha;
  if (!/^[a-f0-9]{40}$/.test(sha ?? "") || packet.environment !== "development" || packet.projectId !== "njpbs-site-dev" ||
      packet.credentialIdentity?.projectId !== "njpbs-site-dev" || packet.request !== null &&
      (packet.request?.environment !== "development" || packet.request.projectId !== "njpbs-site-dev")) throw new Error();
  stage("source-guard");
  const options = { cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } };
  const git = args => execFileSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], options).trim();
  if (git(["rev-parse", "HEAD"]) !== sha || !assertDevelopmentSource(options.cwd, {}) ||
      git(["rev-parse", "HEAD^{tree}"]) !== git(["rev-parse", `${sha}^{tree}`])) throw new Error();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const direction = args[4] === "--inspect"
    ? "no request confirmed; obtain coordinator diagnosis GO before another inspect"
    : "obtain coordinator GO for the original packet's --readback";
  const refusal = ({ stage, errorClass }) =>
    `Development inactive bootstrap retirement was not confirmed; code=DEV_RETIRE_REFUSED stage=${stage} errorClass=${errorClass}; preserve the packet; ${direction}`;
  let stage = "packet-guard";
  try {
    checkPacket(args, value => { stage = value; });
    stage = "module-import";
    const { runReadOnlyOperator } = await import("./lib/read-only-operator.mjs");
    await runReadOnlyOperator({ stage, refusal, async run(setStage) {
      const { runDevInactiveBootstrapOperator } = await import("./lib/dev-inactive-bootstrap-operator.mjs");
      return runDevInactiveBootstrapOperator(args, setStage);
    } });
  } catch (error) {
    const errorClass = error instanceof SyntaxError ? "SyntaxError" : error instanceof TypeError ? "TypeError" : "Error";
    process.stderr.write(`${refusal({ stage, errorClass })}\n`);
    process.exitCode = 1;
  }
}
