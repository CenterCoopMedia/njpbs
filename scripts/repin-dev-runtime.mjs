#!/usr/bin/env node
// Re-pin the ready development publication runtime to the live development pointer commit.
// Usage: <dev operator credential JSON on stdin> | node scripts/repin-dev-runtime.mjs \
//   --operator-commit <reviewed main sha> --operation-id <id> --from <runtime sha> --to <pointer sha> (--apply | --read)
// Development only: the owner refuses any other project. Before the owner loads or the credential
// is read, the checkout must be the clean canonical repository at a reviewed commit on origin/main.
// CANONICAL_GITHUB_REPOSITORY and CANONICAL_GITHUB_REPOSITORY_ID name that repository.
import { assertDevelopmentSource } from "./render-development-config.mjs";
import { repositoryMatches } from "./lib/repository-identity.mjs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const PROJECT = "njpbs-site-dev";
const AMBIENT = ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_CONFIG"];
const SAFE_REFUSALS = new Set(["dev_repin_arguments_required", "dev_repin_explicit_stdin_required",
  "dev_repin_operator_source_refused", "dev_repin_target_not_on_main", "dev_operator_credential_required"]);
const SHA = /^[a-f0-9]{40}$/;
// A github.com origin over HTTPS or SSH; any other host or a local path refuses.
const GITHUB_ORIGIN = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/;
const refuse = code => { throw new Error(code); };

// The configured canonical repository is the trust anchor; missing configuration refuses.
export function isCanonicalOrigin(url, env = process.env) {
  const slug = GITHUB_ORIGIN.exec(url ?? "")?.[1];
  return slug !== undefined && repositoryMatches(slug, env);
}

export function parseRepinArguments(args, env, isTTY) {
  const [flag0, operatorCommitSha, flag1, operationId, flag2, fromCommitSha, flag3, toCommitSha, mode] = args;
  if (args.length !== 9 || flag0 !== "--operator-commit" || !SHA.test(operatorCommitSha ?? "") || flag1 !== "--operation-id" ||
      flag2 !== "--from" || flag3 !== "--to" || !["--apply", "--read"].includes(mode)) refuse("dev_repin_arguments_required");
  // config-input: FIREBASE_AUTH_EMULATOR_HOST, FIREBASE_CONFIG, FIRESTORE_EMULATOR_HOST, GOOGLE_APPLICATION_CREDENTIALS
  if (isTTY || AMBIENT.some(key => env[key] !== undefined)) refuse("dev_repin_explicit_stdin_required");
  return { apply: mode === "--apply", operatorCommitSha, request: { schemaVersion: 1, operationId, environment: "development",
    projectId: PROJECT, fromCommitSha, toCommitSha } };
}

const options = { cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } };
const git = args => execFileSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], options).trim();
const onMain = sha => { try { git(["merge-base", "--is-ancestor", sha, "origin/main"]); return true; } catch { return false; } };

// Only built-ins and the source check run before this passes; the owner and credential come after.
function assertOperatorSource(operatorCommitSha, toCommitSha) {
  let canonical = false;
  try {
    canonical = isCanonicalOrigin(git(["remote", "get-url", "origin"])) &&
      git(["rev-parse", "HEAD"]) === operatorCommitSha && assertDevelopmentSource(options.cwd) &&
      git(["rev-parse", "HEAD^{tree}"]) === git(["rev-parse", `${operatorCommitSha}^{tree}`]) && onMain(operatorCommitSha);
  } catch { /* Any source error refuses. */ }
  if (!canonical) refuse("dev_repin_operator_source_refused");
  if (!onMain(toCommitSha)) refuse("dev_repin_target_not_on_main");
}

async function readCredential(stream) {
  const { parseDevOperatorCredential } = await import("./lib/dev-proof-admission.mjs");
  let input = "";
  for await (const chunk of stream) {
    input += chunk.toString();
    if (Buffer.byteLength(input) > 32_768) refuse("dev_operator_credential_required");
  }
  return parseDevOperatorCredential(input);
}

export async function main(args = process.argv.slice(2)) {
  const { apply, operatorCommitSha, request } = parseRepinArguments(args, process.env, process.stdin.isTTY);
  if (!SHA.test(request.toCommitSha ?? "")) refuse("dev_repin_arguments_required");
  assertOperatorSource(operatorCommitSha, request.toCommitSha);
  const owner = require("./lib/dev-runtime-repin.cjs");
  owner.parseRequest(request);
  const account = await readCredential(process.stdin);
  const { cert, initializeApp, deleteApp } = require("firebase-admin/app");
  const { getFirestore } = require("firebase-admin/firestore");
  const app = initializeApp({ projectId: PROJECT, credential: cert(account) }, `dev-runtime-repin-${process.pid}`);
  try {
    const firestore = getFirestore(app);
    const result = apply ? await owner.repinDevRuntime({ firestore, request }) : await owner.readDevRuntimeRepin({ firestore, request });
    process.stdout.write(JSON.stringify(result) + "\n");
  } finally { await deleteApp(app); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write((SAFE_REFUSALS.has(error?.message) ? error.message : "dev_repin_refused") + "\n");
    process.exitCode = 1;
  });
}
