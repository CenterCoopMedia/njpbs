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
  const { parseOperatorArgs, readOperatorPacket, operatorAccount, openOperatorDatabase } = await import('./lib/public-release-operator-io.mjs');
  const { assertDevelopmentRehearsalEnvironment } = await import('./lib/development-rehearsal-credentials.mjs');
  const options = parseOperatorArgs(args), raw = await readOperatorPacket(options);
  const { developmentGatewayConfiguration, bindDevelopmentPublicReleaseGateway } = await import('./lib/development-public-release-gateway.mjs');
  const { packet } = developmentGatewayConfiguration(raw);
  if (options.mode === 'plan') return { mode: 'plan', operationId: packet.operationId, authorityReads: 0, providerWrites: 0 };
  assertDevelopmentRehearsalEnvironment();
  const { developmentInstallCredential: pipe, developmentInstallToken: token } = await import('./lib/development-install-credentials.mjs');
  const sdk = pipe(3, value => operatorAccount(value, packet.credentialIdentity)), provider = pipe(4, token);
  let connection;
  try {
    connection = await openOperatorDatabase(await sdk.read());
    return await bindDevelopmentPublicReleaseGateway({ firestore: connection.firestore, packet, readToken: provider.read,
      readback: options.mode === 'readback', signal: AbortSignal.timeout(120_000) });
  } finally { sdk.close(); provider.close(); await connection?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then(result => {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}).catch(() => { process.stderr.write('Development gateway binding refused; preserve the original packet and use --readback\n'); process.exitCode = 1; });
