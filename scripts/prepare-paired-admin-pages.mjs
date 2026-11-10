#!/usr/bin/env node
import { assertDevelopmentSource } from "./render-development-config.mjs";
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, mkdir, readFile, writeFile, lstat, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join, sep } from 'node:path';
import { preparePairedAdminArtifact, pairedAdminWorkerMetadata, pairedAdminArtifactContents } from './lib/paired-admin-pages-artifact.mjs';
import { PairedAdminProviderError } from './lib/paired-admin-provider-operation.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const inputSeals = new WeakMap();
function source() {
  const options = { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/nonexistent', LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'ignore'] };
  const args = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
  const sha = execFileSync('/usr/bin/git', [...args, 'rev-parse', 'HEAD'], options).trim();
  if (!/^[a-f0-9]{40}$/.test(sha) || !assertDevelopmentSource(options.cwd)) {
    throw new Error('Source refused');
  }
  return sha;
}
export async function preparePairedAdminPagesInputs(args) {
  if (args.length !== 4) throw new Error('Arguments refused');
  const [environment, sourceSha, directory, output] = args;
  if (!['development', 'production'].includes(environment)) throw new Error('Arguments refused');
  if (source() !== sourceSha) throw new Error('Source refused');
  const sealedDirectory = resolve(output);
  const artifactDirectory = resolve(directory);
  if (sealedDirectory === root.slice(0, -1) || sealedDirectory.startsWith(root) ||
      sealedDirectory === artifactDirectory || sealedDirectory.startsWith(`${artifactDirectory}${sep}`)) throw new Error('Seal directory refused');
  let fresh = false;
  try { await mkdir(sealedDirectory, { mode: 0o700 }); fresh = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const state = await lstat(sealedDirectory);
  if (!state.isDirectory() || state.isSymbolicLink() || state.mode & 0o077 ||
      process.getuid && state.uid !== process.getuid()) throw new Error('Seal directory refused');
  const lock = join(sealedDirectory, '.paired-admin-lock');
  await mkdir(lock);
  let scratch;
  try {
    const sealPath = join(sealedDirectory, 'sealed.json'), bundlePath = join(sealedDirectory, 'worker.bundle');
    if (!fresh) {
      const metadata = await lstat(sealPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 8 * 1024 * 1024) throw new Error('Seal refused');
      const bytes = await readFile(sealPath), sealed = JSON.parse(bytes.toString('utf8'));
      if (sealed.environment !== environment || sealed.sourceSha !== sourceSha) throw new Error('Seal source refused');
      const prepared = await preparePairedAdminArtifact({ environment, sourceSha, directory,
        ...(environment === 'production' ? { workerBundlePath: bundlePath, workerBundleContentType: sealed.workerBundleContentType } : {}) });
      if (!bytes.equals(Buffer.from(JSON.stringify(prepared) + '\n')) || source() !== sourceSha) throw new Error('Seal inputs changed');
      inputSeals.set(prepared, createHash('sha256').update(bytes).digest('hex'));
      return prepared;
    }
    let workerModulePath = null;
    if (environment === 'production') {
      scratch = await mkdtemp(join(tmpdir(), 'paired-admin-worker-'));
      workerModulePath = join(scratch, 'worker.js');
      const metadata = await pairedAdminWorkerMetadata();
      // Compile only the canonical Pages middleware. No app/image build,
      // credential environment, deployment command or provider request.
      execFileSync(process.execPath, [join(root, 'node_modules/wrangler/wrangler-dist/cli.js'), 'pages', 'functions', 'build',
        join(root, 'admin/functions'), '--outfile', workerModulePath, '--project-directory', scratch,
        '--compatibility-date', metadata.compatibility_date, '--minify'],
      { cwd: scratch, env: { PATH: process.env.PATH, HOME: scratch, WRANGLER_SEND_METRICS: 'false',
        CLOUDFLARE_API_BASE_URL: 'http://127.0.0.1:1' }, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 });
    }
    const prepared = await preparePairedAdminArtifact({ environment, sourceSha, directory, workerModulePath });
    if (source() !== sourceSha) throw new Error('Source refused');
    const bundle = pairedAdminArtifactContents(prepared).workerBundle;
    if (bundle) await writeFile(bundlePath, bundle, { flag: 'wx', mode: 0o600 });
    const bytes = JSON.stringify(prepared) + '\n';
    await writeFile(sealPath, bytes, { flag: 'wx', mode: 0o600 });
    inputSeals.set(prepared, createHash('sha256').update(bytes).digest('hex'));
    return prepared;
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
    await rmdir(lock);
  }
}
export async function preparePairedAdminPages(args) {
  const prepared = await preparePairedAdminPagesInputs(args);
  const { environment, sourceSha } = prepared;
  return { schemaVersion: 2, kind: 'sealed-paired-admin-input', sourceSha, environment,
    manifestDigest: prepared.manifestDigest, artifactDigest: prepared.artifactDigest,
    publicFileCount: prepared.publicMembers.length, publicByteCount: prepared.publicMembers.reduce((sum, file) => sum + file.size, 0),
    workerBundleDigest: prepared.workerBundleDigest, configurationCount: prepared.configuration.length,
    sealedInputDigest: inputSeals.get(prepared),
    providerRequests: 0, productionAdoption: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(await preparePairedAdminPages(process.argv.slice(2)))}\n`); }
  catch (error) {
    const code = error instanceof PairedAdminProviderError ? error.code : 'preparation-refused';
    process.stderr.write(`Paired Admin preparation refused: ${code}.\n`);
    process.exitCode = 1;
  }
}
