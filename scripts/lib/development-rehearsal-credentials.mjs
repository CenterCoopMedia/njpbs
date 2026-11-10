import { fstatSync } from 'node:fs';
import { Socket } from 'node:net';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseDevOperatorCredential } from './dev-proof-admission.mjs';

const require = createRequire(import.meta.url);
const projectId = 'njpbs-site-dev';
const sources = new WeakMap();
const refuse = () => { throw new Error('Development rehearsal credential refused'); };

export function assertDevelopmentRehearsalEnvironment(env = process.env) {
  if (['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_CONFIG']
    // config-input: FIREBASE_AUTH_EMULATOR_HOST, FIREBASE_CONFIG, FIRESTORE_EMULATOR_HOST, GCLOUD_PROJECT
    // config-input: GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_CLOUD_PROJECT
    .some(key => env[key] !== undefined)) refuse();
  for (const key of ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT'])
    // config-input: FIREBASE_AUTH_EMULATOR_HOST, FIREBASE_CONFIG, FIRESTORE_EMULATOR_HOST, GCLOUD_PROJECT
    // config-input: GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_CLOUD_PROJECT
    if (env[key] !== undefined && env[key] !== projectId) refuse();
}

function inheritedCredential() {
  try {
    const stat = fstatSync(3);
    if (!stat.isFIFO() && !stat.isSocket()) refuse();
    // A libuv pipe handle can cancel a pending read. fs.ReadStream on a
    // blocking inherited pipe can keep its threadpool read alive after timeout.
    return new Socket({ fd: 3, readable: true, writable: false, pauseOnCreate: true });
  } catch { refuse(); }
}

async function readCredential(stream) {
  const chunks = [];
  let size = 0;
  const timeout = setTimeout(() => stream.destroy(new Error('Development rehearsal credential refused')), 10_000);
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      chunks.push(bytes);
      if (size > 32_768) refuse();
    }
    const bytes = Buffer.concat(chunks);
    try { parseDevOperatorCredential(bytes.toString('utf8')); }
    catch { bytes.fill(0); refuse(); }
    return bytes;
  } catch {
    refuse();
  } finally {
    clearTimeout(timeout);
    chunks.forEach(chunk => chunk.fill(0));
  }
}

/** The CLI uses inherited pipe fd3. A supplied stream is the process boundary
 * for tests or another approved in-memory launcher. No value is fetched here. */
export function createDevelopmentCredentialSource(stream = null) {
  if (stream !== null && typeof stream?.[Symbol.asyncIterator] !== 'function') refuse();
  // Reserve fd3 before any adapter child can cause descriptor reuse. Wrapping
  // the nonflowing stream does not fetch or consume its credential bytes.
  stream ??= inheritedCredential();
  const handle = Object.freeze({});
  sources.set(handle, { stream, pending: null, bytes: null, closed: false });
  return handle;
}

export function hasDevelopmentCredentialSource(handle) {
  return sources.has(handle) && !sources.get(handle).closed;
}

async function sourceCredential(handle) {
  const source = sources.get(handle);
  if (!source || source.closed) refuse();
  assertDevelopmentRehearsalEnvironment();
  source.pending ??= (async () => {
    source.bytes = await readCredential(source.stream);
    if (source.closed) { source.bytes.fill(0); refuse(); }
    return source.bytes;
  })();
  return source.pending;
}

export async function writeDevelopmentCredential(handle, destination) {
  try { await pipeline(Readable.from([await sourceCredential(handle)]), destination); }
  catch { refuse(); }
}

/** Same closed source as child fd3, with no serializable account fields. The
 * parent needs its own read-only SDK context to verify original proof facts. */
export async function openDevelopmentSourceContext(handle) {
  const bytes = await sourceCredential(handle);
  try { return new DevelopmentRehearsalContext(parseDevOperatorCredential(bytes.toString('utf8'))); }
  catch { refuse(); }
}

export function closeDevelopmentCredentialSource(handle) {
  const source = sources.get(handle);
  if (!source) return;
  source.closed = true;
  source.bytes?.fill(0);
  source.stream?.destroy();
}

class DevelopmentRehearsalContext {
  #account;
  #projectId;
  #emulatorHost;
  #app = null;
  #database = null;
  #closed = false;
  constructor(account, selectedProjectId = projectId, emulatorHost = null) {
    this.#account = account; this.#projectId = selectedProjectId; this.#emulatorHost = emulatorHost;
  }
  get projectId() { return this.#projectId; }
  get firestore() {
    if (this.#closed) refuse();
    if (this.#emulatorHost) assertDemoRehearsalEnvironment({ schemaVersion: 1, projectId: this.#projectId, emulatorHost: this.#emulatorHost });
    else assertDevelopmentRehearsalEnvironment();
    if (!this.#app) {
      const { cert, initializeApp } = require('firebase-admin/app');
      this.#app = initializeApp({ projectId: this.#projectId,
        ...(this.#account ? { credential: cert(this.#account) } : {}) }, `development-rehearsal-${process.pid}`);
      this.#database = require('firebase-admin/firestore').getFirestore(this.#app);
    }
    return this.#database;
  }
  async close() {
    this.#closed = true;
    this.#account = null;
    if (this.#app) await require('firebase-admin/app').deleteApp(this.#app);
  }
}

/** Explicit emulator only. No credential source, ADC path or real project can
 * enter this context; the SDK stays lazy until a real proof needs authority. */
export function assertDemoRehearsalEnvironment(packet) {
  if (packet?.schemaVersion !== 1 || !/^demo-[a-z0-9-]+$/.test(packet.projectId) ||
      !/^127\.0\.0\.1:\d+$/.test(packet.emulatorHost) || process.env.FIRESTORE_EMULATOR_HOST !== packet.emulatorHost ||
      // config-input: FIREBASE_AUTH_EMULATOR_HOST, FIREBASE_CONFIG, FIRESTORE_EMULATOR_HOST, GCLOUD_PROJECT
      // config-input: GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_CLOUD_PROJECT
      ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_CONFIG', 'FIREBASE_AUTH_EMULATOR_HOST'].some(key => process.env[key] !== undefined) ||
      // config-input: FIREBASE_AUTH_EMULATOR_HOST, FIREBASE_CONFIG, FIRESTORE_EMULATOR_HOST, GCLOUD_PROJECT
      // config-input: GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_CLOUD_PROJECT
      ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT'].some(key => process.env[key] !== undefined && process.env[key] !== packet.projectId)) refuse();
}
export function openDemoRehearsalContext(packet) {
  assertDemoRehearsalEnvironment(packet);
  return new DevelopmentRehearsalContext(null, packet.projectId, packet.emulatorHost);
}

/** A real development SDK client is lazy: an unbound adapter makes no SDK call.
 * The context and source handle expose no serializable credential fields. */
export async function openDevelopmentRehearsalContext(stream = null) {
  assertDevelopmentRehearsalEnvironment();
  stream ??= inheritedCredential();
  const bytes = await readCredential(stream);
  try { return new DevelopmentRehearsalContext(parseDevOperatorCredential(bytes.toString('utf8'))); }
  finally { bytes.fill(0); }
}
