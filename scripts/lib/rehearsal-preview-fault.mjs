import { createHash } from 'node:crypto';
import { DEV_TARGETS } from '../assert-dev-cms-targets.mjs';

const faults = new WeakMap();
const boundaries = ['functions', 'preview-rollout', 'admin-assets', 'cancellation'];
const refuse = () => { throw new Error('Rehearsal preview fault boundary refused'); };

/** A fault exists only in this explicit development rehearsal transport. It
 * intercepts one named external boundary before dispatch. It never changes
 * provider success bytes or sends a resource mutation to manufacture failure. */
export function createRehearsalPreviewFault({ boundary, projectId, emulatorHost, prepared, fetchImpl = fetch, signal,
  authorized = false }) {
  const demo = /^demo-[a-z0-9-]+$/.test(projectId) && /^127\.0\.0\.1:\d+$/.test(emulatorHost) &&
    process.env.FIRESTORE_EMULATOR_HOST === emulatorHost && fetchImpl !== fetch;
  const development = projectId === 'njpbs-site-dev' && emulatorHost === null && process.env.FIRESTORE_EMULATOR_HOST === undefined;
  if (authorized !== true || !boundaries.includes(boundary) || (!demo && !development) || typeof fetchImpl !== 'function') refuse();
  if (boundary === 'preview-rollout' && (prepared?.environment !== 'development' ||
      !/^njpbs-preview-[a-z0-9][a-z0-9-]{0,31}$/.test(prepared.applicationName))) refuse();
  const controller = new AbortController();
  const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
  const state = { armed: false, hit: null, controller, boundary };
  const handle = Object.freeze({ boundary, signal: combined, async fetch(input, init = {}) {
    combined.throwIfAborted();
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const plain = !url.username && !url.password && !url.hash;
    const functions = plain && url.search === '?pageSize=100' && method === 'GET' && url.origin === 'https://cloudfunctions.googleapis.com' &&
      url.pathname === `/v2/projects/${DEV_TARGETS.FIREBASE_PROJECT_ID}/locations/us-central1/functions`;
    const rollout = plain && url.search === '?include=modules' && method === 'GET' && url.origin === 'https://api.cloudflare.com' &&
      url.pathname.startsWith(`/client/v4/accounts/${DEV_TARGETS.CLOUDFLARE_ACCOUNT_ID}/workers/workers/${prepared?.applicationName}/versions/`) &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(url.pathname.split('/').at(-1));
    const assets = plain && !url.search && method === 'POST' && url.origin === 'https://api.cloudflare.com' &&
      url.pathname === '/client/v4/pages/assets/upload';
    const matches = boundary === 'functions' ? functions : boundary === 'preview-rollout' ? rollout : assets;
    if (state.armed && matches) {
      state.armed = false;
      state.hit = Object.freeze({ schemaVersion: 1, boundary, method,
        requestDigest: createHash('sha256').update(`${method}\n${url.origin}${url.pathname}`).digest('hex'),
        dispatched: false });
      if (boundary === 'cancellation') controller.abort();
      throw new Error('Named rehearsal preview boundary interrupted');
    }
    return fetchImpl(input, { ...init, signal: AbortSignal.any([combined, ...(init.signal ? [init.signal] : [])]) });
  } });
  faults.set(handle, state);
  return handle;
}

/** Arm only after original intent and baseline observations are durable. */
export function armRehearsalPreviewFault(handle) {
  const state = faults.get(handle);
  if (!state || state.armed || state.hit || state.controller.signal.aborted) refuse();
  state.armed = true;
}

/** This opaque witness proves the named interception happened. An unrelated
 * exception or a copied/serialized handle cannot certify a negative scenario. */
export function readRehearsalPreviewFault(handle) {
  const state = faults.get(handle);
  if (!state?.hit || state.armed) refuse();
  return state.hit;
}
