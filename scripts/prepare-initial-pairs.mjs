#!/usr/bin/env node
import { assertDevelopmentSource } from "./render-development-config.mjs";
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Validate protected tracked source before loading repository modules, SDKs or
// inherited credential streams. Ignored dependencies belong to that checkout.
export async function main(args, environment) {
  if (![4, 5].includes(args.length) || args[0] !== '--packet' || !args[1] || args[2] !== '--packet-digest' ||
      !/^[a-f0-9]{64}$/.test(args[3] ?? '') || args.length === 5 && !['--apply', '--readback'].includes(args[4])) throw new Error();
  const bytes = readFileSync(args[1]);
  if (!bytes.length || bytes.length > 256 * 1024 || createHash('sha256').update(bytes).digest('hex') !== args[3]) throw new Error();
  const raw = JSON.parse(bytes.toString('utf8'));
  const options = { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } };
  const git = args => execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], options).trim();
  if (!/^[a-f0-9]{40}$/.test(raw.operatorCommitSha ?? '') || git(['rev-parse', 'HEAD']) !== raw.operatorCommitSha ||
      !assertDevelopmentSource(options.cwd)) throw new Error();
  const { parseInitialPairsPacket } = await import('./lib/initial-pairs-packet.mjs');
  const packet = parseInitialPairsPacket(raw, environment), mode = args[4]?.slice(2) ?? 'plan';
  if (mode === 'plan') return { step: packet.step, mode, projectId: packet.credentialIdentity.projectId, authorityReads: 0, authorityWrites: 0 };
  const { assertInitialPairEnvironment } = await import('./lib/initial-pair-environment.mjs');
  assertInitialPairEnvironment(environment);
  const { developmentInstallCredential: pipe, developmentInstallAccess: access } = await import('./lib/development-install-credentials.mjs');
  const { operatorAccount, openOperatorDatabase } = await import('./lib/public-release-operator-io.mjs');
  // Reserve every inherited pipe before any SDK app or source owner loads.
  let parseStorage;
  const pipes = [], sdk = pipe(3, value => operatorAccount(value, packet.credentialIdentity)); pipes.push(sdk);
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let connection, reads, store;
  try {
    let storage, writer, reader, recoveryReader;
    if (mode === 'apply') {
      storage = pipe(4, value => parseStorage(value)); pipes.push(storage);
      if (environment === 'production') { writer = pipe(5, value => parseStorage(value)); pipes.push(writer); }
      if (packet.step === 'qualify') { reader = pipe(6, access); pipes.push(reader); }
      if (packet.step === 'qualify' && environment === 'production') { recoveryReader = pipe(7, access); pipes.push(recoveryReader); }
    }
    connection = await openOperatorDatabase(await sdk.read());
    // Source modules use the first SDK app. It is now this explicit identity;
    // no ambient/default credential app is created by their module imports.
    const { runInitialPairs } = await import('./lib/initial-pairs.mjs');
    const { initialPairNative: native } = await import('./lib/initial-pair-native.mjs');
    const { createBootstrapS3Reads } = native('../site/scripts/public-release-bootstrap-s3-read.ts', import.meta.url);
    parseStorage = native('../site/scripts/cms-preview-storage-credential.ts', import.meta.url).parsePreviewStorageCredential;
    let providerStore;
    if (storage) {
      reads = createBootstrapS3Reads({ environment, readCredential: storage.read });
      const { createInitialPairStore } = await import('./lib/initial-pair-store.mjs');
      store = createInitialPairStore({ environment, pairs: [packet.currentPair, packet.recoveryPair], reads,
        readCredential: writer?.read ?? storage.read, signal: controller.signal });
      const { createPublicReleaseBackgroundReads } = await import('./lib/public-release-background-reads.mjs');
      providerStore = createPublicReleaseBackgroundReads({ environment, app: connection.app, signal: controller.signal });
    }
    return await runInitialPairs({ environment, firestore: connection.firestore, packet, store, providerStore,
      credentials: reader?.read,
      credentialsForPair: recoveryReader ? (_pair, index) => [reader, recoveryReader][index].read : undefined,
      signal: controller.signal, mode });
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    store?.close(); reads?.close(); pipes.forEach(pipe => pipe.close()); await connection?.close();
  }
}
