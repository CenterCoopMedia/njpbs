import { randomBytes, timingSafeEqual } from 'node:crypto';

const sessions = new WeakMap();
const refuse = () => { throw new Error('Rehearsal HTTP credential refused'); };

/** Opaque process-local capability: JSON and inspection expose no token. */
export function createRehearsalHttpCredential() {
  const credential = Object.freeze({});
  sessions.set(credential, { token: randomBytes(32), origins: new Set() });
  return credential;
}
export function bindRehearsalHttpCredential(credential, origins) {
  const state = sessions.get(credential);
  if (!state || state.origins.size || !Array.isArray(origins) || origins.length !== 2 || new Set(origins).size !== 2) refuse();
  try {
    for (const origin of origins) {
      if (typeof origin !== 'string') refuse();
      const url = new URL(origin);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.origin !== origin) refuse();
    }
  } catch { refuse(); }
  state.origins = new Set(origins);
}
export function hasRehearsalHttpCredential(credential, origins = []) {
  const state = sessions.get(credential);
  return Boolean(state?.origins.size === 2 && origins.every(origin => state.origins.has(origin)));
}
export function rehearsalHttpHeaders(credential, origin) {
  if (!hasRehearsalHttpCredential(credential, [origin])) refuse();
  return { authorization: `Bearer ${sessions.get(credential).token.toString('base64url')}` };
}
export function acceptRehearsalHttpAuthorization(credential, origin, authorization) {
  if (!hasRehearsalHttpCredential(credential, [origin]) || typeof authorization !== 'string' ||
      !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) return false;
  const actual = Buffer.from(authorization), expected = Buffer.from(rehearsalHttpHeaders(credential, origin).authorization);
  try { return timingSafeEqual(actual, expected); }
  finally { actual.fill(0); expected.fill(0); }
}
export function closeRehearsalHttpCredential(credential) {
  const state = sessions.get(credential);
  if (!state) return;
  state.token.fill(0); state.origins.clear(); sessions.delete(credential);
}
