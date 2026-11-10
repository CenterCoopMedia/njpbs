import { describe, it, expect } from 'vitest';
import corpus from '../../functions/video-search-corpus.js';
import transcripts from '../../functions/video-transcripts.js';
import byok from '../../functions/video-transcript-byok.js';

// #4950: a headless agent browser cannot mint an App Check token. The transcript and video
// search reads admit a server-marked automation account without one; nothing else changes.
const source = { id: 'video-library', bucket: 'originals', prefix: '', writable: true, access: 'active_staff' };
const reached = () => Object.assign(new Error('reached source authorization'), { status: 404 });

function setup({ marked = false } = {}) {
  const markerReads = [];
  const firestore = { collection(name) {
    if (name !== 'cmsAutomationAccounts') throw new Error(`unexpected read of ${name}`);
    return { doc: id => ({ get: async () => { markerReads.push(id); return { exists: marked && id === 'agent' }; } }) };
  } };
  const authorized = [];
  const deps = { firestore, registryFn: () => new Map([[source.id, source]]), configFn: () => ({ bucket: 'renditions' }),
    requirePrincipalFn: async () => ({ uid: 'agent', principal: { grants: [{ role: 'staff' }] } }),
    // The production verifier's refusals (lib/auth.js), without a network call.
    verifyAppCheckFn: async token => {
      const message = typeof token !== 'string' || !token.trim() ? 'Missing App Check token' : 'Invalid App Check token';
      throw Object.assign(new Error(message), { status: 401, code: 'app_check_failed' });
    },
    authorizeFn: async ({ operation }) => { authorized.push(operation); throw reached(); } };
  return { deps, markerReads, authorized };
}

async function call(handler, body, headers = {}) {
  const res = { statusCode: 0, set() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  await handler({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }, res);
  return res;
}

const reads = {
  cmsGetVideoSearchCorpus: deps => [corpus.createVideoSearchCorpusHandler(deps), { sourceId: source.id }],
  cmsGetVideoTranscript: deps => [transcripts.createTranscriptHandler('get', deps), { sourceId: source.id, assetId: 'asset' }],
  cmsListVideoTranscripts: deps => [byok.createByokHandler('list', deps), { sourceId: source.id, assetId: 'asset' }],
};
const writes = {
  cmsRequestVideoTranscript: deps => transcripts.createTranscriptHandler('request', deps),
  cmsSaveVideoTranscript: deps => transcripts.createTranscriptHandler('edit', deps),
  cmsCreateVideoTranscriptRead: deps => transcripts.createTranscriptHandler('download', deps),
  cmsRequestByokVideoTranscript: deps => byok.createByokHandler('request', deps),
};

describe('automation account transcript and video search reads', () => {
  for (const [name, make] of Object.entries(reads)) {
    it(`${name} admits a marked account without App Check and still authorizes the source`, async () => {
      const test = setup({ marked: true });
      const [handler, body] = make(test.deps);
      expect((await call(handler, body)).statusCode).toBe(404);
      expect(test.markerReads).toEqual(['agent']);
      expect(test.authorized).toEqual(['browse']);
    });
    it(`${name} refuses an unmarked account without App Check`, async () => {
      const test = setup();
      const [handler, body] = make(test.deps);
      expect((await call(handler, body)).statusCode).toBe(401);
      expect(test.authorized).toEqual([]);
    });
    it(`${name} still verifies a token that a marked account sends`, async () => {
      const test = setup({ marked: true });
      const [handler, body] = make(test.deps);
      expect((await call(handler, body, { 'x-firebase-appcheck': 'forged' })).statusCode).toBe(401);
      expect(test.markerReads).toEqual([]);
      expect(test.authorized).toEqual([]);
    });
  }
  for (const [name, make] of Object.entries(writes)) {
    it(`${name} still requires App Check from a marked account`, async () => {
      const test = setup({ marked: true });
      expect((await call(make(test.deps), { sourceId: source.id, assetId: 'asset' })).statusCode).toBe(401);
      expect(test.markerReads).toEqual([]);
      expect(test.authorized).toEqual([]);
    });
  }
});
