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
  let stage = "packet-guard", firstFailure = null, finished = false, emitted = false;
  const setStage = value => { stage = value; };
  const emit = () => {
    if (!firstFailure || emitted) return;
    emitted = true;
    const errorClass = [AggregateError, TypeError, SyntaxError, RangeError, ReferenceError, URIError, EvalError, Error]
      .find(type => firstFailure.error instanceof type)?.name ?? "Unknown";
    const direction = process.argv[6] === "--inspect"
      ? "no request confirmed; obtain coordinator diagnosis GO before another inspect"
      : "obtain coordinator GO for the original packet's --readback";
    process.stderr.write(`Development inactive bootstrap retirement was not confirmed; code=DEV_RETIRE_REFUSED stage=${firstFailure.stage} errorClass=${errorClass}; preserve the packet; ${direction}\n`);
  };
  const remember = error => {
    firstFailure ??= { error, stage };
    process.exitCode = 1;
    if (finished) emit();
  };
  // A first read-only SDK read can leave its transaction-ID promise rejected.
  // Keep it private and let the operator finish both cleanups before reporting.
  process.on("unhandledRejection", remember);
  (async () => {
    try {
      const args = process.argv.slice(2); checkPacket(args, setStage);
      setStage("module-import");
      const { runDevInactiveBootstrapOperator } = await import("./lib/dev-inactive-bootstrap-operator.mjs");
      const result = await runDevInactiveBootstrapOperator(args, setStage);
      await new Promise(resolve => setImmediate(resolve));
      if (firstFailure) return;
      setStage("result-write");
      await new Promise((resolve, reject) => {
        process.stdout.once("error", reject);
        process.stdout.write(`${JSON.stringify(result)}\n`, error => {
          if (error) reject(error);
          else { process.stdout.removeListener("error", reject); resolve(); }
        });
      });
    } catch (error) { remember(error); }
    finally {
      await new Promise(resolve => setImmediate(resolve));
      finished = true; emit();
      // Retain this CLI-only listener through exit; it creates no live handle.
    }
  })();
}
