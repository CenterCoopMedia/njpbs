#!/usr/bin/env node
import { assertDevelopmentSource } from "./render-development-config.mjs";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export async function preparePrivatePairBridge(args) {
  if (args.length !== 4 || args[0] !== "--input" || !args[1] || args[2] !== "--output" || !args[3]) throw new Error("Bridge preparation refused");
  const bytes = await readFile(args[1]); if (!bytes.length || bytes.length > 256 * 1024) throw new Error("Bridge preparation refused");
  const intent = JSON.parse(bytes.toString("utf8"));
  if (Object.hasOwn(intent, "sourceDigest")) throw new Error("Bridge preparation refused");
  if (typeof intent.operatorCommitSha !== "string" || !/^[a-f0-9]{40}$/.test(intent.operatorCommitSha)) throw new Error("Bridge source refused");
  const options = { cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } };
  const git = args => execFileSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], options).trim();
  if (git(["rev-parse", "HEAD"]) !== intent.operatorCommitSha || !assertDevelopmentSource(options.cwd)) throw new Error("Bridge source refused");
  const { privateBridgeConfiguration } = await import("./lib/public-release-private-bridge-operator.mjs");
  const { compilePrivateWorker } = await import("./install-private-public-release.mjs");
  const { config, packet } = privateBridgeConfiguration({ ...intent, sourceDigest: "0".repeat(64) });
  const source = await compilePrivateWorker(config.main), sourceDigest = createHash("sha256").update(source).digest("hex");
  const output = Buffer.from(`${JSON.stringify({ ...packet, sourceDigest }, null, 2)}\n`);
  await writeFile(args[3], output, { flag: "wx", mode: 0o600 });
  return { sourceDigest, packetDigest: createHash("sha256").update(output).digest("hex"), providerWrites: 0, authorityReads: 0 };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  preparePrivatePairBridge(process.argv.slice(2)).then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(() => {
    process.stderr.write("Private bridge preparation was refused; output is never overwritten\n"); process.exitCode = 1;
  });
}
