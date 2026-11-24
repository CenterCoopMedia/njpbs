#!/usr/bin/env node
// Re-pin the ready development publication runtime to the live development pointer commit.
// Usage: <dev operator credential JSON on stdin> | node scripts/repin-dev-runtime.mjs \
//   --operation-id <id> --from <runtime sha> --to <pointer sha> (--apply | --read)
// Development only: the owner refuses any other project, and --to must be on origin/main.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseDevOperatorCredential } from "./lib/dev-proof-admission.mjs";

const require = createRequire(import.meta.url);
const PROJECT = "njpbs-site-dev";
const AMBIENT = ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_CONFIG"];
const SAFE_REFUSALS = new Set(["dev_repin_arguments_required", "dev_repin_explicit_stdin_required",
  "dev_repin_target_not_on_main", "dev_operator_credential_required"]);
const refuse = code => { throw new Error(code); };

export function parseRepinArguments(args, env, isTTY) {
  const [flag0, operationId, flag1, fromCommitSha, flag2, toCommitSha, mode] = args;
  if (args.length !== 7 || flag0 !== "--operation-id" || flag1 !== "--from" || flag2 !== "--to" ||
      !["--apply", "--read"].includes(mode)) refuse("dev_repin_arguments_required");
  // config-input: FIREBASE_AUTH_EMULATOR_HOST, FIREBASE_CONFIG, FIRESTORE_EMULATOR_HOST, GOOGLE_APPLICATION_CREDENTIALS
  if (isTTY || AMBIENT.some(key => env[key] !== undefined)) refuse("dev_repin_explicit_stdin_required");
  return { apply: mode === "--apply", request: { schemaVersion: 1, operationId, environment: "development",
    projectId: PROJECT, fromCommitSha, toCommitSha } };
}

function assertOnMain(commitSha) {
  const options = { cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: "ignore",
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } };
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commitSha, "origin/main"], options);
  } catch {
    refuse("dev_repin_target_not_on_main");
  }
}

async function readCredential(stream) {
  let input = "";
  for await (const chunk of stream) {
    input += chunk.toString();
    if (Buffer.byteLength(input) > 32_768) refuse("dev_operator_credential_required");
  }
  return parseDevOperatorCredential(input);
}

export async function main(args = process.argv.slice(2)) {
  const { apply, request } = parseRepinArguments(args, process.env, process.stdin.isTTY);
  const owner = require("./lib/dev-runtime-repin.cjs");
  owner.parseRequest(request);
  assertOnMain(request.toCommitSha);
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
