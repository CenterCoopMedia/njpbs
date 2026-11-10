import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import core from '../../functions/lib/video-transcription-credentials.js';
import handlers from '../../functions/video-transcription-credentials.js';

const actor = { uid: 'alice', principal: { grants: [{ role: 'staff' }] } };
const request = { scope: 'personal', provider: 'elevenlabs', expectedRevision: 0, key: 'synthetic-provider-key-only' };
const key = Buffer.alloc(32, 7);
const audit = (entry) => entry;
function store() {
  const rows = new Map([['users/alice', { active: true, grants: [{ role: 'staff' }] }]]); let sequence = 0; let tail = Promise.resolve();
  const ref = (collection, id = `audit-${++sequence}`) => ({ path: `${collection}/${id}`, get: async () => {
    const value = rows.get(`${collection}/${id}`);
    return { exists: value !== undefined, data: () => structuredClone(value) };
  } });
  const firestore = { collection: (name) => ({ doc: (id) => ref(name, id) }), runTransaction: (fn) => {
    const run = tail.then(async () => {
      const pending = [];
      const result = await fn({ get: async (reference) => reference.get(), set: (reference, value) => pending.push([reference.path, structuredClone(value)]), create: (reference, value) => pending.push([reference.path, structuredClone(value)]) });
      for (const [path, value] of pending) rows.set(path, value);
      return result;
    }); tail = run.catch(() => {}); return run;
  } };
  return { rows, firestore };
}
const options = (db, extra = {}) => ({ firestore: db.firestore, actor, request, key: Buffer.from(key), keyVersion: '1', audit, ...extra });
function http(dependencies = {}) {
  const db = store(); let secretReads = 0;
  const handler = (operation) => handlers.createCredentialHandler(operation, { firestore: db.firestore,
    verifyAppCheckFn: async () => {}, requirePrincipalFn: async () => actor, authorizeSourceFn: async () => {}, registryFn: () => new Map(),
    activeAccountFn: async () => true, assertBillingEnabledFn: async () => {},
    keyFn: () => { secretReads++; return key.toString('base64'); }, keyVersionFn: () => '1', audit, log: { warn: () => {} }, ...dependencies });
  const call = async (operation, body) => {
    const res = { code: null, body: null, set() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler(operation)({ method: 'POST', body, rawBody: Buffer.from(JSON.stringify(body)), headers: { 'content-type': 'application/json' } }, res);
    return res;
  };
  return { ...db, call, secretReads: () => secretReads };
}

describe('encrypted transcription credentials', () => {
  it.each(['"', '\\'])('saves maximum-length keys with JSON escaping for %s', async (character) => {
    const api = http(); const escaped = { ...request, key: character.repeat(4096) };
    expect(Buffer.byteLength(JSON.stringify(escaped))).toBeGreaterThan(8 * 1024);
    expect((await api.call('save', escaped)).code).toBe(200);
    const identity = core.credentialIdentity(actor, escaped);
    const record = api.rows.get(`${core.CREDENTIAL_COLLECTION}/${identity.id}`);
    const plaintext = core.decryptCredential(record, { ...identity, revision: 1 }, key, '1');
    expect(plaintext.toString()).toBe(escaped.key); plaintext.fill(0);
  });
  it('rejects oversized credential bodies before secret access', async () => {
    const api = http();
    expect((await api.call('save', { ...request, key: 'x'.repeat(16 * 1024) })).code).toBe(413);
    expect(api.secretReads()).toBe(0); expect([...api.rows.keys()].some((path) => path.startsWith(`${core.CREDENTIAL_COLLECTION}/`))).toBe(false);
  });
  it('accepts only the bounded provider/scope and derives personal ownership', () => {
    expect(core.parseCredentialRequest(request, 'save')).toEqual(request);
    for (const patch of [{ ownerUid: 'bob' }, { provider: 'gemini' }, { provider: 'openai' }, { scope: 'all' }, { key: 'bad\nkey' }, { expectedRevision: -1 }]) {
      expect(() => core.parseCredentialRequest({ ...request, ...patch }, 'save')).toThrow();
    }
    expect(core.credentialIdentity(actor, request)).not.toEqual(core.credentialIdentity({ uid: 'bob' }, request));
  });
  it('requires active library access and global administrator settings rights for station keys', async () => {
    await expect(core.authorizeCredentialScope({ actor, scope: 'personal', activeAccount: async () => false })).rejects.toMatchObject({ status: 403 });
    await expect(core.authorizeCredentialScope({ actor: { ...actor, principal: { grants: [{ role: 'editor' }] } }, scope: 'organization', activeAccount: async () => true })).rejects.toMatchObject({ status: 403 });
    await expect(core.authorizeCredentialScope({ actor: { ...actor, principal: { grants: [{ role: 'admin' }] } }, scope: 'organization', activeAccount: async () => true })).resolves.toBeUndefined();
  });
  it('encrypts every save with a fresh nonce and authenticates owner/provider/version and payload', async () => {
    const db = store(); await core.saveCredential(options(db));
    const identity = core.credentialIdentity(actor, request);
    const record = db.rows.get(`${core.CREDENTIAL_COLLECTION}/${identity.id}`);
    expect(JSON.stringify([...db.rows.values()])).not.toContain(request.key);
    const expected = { ...identity, revision: 1 };
    const plaintext = core.decryptCredential(record, expected, key, '1');
    expect(plaintext.toString()).toBe(request.key); plaintext.fill(0);
    const encrypted = core.encryptCredential(request.key, record, key);
    expect(encrypted.nonce).not.toBe(record.nonce);
    for (const change of [{ ownerUid: 'bob' }, { scope: 'organization' }, { provider: 'gemini' }, { revision: 2 }, { keyVersion: '2' }, { enabled: false }, { ciphertext: crypto.randomBytes(32).toString('base64') }, { authTag: Buffer.alloc(16).toString('base64') }, { nonce: Buffer.alloc(12).toString('base64') }]) {
      expect(() => core.decryptCredential({ ...record, ...change }, expected, key, '1')).toThrow();
    }
    expect(() => core.decryptCredential({ ...record, ownerUid: 'bob' }, { ...expected, ownerUid: 'bob' }, key, '1')).toThrow();
    expect(() => core.encryptionKey('not-base64')).toThrow();
  });
  it('allows only one concurrent replacement, lists safe owner metadata and retains disabled CAS tombstone', async () => {
    const db = store();
    const results = await Promise.allSettled([core.saveCredential(options(db)), core.saveCredential(options(db))]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const listed = await core.listCredential(options(db));
    expect(listed.credentials[0]).toMatchObject({ configured: true, verification: 'unverified', revision: 1 });
    expect(Object.keys(listed.credentials[0]).sort()).toEqual(['configured', 'id', 'provider', 'revision', 'scope', 'updatedAt', 'verification'].sort());
    expect((await core.listCredential(options(db, { actor: { uid: 'bob' } }))).credentials).toEqual([]);
    await core.disconnectCredential(options(db, { request: { ...request, expectedRevision: 1 } }));
    const record = [...db.rows].find(([path]) => path.startsWith(core.CREDENTIAL_COLLECTION + '/'))[1];
    expect(record).toMatchObject({ enabled: false, revision: 2 });
    expect(record.ciphertext).toBeUndefined();
    await expect(core.saveCredential(options(db, { request: { ...request, expectedRevision: 1 } }))).rejects.toMatchObject({ status: 409 });
    expect((await core.saveCredential(options(db, { request: { ...request, expectedRevision: 2 } }))).credential.revision).toBe(3);
  });
  it('rechecks current account and station-key authority inside each mutation transaction', async () => {
    const organizationActor = { uid: 'alice', principal: { grants: [{ role: 'admin' }] } };
    const organizationRequest = { ...request, scope: 'organization' };
    const db = store();
    db.rows.set('users/alice', { active: true, role: 'admin' });
    await core.saveCredential(options(db, { actor: organizationActor, request: organizationRequest }));

    db.rows.set('users/alice', { active: true, role: null, grants: [] });
    await expect(core.saveCredential(options(db, {
      actor: organizationActor,
      request: { ...organizationRequest, expectedRevision: 1 },
    }))).rejects.toMatchObject({ status: 403 });

    db.rows.set('users/alice', { active: false, role: 'admin' });
    await expect(core.disconnectCredential(options(db, {
      actor: organizationActor,
      request: { ...organizationRequest, expectedRevision: 1 },
    }))).rejects.toMatchObject({ status: 403 });
  });
  it('checks App Check, source authorization and billing before secret access, sanitizes unexpected failures', async () => {
    for (const dependency of [{ verifyAppCheckFn: async () => { throw Object.assign(Error(request.key), { status: 401 }); } }, { authorizeSourceFn: async () => { throw Object.assign(Error(request.key), { status: 403 }); } }, { assertBillingEnabledFn: async () => { throw Error(request.key); } }]) {
      const api = http(dependency); const result = await api.call('save', request);
      expect([401, 403, 503]).toContain(result.code); expect(JSON.stringify(result.body)).not.toContain(request.key);
      expect(api.secretReads()).toBe(0); expect([...api.rows.keys()].some((path) => path.startsWith(`${core.CREDENTIAL_COLLECTION}/`))).toBe(false);
    }
    const api = http({ keyFn: () => { throw Error(request.key); } });
    const result = await api.call('save', request);
    expect(result.code).toBe(500); expect(JSON.stringify(result.body)).not.toContain(request.key);
  });
  it('saves unverified configuration without a provider call; list and disconnect need no secret or billing access', async () => {
    const api = http(); const saved = await api.call('save', request);
    expect(saved.code).toBe(200); expect(saved.body.credential.verification).toBe('unverified');
    expect(JSON.stringify(saved.body)).not.toContain(request.key);
    expect((await api.call('list', { scope: 'personal', provider: 'elevenlabs' })).body.credentials).toHaveLength(1);
    expect((await api.call('disconnect', { scope: 'personal', provider: 'elevenlabs', expectedRevision: 1 })).body.credential.configured).toBe(false);
    expect(api.secretReads()).toBe(1);
  });
});
