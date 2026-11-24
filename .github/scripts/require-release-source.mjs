import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// The owner-only main workflow records the coordinator's authorization. Bind
// it to immutable source identities so moving branches cannot reuse it.
export function releaseAuthorization({ sha, emergency = false, authorization = "" }) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error("A full deploy SHA is required");
  if (!emergency) {
    if (authorization) throw new Error("Emergency authorization requires emergency mode");
    return null;
  }
  const match = /^(EMERGENCY|CRITICAL) ([a-f0-9]{40}) FROM ([a-f0-9]{40}) (#[1-9][0-9]*): (\S[^\r\n]*)$/.exec(authorization);
  if (!match || match[2] !== sha) {
    throw new Error("Emergency mode requires coordinator authorization: <EMERGENCY|CRITICAL> <exact SHA> FROM <live base SHA> #<issue>: <reason>");
  }
  if (match[3] === sha) throw new Error("Emergency source must advance the recorded live base");
  return { kind: match[1], liveBase: match[3], issue: match[4], reason: match[5] };
}

export function requireReleaseSource({ sha, emergency = false, authorization = "", cwd = process.cwd() }) {
  const approved = releaseAuthorization({ sha, emergency, authorization });
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (git("rev-parse", "HEAD") !== sha || git("status", "--porcelain", "--untracked-files=no")) {
    throw new Error("Deploy source must be clean and equal the exact deploy SHA");
  }
  if (approved) {
    const chain = git("rev-list", "--first-parent", sha).split("\n");
    if (!chain.includes(approved.liveBase)) throw new Error("Emergency source first-parent chain does not reach the recorded live base");
  } else {
    git("merge-base", "--is-ancestor", sha, "origin/main");
  }
  return sha;
}

export function releaseInputs(env = process.env) {
  const mode = env.EMERGENCY_RELEASE || "false";
  if (!["true", "false"].includes(mode)) throw new Error("Invalid emergency release mode");
  return { emergency: mode === "true", authorization: env.EMERGENCY_AUTHORIZATION || "" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  requireReleaseSource({ sha, ...releaseInputs() });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `deploy_sha=${sha}\nsource_sha=${sha}\n`);
  console.log(`Reviewed release source: ${sha}`);
}
