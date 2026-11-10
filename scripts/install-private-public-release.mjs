import { assertDevelopmentSource } from "./render-development-config.mjs";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
// Only built-ins run before the optional development packet's source gate.
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
function developmentSdkOptions(args) {
  const environment = 'development';
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

if (isMain) {
  try { developmentSdkOptions(process.argv.slice(2)); }
  catch (error) { process.stderr.write(JSON.stringify(sdkPacketRefusal(error)) + '\n'); process.exit(1); }
}

const refuse = () => { throw new Error("Private public-release installation was refused"); };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export async function compilePrivateWorker(main) {
  const { build } = await import("esbuild");
  const result = await build({ entryPoints: [main], bundle: true, write: false, format: "esm", platform: "browser", target: "es2023",
    legalComments: "none", external: ["cloudflare:workers", "node:crypto", "node:util", "node:buffer"], metafile: true });
  if (Object.keys(result.metafile.inputs).some(path => /(?:firebase-admin|google-cloud|grpc)/.test(path)) || result.outputFiles.length !== 1) refuse();
  return result.outputFiles[0].contents;
}
/** Both slot versions are learned from provider upload and retained in the
 * original attempt. Embedded slot identity excludes that UUID and its derived
 * readerReceiptDigest; both are computed from the actual uploaded version.
 * The resulting full pairs are output for separate guarded registration; this
 * operator never writes pair registry, capability, selector, pin or apex route. */
export async function installPrivatePublicRelease({ plan, ledger, provider, compile = compilePrivateWorker, dryRun = true, signal, onStage = () => {} }) {
  const { default: protocol } = await import("../functions/lib/public-release-pair.js");
  const { configurePublicReleaseSlot, configurePublicReleaseIngress } = await import("./configure-public-release-ingress.mjs");
  const { installPrivateWorker } = await import("./lib/public-release-private-provider.mjs");
  const { privatePublicReleasePlanPairs } = await import("./lib/private-public-release-install-plan.mjs");
  const development = Object.hasOwn(plan ?? {}, "developmentIngress");
  protocol.exact(plan, ["schemaVersion", "operationId", "accountId", "ingressName", "oldPair", "newPair", "slotEnabled", "readerOrigins", "readerAccess", "slotBundleDigest", "ingressBundleDigest", ...development ? ["developmentIngress"] : []]);
  if (![1, 2].includes(plan.schemaVersion) || !/^[A-Za-z0-9_-]{1,128}$/.test(plan.operationId ?? "") ||
      !protocol.digest(plan.slotBundleDigest) || !protocol.digest(plan.ingressBundleDigest) ||
      !Array.isArray(plan.readerOrigins) || plan.readerOrigins.length !== 2 || plan.readerOrigins[0] === plan.readerOrigins[1] ||
      !Array.isArray(plan.readerAccess) || plan.readerAccess.length !== 2 || !Array.isArray(plan.slotEnabled) ||
      plan.slotEnabled.length !== 2 || plan.slotEnabled.some(value => typeof value !== "boolean")) refuse();
  signal?.throwIfAborted();
  const [oldPair, newPair] = privatePublicReleasePlanPairs(plan);
  if (development && (plan.developmentIngress !== true || oldPair.environment !== "development" ||
      plan.slotEnabled.some(value => value !== true) || plan.readerAccess.some(value => value?.enabled !== true))) refuse();
  const ingressOptions = { developmentIngress: development };
  // Validate the complete environment/name/binding tuple before any effect.
  configurePublicReleaseIngress({ oldPair, newPair, accountId: plan.accountId, ingressName: plan.ingressName, ...ingressOptions });
  const slots = [oldPair, newPair].map((pair, index) => configurePublicReleaseSlot({ pair, accountId: plan.accountId,
    readerOrigin: plan.readerOrigins[index], readerAccess: plan.readerAccess[index], slotEnabled: plan.slotEnabled[index] }));
  const slotSource = await compile(slots[0].main);
  if (hash(slotSource) !== plan.slotBundleDigest) refuse();
  const preliminaryIngress = configurePublicReleaseIngress({ oldPair, newPair, accountId: plan.accountId, ingressName: plan.ingressName, ...ingressOptions });
  const ingressSource = await compile(preliminaryIngress.main);
  if (hash(ingressSource) !== plan.ingressBundleDigest) refuse();
  if (dryRun && plan.schemaVersion === 2) return { schemaVersion: 2, dryRun, operationId: plan.operationId,
    pairs: [plan.oldPair, plan.newPair], readbacks: await Promise.all(slots.map(config =>
      installPrivateWorker({ attemptId: plan.operationId, config, source: slotSource }))), ingress: "pending-actual-slot-versions" };
  if (!dryRun) {
    signal?.throwIfAborted();
    if (plan.schemaVersion === 2) for (const [index, pair] of [oldPair, newPair].entries()) {
      await ledger.assertPublisherUpload({ pair, operationId: plan.operationId, readerOrigin: plan.readerOrigins[index] });
    }
    await ledger.bindAttempt(plan.operationId, protocol.publicReleaseDigest(plan));
  }
  onStage("provider");
  const pairs = [], readbacks = [];
  for (const [index, config] of slots.entries()) {
    const result = await installPrivateWorker({ ledger, provider, attemptId: plan.operationId, config, source: slotSource, dryRun, signal });
    const template = [oldPair, newPair][index];
    const readerReceiptDigest = dryRun ? template.readerReceiptDigest : protocol.publicReleaseDigest({ schemaVersion: 1,
      environment: template.environment, service: template.publicWorker.service, versionId: result.versionId,
      commitSha: template.commitSha, origin: plan.readerOrigins[index], contractDigest: template.readerContractDigest });
    pairs.push(dryRun ? template : protocol.parsePublicReleasePair({ ...template, readerReceiptDigest,
      publicWorker: { ...template.publicWorker, versionId: result.versionId } }));
    readbacks.push(result);
  }
  const ingress = configurePublicReleaseIngress({ oldPair: pairs[0], newPair: pairs[1], accountId: plan.accountId, ingressName: plan.ingressName, ...ingressOptions });
  readbacks.push(await installPrivateWorker({ ledger, provider, attemptId: plan.operationId, config: ingress, source: ingressSource, dryRun, signal }));
  return { schemaVersion: 1, dryRun, operationId: plan.operationId, bootstrapPairId: pairs[0].pairId, pairs, readbacks };
}
export function privateInstallCredential(stream) {
  let pending;
  return () => pending ??= (async () => {
    let value = "";
    for await (const chunk of stream) { value += chunk.toString("utf8"); if (Buffer.byteLength(value) > 4096) refuse(); }
    const token = value.trim(); if (!/^[A-Za-z0-9_-]{20,256}$/.test(token)) refuse(); return token;
  })();
}
class PrivateInstallOperatorError extends Error {
  constructor(stage) {
    super(`Private public-release installation was refused at ${stage}${stage === "provider" ? "; reconcile the original attempt" : "; no provider step was invoked"}`);
    this.name = "PrivateInstallOperatorError";
  }
}
export async function main(args) {
  let stage = "plan", app, connection;
  try {
    const development = developmentSdkOptions(args); args = development.args;
    const apply = args.length === 3 && args[2] === "--apply";
    if (args[0] !== "--plan" || !args[1] || !(args.length === 2 || apply)) refuse();
    const { default: targets } = await import("../functions/lib/publication-target.js");
    const { privateInstallLedger } = await import("./lib/public-release-private-install-ledger.mjs");
    const { cloudflarePrivatePairProvider } = await import("./lib/public-release-private-provider.mjs");
    const { privatePublicReleasePlanPairs } = await import("./lib/private-public-release-install-plan.mjs");
    const bytes = await readFile(args[1]); if (bytes.length > 64 * 1024) refuse();
    const plan = JSON.parse(bytes.toString("utf8"));
    if (development.packet) {
      const { parseDevelopmentInstallSdkPacket } = await import("./lib/development-install-sdk.mjs");
      parseDevelopmentInstallSdkPacket(development.packet);
      if (plan.developmentIngress !== true || privatePublicReleasePlanPairs(plan).some(pair => pair.environment !== "development")) refuse();
    }
    if (!apply) {
      stage = "dry-run";
      process.stdout.write(`${JSON.stringify(await installPrivatePublicRelease({ plan }), null, 2)}\n`); return;
    }
    stage = "credentials";
    if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) refuse();
    const target = targets.publicationTarget(privatePublicReleasePlanPairs(plan)[0].environment);
    const fd = process.env.PRIVATE_INSTALL_TOKEN_FD;
    if (!/^(?:[3-9]|[1-9][0-9]+)$/.test(fd ?? "") || !Number.isSafeInteger(Number(fd)) || Number(fd) > 2147483647 ||
        development.packet && fd === "4") refuse();
    let firestore;
    if (development.packet) {
      const { openDevelopmentInstallSdk } = await import("./lib/development-install-sdk.mjs");
      connection = await openDevelopmentInstallSdk(development.packet, 4);
      firestore = connection.firestore;
    } else {
      const { applicationDefault, initializeApp } = await import("firebase-admin/app");
      const { getFirestore } = await import("firebase-admin/firestore");
      app = initializeApp({ projectId: target.projectId, credential: applicationDefault() });
      firestore = getFirestore(app);
    }
    const credential = privateInstallCredential(createReadStream(null, { fd: Number(fd), autoClose: false }));
    // Consume a pipe only once, immediately before its authenticated use. Keep
    // it solely in this process's bounded provider session, never in receipts.
    await credential();
    const provider = cloudflarePrivatePairProvider({ accountId: plan.accountId, credential });
    targets.assertPublicationDatabase(firestore, target);
    stage = "preflight";
    const result = await installPrivatePublicRelease({ plan, provider, ledger: privateInstallLedger(firestore), dryRun: false,
      signal: AbortSignal.timeout(120_000), onStage: value => { stage = value; } });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) { if (safeOperatorCode(error)) throw error; throw new PrivateInstallOperatorError(stage); }
  finally { if (connection) await connection.close(); if (app) { const { deleteApp } = await import("firebase-admin/app"); await deleteApp(app); } }
}
if (isMain) main(process.argv.slice(2)).catch(error => {
  process.stderr.write(safeOperatorCode(error) ? JSON.stringify(sdkPacketRefusal(error)) + '\n'
    : `${error instanceof PrivateInstallOperatorError ? error.message : "Private public-release operator cleanup was refused"}\n`); process.exitCode = 1;
});
