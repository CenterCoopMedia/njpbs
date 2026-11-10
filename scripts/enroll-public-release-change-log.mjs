#!/usr/bin/env node
import { assertDevelopmentSource } from "./render-development-config.mjs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Packet parsing stays built-in-only. The source-integrity import above permits
// only verified deployment rendering before any SDK or credential access.
const safeOperatorCodes = new Set([
  'sdk-packet-arguments', 'sdk-packet-read', 'sdk-packet-size', 'sdk-packet-digest', 'sdk-packet-json',
  'sdk-packet-identity', 'sdk-packet-project-mismatch', 'sdk-packet-required', 'sdk-environment-refused',
  'operator-source-unavailable', 'operator-head-mismatch', 'operator-tree-dirty', 'operator-tree-mismatch',
  'enrollment-request-read', 'enrollment-request-size', 'enrollment-request-json',
]);
class NativeOperatorRefusal extends Error {
  constructor(code) { super('Native operator refused'); this.code = code; }
}
const safeRefuse = code => { throw new NativeOperatorRefusal(code); };
const configuredDevelopmentSdkClientEmail = () => {
  const value = process.env.CMS_DEV_SDK_CLIENT_EMAIL?.toLowerCase();
  if (!/^[a-z][a-z0-9-]{2,62}@njpbs-site-dev\.iam\.gserviceaccount\.com$/.test(value ?? '')) {
    safeRefuse('sdk-packet-identity');
  }
  return value;
};
const safeOperatorCode = error => error instanceof NativeOperatorRefusal && safeOperatorCodes.has(error.code) ? error.code : null;
const sdkPacketRefusal = error => ({ status: 'refused', code: safeOperatorCode(error) ?? 'sdk-packet-refused' });
function installSdkOptions(args) {
  const environment = args.includes('--production-sdk-packet') ? 'production' : 'development';
  if (args.includes('--production-sdk-packet') && args.includes('--development-sdk-packet')) safeRefuse('sdk-packet-arguments');
  const flag = `--${environment}-sdk-packet`, index = args.indexOf(flag);
  if (index < 0) {
    if (args.some(value => /^--(?:production|development)-sdk-packet(?:-digest)?$/.test(value))) safeRefuse('sdk-packet-arguments');
    return { args };
  }
  if (index !== args.length - 4 || args[index + 2] !== `${flag}-digest` ||
      args.filter(value => value === flag).length !== 1 ||
      typeof args[index + 1] !== 'string' || !args[index + 1] || args[index + 1].startsWith('--') ||
      !/^[a-f0-9]{64}$/.test(args[index + 3] ?? '')) safeRefuse('sdk-packet-arguments');
  let bytes, packet;
  try { bytes = readFileSync(args[index + 1]); } catch { safeRefuse('sdk-packet-read'); }
  if (!bytes.length || bytes.length > 16_384) safeRefuse('sdk-packet-size');
  if (createHash('sha256').update(bytes).digest('hex') !== args[index + 3]) safeRefuse('sdk-packet-digest');
  try { packet = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { safeRefuse('sdk-packet-json'); }
  if (!packet || Array.isArray(packet) || Object.keys(packet).sort().join() !== 'credentialIdentity,kind,operatorCommitSha,schemaVersion' ||
      packet.schemaVersion !== 1 || packet.kind !== `${environment}-install-sdk` ||
      typeof packet.operatorCommitSha !== 'string' || !/^[a-f0-9]{40}$/.test(packet.operatorCommitSha) || !packet.credentialIdentity ||
      Object.keys(packet.credentialIdentity).sort().join() !== 'clientEmail,privateKeyId,projectId,secretRef') safeRefuse('sdk-packet-identity');
  const sha = packet.operatorCommitSha, identity = packet.credentialIdentity;
  const projectId = environment === 'production' ? 'njpbs-site' : 'njpbs-site-dev';
  if (identity.projectId !== projectId) safeRefuse('sdk-packet-project-mismatch');
  if (typeof identity.clientEmail !== 'string' ||
      !new RegExp(`^[a-z][a-z0-9-]{2,62}@${projectId}\\.iam\\.gserviceaccount\\.com$`).test(identity.clientEmail) ||
      environment === 'development' && identity.clientEmail !== configuredDevelopmentSdkClientEmail() ||
      typeof identity.privateKeyId !== 'string' || typeof identity.secretRef !== 'string' ||
      !/^[a-f0-9]{40}$/.test(identity.privateKeyId) || !/^pass:\/\/[A-Za-z0-9/_-]{1,200}$/.test(identity.secretRef)) safeRefuse('sdk-packet-identity');
  const options = { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } };
  const git = args => {
    try { return execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], options).trim(); }
    catch { safeRefuse('operator-source-unavailable'); }
  };
  if (git(['rev-parse', 'HEAD']) !== sha) safeRefuse('operator-head-mismatch');
  try { if (!assertDevelopmentSource(options.cwd)) safeRefuse('operator-tree-dirty'); }
  catch (error) { if (error instanceof NativeOperatorRefusal) throw error; safeRefuse('operator-tree-dirty'); }
  if (git(['rev-parse', 'HEAD^{tree}']) !== git(['rev-parse', `${sha}^{tree}`])) safeRefuse('operator-tree-mismatch');
  return { args: args.slice(0, index), packet, environment };
}
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
let install;
if (isMain) {
  try { install = installSdkOptions(process.argv.slice(2)); }
  catch (error) { process.stderr.write(JSON.stringify(sdkPacketRefusal(error)) + '\n'); process.exit(1); }
}
const require = createRequire(import.meta.url);
const enrollment = require("../functions/lib/public-release-change-enrollment.js");

export function parseEnrollmentOperatorArgs(args) {
  const [mode, ...rest] = args;
  if (!["inspect", "dry-run", "readback", "apply"].includes(mode)) throw new Error("invalid-enrollment-arguments");
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index], value = rest[index + 1];
    if (!["--project", "--request"].includes(key) || Object.hasOwn(values, key) || !value || value.startsWith("--")) throw new Error("invalid-enrollment-arguments");
    values[key] = value;
  }
  if (!/^[a-z][a-z0-9-]{3,62}$/.test(values["--project"] ?? "") ||
      (mode === "inspect" ? values["--request"] !== undefined : !values["--request"])) throw new Error("invalid-enrollment-arguments");
  return { mode, projectId: values["--project"], requestFile: values["--request"] };
}
const refusalCodes = new Set(["invalid-enrollment-request", "invalid-enrollment-receipt", "enrollment-head-exists", "enrollment-partial-state",
  "enrollment-conflict", "enrollment-source-not-idle", "enrollment-runtime-not-paused", "enrollment-producer-control-present",
  "enrollment-production-fence-required", "enrollment-production-recovery-unreviewed", "enrollment-context-missing", "enrollment-project-mismatch", "enrollment-cutoff-mismatch", "enrollment-receipt-missing"]);
export function enrollmentOperatorRefusal(error) {
  if (safeOperatorCode(error)) return { status: 'refused', code: safeOperatorCode(error) };
  if (error?.name === "PublicReleaseEnrollmentError" && refusalCodes.has(error.code)) return { status: "refused", code: error.code };
  if (error?.name === "PublicReleaseProtocolError") return { status: "refused", code: "protocol-refused" };
  if (Number.isInteger(error?.code) && error.code >= 1 && error.code <= 16) return { status: "refused",
    code: [4, 10, 14].includes(error.code) ? "storage-unavailable" : "storage-refused", grpcCode: error.code };
  if (error?.name === "AbortError") return { status: "refused", code: "cancelled" };
  return { status: "refused", code: error?.message === "invalid-enrollment-arguments" ? error.message : "enrollment-failed" };
}
async function main() {
  let app, connection, deleteApp, edgeSource;
  try {
    const args = parseEnrollmentOperatorArgs(install.args);
    let request;
    if (args.requestFile) {
      let bytes, value;
      try { bytes = await readFile(args.requestFile); } catch { safeRefuse('enrollment-request-read'); }
      if (!bytes.length || bytes.length > 16_384) safeRefuse('enrollment-request-size');
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { safeRefuse('enrollment-request-json'); }
      request = enrollment.parsePublicReleaseChangeEnrollmentRequest(value);
      if (request.expected.projectId !== args.projectId) throw new enrollment.PublicReleaseEnrollmentError("enrollment-project-mismatch");
    }
    // Production always uses the shared explicit in-memory binding. Neither a
    // missing packet nor a mixed project can select ambient ADC as a fallback.
    if (install.packet && args.projectId !== install.packet.credentialIdentity.projectId) safeRefuse('sdk-packet-project-mismatch');
    if (args.projectId === 'njpbs-site' && install.environment !== 'production') safeRefuse('sdk-packet-required');
    const production = install.environment === 'production' ? await import('./lib/production-install-binding.mjs') : null;
    if (production) {
      try { production.parseProductionInstallIdentity(install.packet.credentialIdentity); } catch { safeRefuse('sdk-packet-identity'); }
      try { production.assertProductionInstallEnvironment(); } catch { safeRefuse('sdk-environment-refused'); }
    } else if (install.packet) {
      const { assertDevelopmentRehearsalEnvironment } = await import('./lib/development-rehearsal-credentials.mjs');
      try { assertDevelopmentRehearsalEnvironment(); } catch { safeRefuse('sdk-environment-refused'); }
    }
    // Validate the operator-only pipe before opening any SDK connection. The
    // secret stays in memory and never falls back to the Functions environment.
    let readSecret;
    if (["dry-run", "apply"].includes(args.mode)) {
      const edge = await import("./lib/enrollment-edge-secret.mjs");
      if (production) edgeSource = edge.reserveEnrollmentEdgeSecret();
      else { const secret = await edge.readEnrollmentEdgeSecret(); readSecret = () => secret; }
    }
    let firestore;
    if (production) {
      connection = await production.openProductionInstallSdk(install.packet.credentialIdentity, 3);
      firestore = connection.firestore;
    } else if (install.packet) {
      const { openDevelopmentInstallSdk } = await import("./lib/development-install-sdk.mjs");
      connection = await openDevelopmentInstallSdk(install.packet, 3);
      firestore = connection.firestore;
    } else {
      const sdk = await import("firebase-admin/app"); deleteApp = sdk.deleteApp;
      const { getFirestore } = await import("firebase-admin/firestore");
      app = sdk.initializeApp({ projectId: args.projectId }, "release-change-enrollment-operator");
      firestore = getFirestore(app);
    }
    try {
      if (edgeSource) { const secret = await edgeSource.read(); readSecret = () => secret; }
      const result = args.mode === "inspect" ? await enrollment.inspectPublicReleaseChangeEnrollment({ firestore })
        : args.mode === "readback" ? await firestore.runTransaction(transaction => enrollment.assertReadPublicReleaseChangeEnrollmentInTransaction({
          firestore, transaction, requestDigest: require("../functions/lib/public-release-pair.js").publicReleaseDigest(request) }), { readOnly: true })
          : await enrollment.enrollPublicReleaseChangeLog({ firestore, request, dryRun: args.mode !== "apply", readSecret });
      process.stdout.write(JSON.stringify(result) + "\n");
    } finally { if (connection) await connection.close(); else await deleteApp(app); app = null; }
  } catch (error) {
    process.stderr.write(JSON.stringify(enrollmentOperatorRefusal(error)) + "\n");
    process.exitCode = 1;
  } finally { edgeSource?.close(); }
}
if (isMain) await main();
