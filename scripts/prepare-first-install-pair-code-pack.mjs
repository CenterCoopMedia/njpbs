#!/usr/bin/env node
import { assertDevelopmentSource } from "./render-development-config.mjs";
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const defaults = Object.freeze({ arguments: 'arguments-invalid', packet: 'packet-identity', source: 'source-refused',
  target: 'target-refused', import: 'module-import-refused', credential: 'credential-refused', sdk: 'sdk-open-refused',
  freeze: 'freeze-refused', input: 'input-refused', image: 'image-refused', build: 'build-refused', output: 'output-refused' });
const reasons = {
  arguments: new Set([defaults.arguments]),
  packet: new Set(['packet-read', 'packet-size', 'packet-digest', 'packet-json', defaults.packet]),
  source: new Set(['operator-source-unavailable', 'operator-head-mismatch', 'operator-tree-dirty', 'operator-tree-mismatch',
    'target-source-unavailable', 'target-head-mismatch', 'target-tree-dirty', 'target-tree-mismatch']),
};
class PreparationPacketRefusal extends Error {
  constructor(stage, reason) { super('First-install preparation refused'); this.stage = stage; this.reason = reason; }
}
const refuse = (stage = 'packet', reason = defaults[stage]) => { throw new PreparationPacketRefusal(stage, reason); };
const fields = {
  freeze: ['credentialIdentity'],
  'image-context': ['inputDirectory', 'inputDigest'],
  extract: ['inputDirectory', 'inputDigest', 'imageId'],
  build: ['inputDirectory', 'inputDigest', 'imageDirectory', 'imageReceiptDigest'],
};
/** Only built-ins execute before exact packet/operator/target source checks.
 * No credential source, SDK, loader or repository module is opened first. */
export function parseFirstInstallPreparationPacket(mode, packet, environment = 'development') {
  if (!Object.hasOwn(fields, mode)) refuse('arguments');
  const names = ['schemaVersion', 'kind', 'environment', 'operatorCommitSha', 'sourceDirectory', 'commitSha', 'directory',
    'enrollmentRequestDigest', 'logBaselineDigest', ...fields[mode], ...(environment === 'production' ? ['publicBuildSettings'] : [])];
  if (!packet || Object.keys(packet).sort().join() !== names.sort().join() || packet.schemaVersion !== 1 ||
      packet.kind !== 'public-release-first-install-preparation' || !['development', 'production'].includes(environment) || packet.environment !== environment ||
      !['operatorCommitSha', 'commitSha'].every(key => /^[a-f0-9]{40}$/.test(packet[key] ?? '')) ||
      !['enrollmentRequestDigest', 'logBaselineDigest', ...(mode !== 'freeze' ? ['inputDigest'] : []),
        ...(mode === 'build' ? ['imageReceiptDigest'] : [])].every(key => /^[a-f0-9]{64}$/.test(packet[key] ?? '')) ||
      !['sourceDirectory', 'directory', ...(mode !== 'freeze' ? ['inputDirectory'] : []),
        ...(mode === 'build' ? ['imageDirectory'] : [])].every(key => path.isAbsolute(packet[key] ?? '') && path.resolve(packet[key]) === packet[key])) refuse();
  if (mode === 'extract' && !/^sha256:[a-f0-9]{64}$/.test(packet.imageId ?? '')) refuse();
  if (environment === 'production') {
    const settings = packet.publicBuildSettings;
    const publicFields = ['PUBLIC_GA4_MEASUREMENT_ID', 'PUBLIC_REPORT_ENDPOINT', 'PUBLIC_TURNSTILE_SITEKEY', 'PUBLIC_SHARE_INTAKE_ENDPOINT', 'PUBLIC_SHARE_PAGE'];
    const hasUploadOrigin = Object.hasOwn(settings ?? {}, 'PUBLIC_SHARE_UPLOAD_ORIGIN');
    const allowedFields = [...publicFields, ...(hasUploadOrigin ? ['PUBLIC_SHARE_UPLOAD_ORIGIN'] : [])];
    if (!settings || Object.keys(settings).sort().join() !== allowedFields.sort().join() ||
        publicFields.some(key => typeof settings[key] !== 'string' || !settings[key].trim() || settings[key].length > 2048 || /[\r\n]/.test(settings[key]))) refuse();
    const uploadOrigin = settings.PUBLIC_SHARE_UPLOAD_ORIGIN;
    if (hasUploadOrigin && (typeof uploadOrigin !== 'string' || uploadOrigin.length > 2048 || /[\r\n]/.test(uploadOrigin))) refuse();
    if (settings.PUBLIC_SHARE_PAGE === '1' && (!hasUploadOrigin || !uploadOrigin.trim())) refuse();
  }
  const operatorDirectory = path.resolve(root);
  if (packet.directory === operatorDirectory || packet.directory.startsWith(operatorDirectory + path.sep) ||
      packet.directory === packet.sourceDirectory || packet.directory.startsWith(packet.sourceDirectory + path.sep)) refuse();
  return packet;
}
export function readFirstInstallPreparationPacket(args, environment = 'development') {
  const [mode, flag, filename, digestFlag, expectedDigest, ...extra] = args;
  if (!Object.hasOwn(fields, mode) || flag !== '--packet' || digestFlag !== '--packet-digest' ||
      extra.length || !path.isAbsolute(filename ?? '') || !/^[a-f0-9]{64}$/.test(expectedDigest ?? '')) refuse('arguments');
  let bytes, value;
  try { bytes = readFileSync(filename); } catch { refuse('packet', 'packet-read'); }
  if (!bytes.length || bytes.length > 16_384) refuse('packet', 'packet-size');
  if (createHash('sha256').update(bytes).digest('hex') !== expectedDigest) refuse('packet', 'packet-digest');
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { refuse('packet', 'packet-json'); }
  const packet = parseFirstInstallPreparationPacket(mode, value, environment);
  for (const [owner, directory, sha] of [['operator', root, packet.operatorCommitSha], ['target', packet.sourceDirectory, packet.commitSha]]) {
    const git = (...args) => {
      try { return execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', directory, ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      }).trim(); } catch { refuse('source', `${owner}-source-unavailable`); }
    };
    if (git('rev-parse', 'HEAD') !== sha) refuse('source', `${owner}-head-mismatch`);
    try { if (!assertDevelopmentSource(directory)) refuse('source', `${owner}-tree-dirty`); }
    catch (error) { if (error instanceof PreparationPacketRefusal) throw error; refuse('source', `${owner}-tree-dirty`); }
    if (git('rev-parse', 'HEAD^{tree}') !== git('rev-parse', `${sha}^{tree}`)) refuse('source', `${owner}-tree-mismatch`);
  }
  return { mode, packet };
}

export async function runFirstInstallPreparation(args, environment) {
  let connection, reads, storagePipe, unregister, unregisterCommonJS, StageError;
  let stage = 'packet';
  try {
    const { mode, packet } = readFirstInstallPreparationPacket(args, environment);
    // The shared scope gate runs after the built-in source checks and before
    // loaders, SDK modules or credential sources. All owners reuse this gate.
    stage = 'import';
    const { firstInstallPublicationTarget } = await import('../functions/lib/public-release-first-install-target.js');
    stage = 'target'; firstInstallPublicationTarget(packet.environment);
    stage = 'import';
    ({ FirstInstallPreparationStageError: StageError } = await import('./lib/first-install-preparation-stage.mjs'));
    const require = createRequire(new URL('../site/package.json', import.meta.url));
    unregisterCommonJS = require('tsx/cjs/api').register();
    unregister = require('tsx/esm/api').register();
    let result;
    if (mode === 'freeze') {
      const { parseDevelopmentInstallSdkPacket, openDevelopmentInstallSdk } = await import('./lib/development-install-sdk.mjs');
      const { developmentInstallCredential } = await import('./lib/development-install-credentials.mjs');
      const { createBootstrapS3Reads } = await import('../site/scripts/public-release-bootstrap-s3-read.ts');
      const { parsePreviewStorageCredential } = await import('../site/scripts/cms-preview-storage-credential.ts');
      const production = environment === 'production' ? await import('./lib/production-install-binding.mjs') : null;
      const { createPublicReleaseBackgroundReads } = await import('./lib/public-release-background-reads.mjs');
      // The reader factory requires this owner lazily; link it and its storage
      // SDK import before any one-shot credential pipe can be consumed.
      await import('../functions/lib/post-background-storage.js');
      const { freezeFirstInstallPublicReleasePair } = await import('../site/scripts/public-release-first-install-freeze.ts');
      // Preparation and background-storage imports precede credential pipes.
      stage = 'credential';
      if (production) { production.parseProductionInstallIdentity(packet.credentialIdentity); production.assertProductionInstallEnvironment(); }
      const sdkPacket = production ? null : parseDevelopmentInstallSdkPacket({ schemaVersion: 1, kind: 'development-install-sdk',
        operatorCommitSha: packet.operatorCommitSha, credentialIdentity: packet.credentialIdentity });
      // Reserve fd4 before opening SDK sockets. Consume only at the first
      // baseline-authorized immutable dependency GET, never at construction.
      storagePipe = developmentInstallCredential(4, parsePreviewStorageCredential);
      reads = createBootstrapS3Reads({ environment: packet.environment, readCredential: storagePipe.read });
      stage = 'sdk';
      connection = production ? await production.openProductionInstallSdk(packet.credentialIdentity, 3) : await openDevelopmentInstallSdk(sdkPacket, 3);
      stage = 'freeze';
      const providerStore = createPublicReleaseBackgroundReads({ environment: packet.environment, app: connection.app });
      result = await freezeFirstInstallPublicReleasePair({ ...packet, firestore: connection.firestore, providerStore, contentStore: reads });
    } else if (mode === 'image-context' || mode === 'extract') {
      const image = await import('../site/scripts/public-release-first-install-image.ts');
      stage = 'image';
      result = mode === 'image-context' ? await image.prepareFirstInstallPairImage(packet) : await image.extractFirstInstallPairImage(packet);
    } else {
      const { buildFirstInstallPublicReleasePair } = await import('../site/scripts/public-release-first-install-build.ts');
      stage = 'build'; result = await buildFirstInstallPublicReleasePair(packet);
    }
    stage = 'output'; process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    let reason = defaults[stage];
    if (error instanceof PreparationPacketRefusal && reasons[error.stage]?.has(error.reason)) {
      stage = error.stage; reason = error.reason;
    } else if (StageError && error instanceof StageError && ['input', 'image'].includes(error.stage)) {
      stage = error.stage; reason = defaults[stage];
    }
    process.stderr.write(JSON.stringify({ status: 'refused', code: 'first-install-code-pack-refused', stage, reason }) + '\n');
    process.exitCode = 1;
  } finally {
    try { reads?.close(); storagePipe?.close(); await connection?.close(); await unregister?.(); unregisterCommonJS?.(); }
    catch { process.exitCode = 1; }
  }
}
