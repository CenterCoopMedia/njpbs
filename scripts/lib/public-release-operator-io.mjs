import { assertDevelopmentSource } from "../render-development-config.mjs";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import protocol from "../../functions/lib/public-release-pair.js";
import targets from "../../functions/lib/publication-target.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
export function operatorRefused() { throw new Error("Public release operator refused; preserve the original packet and read its attempt"); }
export function parseOperatorArgs(args, modes = ["--apply", "--readback"]) {
  if (![4, 5].includes(args.length) || args[0] !== "--packet" || !args[1] || args[2] !== "--packet-digest" ||
      !protocol.digest(args[3]) || args.length === 5 && !modes.includes(args[4])) operatorRefused();
  return { filename: args[1], packetDigest: args[3], mode: args[4]?.slice(2) ?? "plan" };
}
export async function readOperatorPacket(options) {
  const bytes = await readFile(options.filename);
  if (!bytes.length || bytes.length > 256 * 1024 || createHash("sha256").update(bytes).digest("hex") !== options.packetDigest) operatorRefused();
  return JSON.parse(bytes.toString("utf8"));
}
/** Fixed checkout, no caller-supplied Git routing/configuration or source path. */
export function assertOperatorSource(commitSha) {
  if (!/^[a-f0-9]{40}$/.test(commitSha ?? "")) operatorRefused();
  try {
    const options = { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } };
    const args = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
    if (execFileSync("git", [...args, "rev-parse", "HEAD"], options).trim() !== commitSha ||
        !assertDevelopmentSource(options.cwd)) operatorRefused();
  } catch { operatorRefused(); }
}
/** Public credential identity and vault pointer only; never a credential value. */
export function parseOperatorCredentialIdentity(value, environment) {
  protocol.exact(value, ["projectId", "clientEmail", "privateKeyId", "secretRef"]);
  const { projectId } = targets.publicationTarget(environment);
  if (value.projectId !== projectId || typeof value.clientEmail !== "string" ||
      !new RegExp(`^[a-z][a-z0-9-]{2,62}@${projectId}\\.iam\\.gserviceaccount\\.com$`).test(value.clientEmail) ||
      !/^[a-f0-9]{40}$/.test(value.privateKeyId ?? "") || !/^pass:\/\/[A-Za-z0-9/_-]{1,200}$/.test(value.secretRef ?? "")) operatorRefused();
  return value;
}
/** Read an inherited pipe once, at use, bounded before buffering its contents. */
export function operatorCredentialStream(fd) {
  let pending;
  return () => pending ??= (async () => {
    const stream = createReadStream(null, { fd, autoClose: false });
    let size = 0; const chunks = [];
    for await (const chunk of stream) { size += chunk.length; if (size > 64 * 1024) operatorRefused(); chunks.push(chunk); }
    if (!size) operatorRefused();
    return Buffer.concat(chunks).toString("utf8").trim();
  })();
}
export function operatorAccount(raw, identity) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 64 * 1024) operatorRefused();
  const account = JSON.parse(raw);
  if (account?.type !== "service_account" || account.project_id !== identity.projectId || account.client_email !== identity.clientEmail ||
      account.private_key_id !== identity.privateKeyId || typeof account.private_key !== "string" || account.private_key.length < 32) operatorRefused();
  return { projectId: account.project_id, clientEmail: account.client_email, privateKey: account.private_key };
}
export async function openOperatorDatabase(account) {
  if (["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "FUNCTIONS_EMULATOR", "FIREBASE_DATABASE_EMULATOR_HOST"]
    .some(key => Object.hasOwn(process.env, key))) operatorRefused();
  const require = createRequire(import.meta.url);
  const { initializeApp, cert, deleteApp } = require("firebase-admin/app"), { getFirestore } = require("firebase-admin/firestore");
  const app = initializeApp({ projectId: account.projectId, credential: cert(account) }, "public-release-command-operator");
  return { app, firestore: getFirestore(app), close: () => deleteApp(app) };
}
