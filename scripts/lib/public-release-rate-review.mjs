import { execFileSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import protocol from "../../functions/lib/public-release-pair.js";
import { assertOperatorSource, operatorRefused as refuse } from "./public-release-operator-io.mjs";
const hash = protocol.publicReleaseDigest;
const root = fileURLToPath(new URL("../../", import.meta.url));
// Trusted startup configuration owns policy and authentic receipt lookup. Request
// fields never choose an executable, a policy schema or a review verdict.
const startupConfiguration = Object.freeze({
  command: process.env.CMS_PUBLIC_RELEASE_REVIEW_VERIFIER,
  receiptSchema: process.env.CMS_PUBLIC_RELEASE_REVIEW_RECEIPT_SCHEMA,
});
const localHost = { run: execFileSync, configuration: startupConfiguration };
function configuration(value) {
  if (!value || typeof value.command !== "string" || !isAbsolute(value.command) ||
      /[\x00-\x1f\x7f]/.test(value.command) || typeof value.receiptSchema !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(value.receiptSchema)) refuse();
  return value;
}
/** The trusted host owns process access; its optional replacement is solely an
 * external-process test boundary. The configured verifier validates authentic
 * complete-diff review proof under its private policy and returns this envelope. */
export async function readRateControlFullReview(request, host = localHost) {
  assertOperatorSource(request.operatorCommitSha);
  const trusted = configuration(host.configuration);
  const repo = await realpath(root), options = { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true,
    env: { PATH: process.env.PATH, HOME: homedir(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } };
  try {
    const git = args => host.run("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], options).trim();
    const base = git(["merge-base", "HEAD", request.reviewBaseCommitSha]), tree = git(["rev-parse", "HEAD^{tree}"]);
    if (base !== request.reviewBaseCommitSha || base === request.operatorCommitSha || !/^[a-f0-9]{40}$/.test(tree)) refuse();
    const output = String(host.run(trusted.command, ["--repo", repo, "--operator-commit", request.operatorCommitSha,
      "--base", base, "--tree", tree, "--receipt-schema", trusted.receiptSchema], options));
    if (Buffer.byteLength(output) > 64 * 1024) refuse();
    const record = JSON.parse(output);
    const keys = ["receiptSchema", "scope", "verdict", "repo", "operatorCommitSha", "reviewBaseCommitSha", "snapshotTreeSha", "reviewReceiptDigest"];
    if (!record || typeof record !== "object" || Array.isArray(record) || Object.keys(record).length !== keys.length ||
        !keys.every(key => Object.hasOwn(record, key)) || record.receiptSchema !== trusted.receiptSchema ||
        record.scope !== "complete-diff" || record.verdict !== "pass" || record.repo !== repo ||
        record.operatorCommitSha !== request.operatorCommitSha || record.reviewBaseCommitSha !== base ||
        record.snapshotTreeSha !== tree || typeof record.reviewReceiptDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(record.reviewReceiptDigest)) refuse();
    return hash(record);
  } catch { refuse(); }
}
