import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { constants } from 'node:fs';
import { lstat, readdir, open, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { refuseAdminProvider } from './paired-admin-provider-operation.mjs';

const require = createRequire(import.meta.url);
const api = require('../../functions/lib/cms-preview-pair.js');
const wranglerRequire = createRequire(require.resolve('wrangler'));
const artifacts = new WeakMap();
const SHA = /^[a-f0-9]{40}$/;
const SPECIAL = ['_headers', '_redirects', '_routes.json'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const maxFile = 25 * 1024 * 1024, maxTotal = 256 * 1024 * 1024, maxFiles = 20_000;
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
async function fileBytes(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxFile) refuseAdminProvider('artifact-file-invalid');
    const bytes = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const part = await handle.read(bytes, size, bytes.length - size, size);
      if (!part.bytesRead) break;
      size += part.bytesRead;
    }
    const after = await handle.stat();
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) refuseAdminProvider('artifact-changed');
    return bytes.subarray(0, size);
  } finally { await handle.close(); }
}
export async function pairedAdminWorkerMetadata() {
  const text = await readFile(new URL('../../admin/wrangler.jsonc', import.meta.url), 'utf8');
  const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
  const services = [{ binding: 'STAFF_ACCESS', service: 'njpbs-cms-api', entrypoint: 'StaffSiteEntrypoint' }];
  const buckets = [{ binding: 'GUIDE_VIDEOS', bucket_name: 'njpbs-admin-guide' }];
  if (config.name !== 'njpbs-admin' || config.pages_build_output_dir !== './dist' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(config.compatibility_date) || api.digest(config.services) !== api.digest(services) ||
      api.digest(config.r2_buckets) !== api.digest(buckets) ||
      Object.keys(config).some(key => !['name', 'pages_build_output_dir', 'compatibility_date', 'services', 'r2_buckets'].includes(key))) {
    refuseAdminProvider('artifact-worker-configuration-invalid');
  }
  return { main_module: 'worker.js', compatibility_date: config.compatibility_date,
    bindings: [{ name: 'STAFF_ACCESS', type: 'service', service: 'njpbs-cms-api', entrypoint: 'StaffSiteEntrypoint' },
      { name: 'GUIDE_VIDEOS', type: 'r2_bucket', bucket_name: 'njpbs-admin-guide' }] };
}
/** Package a previously compiled single Worker without a deployment command.
 * A deterministic boundary preserves the exact payload on later preparation. */
export async function packPairedAdminWorker(modulePath) {
  const module = await fileBytes(modulePath), metadata = JSON.stringify(await pairedAdminWorkerMetadata());
  if (!module.length) refuseAdminProvider('artifact-worker-invalid');
  const boundary = `paired-admin-${sha(Buffer.concat([Buffer.from(metadata), module]))}`;
  const bytes = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="worker.js"; filename="worker.js"\r\nContent-Type: application/javascript+module\r\n\r\n`),
    module, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  if (bytes.length > maxFile) refuseAdminProvider('artifact-worker-invalid');
  return { bytes, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Freeze existing build output in memory before any credential or provider
 * operation. Pages' private Functions bundle is a separate sealed input. */
export async function preparePairedAdminArtifact({ directory, sourceSha, environment, workerBundlePath = null,
  workerBundleContentType = null, workerModulePath = null }) {
  if (!SHA.test(sourceSha) || !['development', 'production'].includes(environment) ||
      typeof directory !== 'string' || environment === 'production' && !workerBundlePath && !workerModulePath ||
      workerBundlePath && workerModulePath || environment === 'development' && (workerBundlePath || workerModulePath)) refuseAdminProvider('artifact-input-invalid');
  if (require('wrangler/package.json').version !== '4.134.0') refuseAdminProvider('artifact-toolchain-invalid');
  const root = resolve(directory), rootState = await lstat(root);
  if (!rootState.isDirectory() || rootState.isSymbolicLink()) refuseAdminProvider('artifact-path-invalid');
  const mime = require('mime');
  const { hash } = wranglerRequire('blake3-wasm');
  const files = new Map(), special = new Map();
  let size = 0, count = 0;
  async function member(path) {
    const file = join(root, path), state = await lstat(file);
    if (state.isSymbolicLink()) refuseAdminProvider('artifact-path-invalid');
    if (state.isDirectory()) {
      for (const name of (await readdir(file)).sort()) {
        if (!/^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*$/.test(name)) refuseAdminProvider('artifact-path-invalid');
        await member(path ? `${path}/${name}` : name);
      }
      return;
    }
    if (!state.isFile() || state.size > maxFile || ++count > maxFiles || (size += state.size) > maxTotal ||
        path.split('/').some(part => part === 'functions' || part === '_worker.js' || part === '_worker.bundle')) refuseAdminProvider('artifact-file-invalid');
    const bytes = await fileBytes(file);
    if (bytes.length !== state.size || bytes.length > maxFile) refuseAdminProvider('artifact-changed');
    const row = { path: `/${path}`, sha256: sha(bytes), size: bytes.length,
      contentType: mime.getType(path) ?? 'application/octet-stream' };
    if (SPECIAL.includes(path)) special.set(path, { ...row, bytes });
    else {
      // Same content hash as the pinned Pages Direct Upload implementation.
      const hashValue = hash(bytes.toString('base64') + extname(path).substring(1)).toString('hex').slice(0, 32);
      files.set(row.path, { ...row, hash: hashValue, bytes });
    }
  }
  const names = (await readdir(root)).sort();
  if (!names.includes('index.html') || !names.includes('admin-status.json')) refuseAdminProvider('artifact-shell-missing');
  for (const name of names) {
    if (!/^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*$/.test(name)) refuseAdminProvider('artifact-path-invalid');
    await member(name);
  }
  let workerBundle = null;
  if (workerModulePath !== null) {
    const packed = await packPairedAdminWorker(workerModulePath);
    workerBundle = packed.bytes; workerBundleContentType = packed.contentType;
  }
  if (workerBundlePath !== null) {
    const boundary = /^multipart\/form-data; ?boundary=([A-Za-z0-9_-]{1,100})$/.exec(workerBundleContentType ?? '');
    if (!boundary) refuseAdminProvider('artifact-worker-invalid');
    const state = await lstat(workerBundlePath);
    if (!state.isFile() || state.isSymbolicLink() || state.size > maxFile) refuseAdminProvider('artifact-worker-invalid');
    workerBundle = await fileBytes(workerBundlePath);
    if (!workerBundle.length || workerBundle.length !== state.size ||
        !workerBundle.subarray(0, boundary[1].length + 2).equals(Buffer.from(`--${boundary[1]}`)) ||
        !workerBundle.includes(Buffer.from('name="metadata"'))) refuseAdminProvider('artifact-worker-invalid');
  }
  if (workerBundle) {
    try {
      const parts = await new Response(workerBundle, { headers: { 'content-type': workerBundleContentType } }).formData();
      if ([...parts.keys()].sort().join(',') !== 'metadata,worker.js' ||
          api.digest(JSON.parse(String(parts.get('metadata')))) !== api.digest(await pairedAdminWorkerMetadata()) ||
          !(parts.get('worker.js') instanceof Blob) || !parts.get('worker.js').size) refuseAdminProvider('artifact-worker-invalid');
    } catch { refuseAdminProvider('artifact-worker-invalid'); }
  }
  if (!files.has('/index.html') || !files.has('/admin-status.json')) refuseAdminProvider('artifact-shell-missing');
  let status;
  try { status = JSON.parse(files.get('/admin-status.json').bytes.toString('utf8')); }
  catch { refuseAdminProvider('artifact-status-invalid'); }
  if (![1, 2].includes(status.schemaVersion) || status.status !== 'current' || status.build?.revision !== sourceSha ||
      status.environment !== (environment === 'production' ? 'Production' : 'Development')) refuseAdminProvider('artifact-status-invalid');
  const publicMembers = [...files.values()].map(({ path, sha256, size, contentType, hash }) => ({ path, sha256, size, contentType, hash }));
  const configuration = [...special.values()].map(({ path, sha256, size }) => ({ path, sha256, size }));
  const descriptor = { schemaVersion: 2, sourceSha, environment, publicMembers, configuration,
    workerBundleDigest: workerBundle ? sha(workerBundle) : null, workerBundleContentType };
  const manifestDigest = api.digest(descriptor);
  const handle = freeze({ ...descriptor, manifestDigest, artifactDigest: manifestDigest });
  artifacts.set(handle, { files, special, workerBundle });
  return handle;
}

export function pairedAdminArtifactContents(handle) {
  const value = artifacts.get(handle);
  if (!value) refuseAdminProvider('artifact-unsealed');
  return { files: [...value.files.values()].map(row => ({ ...row, bytes: Buffer.from(row.bytes) })),
    special: [...value.special.entries()].map(([name, row]) => [name, Buffer.from(row.bytes)]),
    workerBundle: value.workerBundle ? Buffer.from(value.workerBundle) : null };
}
