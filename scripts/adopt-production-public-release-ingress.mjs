#!/usr/bin/env node
import { assertDevelopmentSource } from "./render-development-config.mjs";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

// Protected prelaunch uses only Node built-ins before credential-capable imports.
function checkPacket(args) {
  if (![4, 5].includes(args.length) || args[0] !== "--packet" || !args[1] || args[2] !== "--packet-digest" ||
      !/^[a-f0-9]{64}$/.test(args[3] ?? "") || args.length === 5 && !["--apply", "--readback"].includes(args[4])) throw new Error();
  const bytes = readFileSync(args[1]);
  if (!bytes.length || bytes.length > 256 * 1024 || createHash("sha256").update(bytes).digest("hex") !== args[3]) throw new Error();
  const sha = JSON.parse(bytes.toString("utf8")).operatorCommitSha;
  if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha)) throw new Error();
  const options = { cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } };
  const git = args => execFileSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], options).trim();
  if (git(["rev-parse", "HEAD"]) !== sha || !assertDevelopmentSource(options.cwd) ||
      git(["rev-parse", "HEAD^{tree}"]) !== git(["rev-parse", `${sha}^{tree}`])) throw new Error();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => {
    const args = process.argv.slice(2); checkPacket(args);
    const { runProductionIngressAdoption } = await import("./lib/production-public-release-ingress-adoption.mjs");
    process.stdout.write(`${JSON.stringify(await runProductionIngressAdoption(args))}\n`);
  })().catch(() => {
    process.stderr.write("Production ingress adoption unconfirmed; preserve the original packet and use --readback\n"); process.exitCode = 1;
  });
}
