import { describe, expect, it } from 'vitest';
import { ACTOR } from '../../scripts/seed-dev-published.mjs';
import { contentTargets, publicationStep, publishContent, publishSettings, readJournal, refuseUnsafeEnvironment, settingsTargets } from '../../scripts/publish-dev-seed.mjs';

// A fake Boardwalk with the replies the dev Functions give.
function boardwalk({ documents = {}, settings = {} }) {
  const calls = [];
  const call = async (endpoint, body) => {
    calls.push([endpoint, body]);
    const key = `${body.collection}/${body.id}`;
    if (endpoint === 'cmsGetContent') return documents[key] ? { status: 200, body: { document: structuredClone(documents[key]) } } : { status: 404, body: null };
    if (endpoint === 'cmsTransitionContent') {
      const document = documents[key];
      if (document.version !== body.baseVersion) return { status: 409, body: { error: 'stale' } };
      Object.assign(document, { status: 'draft', version: document.version + 1 });
      return { status: 200, body: { version: document.version } };
    }
    if (endpoint === 'cmsSaveContent') {
      const document = documents[key];
      if (document.status === 'published' || document.version !== body.baseVersion) return { status: 409, body: { error: 'refused' } };
      Object.assign(document, { status: 'published', version: document.version + 1, published: { publishedBy: 'staff-uid' } });
      const kind = body.collection === 'cmsPages' ? 'page' : document.type;
      return { status: 200, body: { publication: { transport: { page: 'page-no-build-v1', post: 'post-no-build-v1' }[kind] ?? 'public-context-no-build-v1' } } };
    }
    const row = settings[body.id];
    if (endpoint === 'cmsGetSettings') return { status: 200, body: row ? { found: true, settings: structuredClone(row.settings), publication: row.publication } : { found: false } };
    if (endpoint === 'cmsSaveSettings') {
      if (body.createOnly ? row : row?.settings.version !== body.baseVersion) return { status: 409, body: { error: 'stale' } };
      settings[body.id] = { settings: { ...(row?.settings ?? {}), values: body.values, version: (row?.settings.version ?? 0) + 1 }, publication: row?.publication };
      return { status: 200, body: { success: true } };
    }
    if (endpoint === 'cmsPublishSettings') {
      if (row.settings.version !== body.baseVersion || body.publicationTransport !== 'public-context-no-build-v1') return { status: 409, body: {} };
      row.settings.published = { values: row.settings.values, sourceVersion: row.settings.version };
      row.publication = { status: 'success', missingConsumers: [] };
      return { status: 200, body: { success: true } };
    }
    throw new Error(`unexpected ${endpoint}`);
  };
  return { call, calls };
}
const seeded = (extra = {}) => ({ status: 'published', version: 4, type: 'post', published: { publishedBy: ACTOR, sourceVersion: 4 }, ...extra });

describe('publish-dev-seed', () => {
  it('refuses debug and Node option variables before sign-in', () => {
    for (const name of ['DEBUG', 'PWDEBUG', 'NODE_OPTIONS']) expect(() => refuseUnsafeEnvironment({ [name]: '1' })).toThrow(name);
    expect(() => refuseUnsafeEnvironment({ DEBUG: '' })).not.toThrow();
  });

  it('targets every routed Page, Post, Program and Event, and puts chrome last', () => {
    const manifest = { records: [
      { collection: 'cmsPages', id: 'contact', projection: { metadata: {} } },
      { collection: 'cmsPosts', id: 'p', projection: { metadata: { type: 'post' } } },
      { collection: 'cmsPosts', id: 'e', projection: { metadata: { type: 'event' } } },
      { collection: 'cards', id: 'c', projection: { type: 'sponsor' } },
      { collection: 'cmsSettings', id: 'public-site-chrome', projection: { values: { a: 1 } } },
      { collection: 'cmsSettings', id: 'story-ctas', projection: { values: { rules: [] } } },
    ] };
    expect(contentTargets(manifest).map(item => `${item.collection}/${item.id}:${item.kind}`)).toEqual(['cmsPages/contact:page', 'cmsPosts/p:post', 'cmsPosts/e:event']);
    expect(settingsTargets(manifest).map(item => item.id)).toEqual(['story-ctas', 'public-site-chrome']);
  });

  it('publishes seed-written rows through edit and save, and skips rows a staff publish owns', async () => {
    const documents = { 'cmsPosts/a': seeded(), 'cmsPages/home': seeded({ type: 'page' }), 'cmsPosts/b': seeded({ published: { publishedBy: 'staff-uid' } }) };
    const { call, calls } = boardwalk({ documents });
    const journal = readJournal(''); const lines = [];
    const result = await publishContent({ call, journal, record: entry => lines.push(JSON.stringify(entry)),
      targets: [{ collection: 'cmsPosts', id: 'a', kind: 'post' }, { collection: 'cmsPages', id: 'home', kind: 'page' }, { collection: 'cmsPosts', id: 'b', kind: 'post' }] });
    expect(result).toEqual({ published: 2, current: 1, failed: [] });
    expect(calls.filter(([endpoint]) => endpoint === 'cmsSaveContent').map(([, body]) => body)).toEqual([
      { collection: 'cmsPosts', id: 'a', baseVersion: 5, publish: true, document: {} },
      { collection: 'cmsPages', id: 'home', baseVersion: 5, publish: true, document: {} }]);
    expect(readJournal(lines.join('\n'))).toEqual({ drafts: new Map(), pending: new Set() });
  });

  it('resumes only drafts its journal names at the version it recorded', async () => {
    const journal = readJournal([
      JSON.stringify({ step: 'edit-intent', collection: 'cmsPosts', id: 'mine' }), JSON.stringify({ step: 'edit-done', collection: 'cmsPosts', id: 'mine', version: 5 }),
      JSON.stringify({ step: 'edit-intent', collection: 'cmsPosts', id: 'lost' })].join('\n'));
    expect(publicationStep({ status: 'draft', version: 5 }, 'cmsPosts/mine', journal)).toBe('publish');
    expect(publicationStep({ status: 'draft', version: 6 }, 'cmsPosts/mine', journal)).toBe('not-seeded');
    expect(publicationStep({ status: 'draft', version: 5 }, 'cmsPosts/lost', journal)).toBe('unconfirmed');
    expect(publicationStep({ status: 'draft', version: 5, publiclyVisible: true }, 'cmsPosts/staff', journal)).toBe('not-seeded');
    const documents = { 'cmsPosts/mine': { status: 'draft', version: 5, type: 'post' }, 'cmsPosts/staff': { status: 'draft', version: 2, type: 'post', publiclyVisible: true } };
    const { call, calls } = boardwalk({ documents });
    const result = await publishContent({ call, journal, targets: [{ collection: 'cmsPosts', id: 'mine', kind: 'post' }, { collection: 'cmsPosts', id: 'staff', kind: 'post' }] });
    expect(result).toEqual({ published: 1, current: 0, failed: [{ collection: 'cmsPosts', id: 'staff', step: 'not-seeded', status: 'draft' }] });
    expect(calls.some(([endpoint, body]) => endpoint !== 'cmsGetContent' && body.id === 'staff')).toBe(false);
  });

  it('creates, saves and publishes each setting through the settings calls, and waits for the last receipt', async () => {
    const settings = {
      'site-navigation': { settings: { values: { old: true }, version: 3, published: { values: { old: true } } }, publication: { status: 'success', missingConsumers: [] } },
      'public-site-chrome': { settings: { values: { same: 1 }, version: 2, published: { values: { same: 1 } } }, publication: { status: 'success', missingConsumers: [] } },
    };
    const { call, calls } = boardwalk({ settings });
    const receipt = await publishSettings({ call, wait: async () => {}, targets: [
      { id: 'story-ctas', values: { rules: [] } }, { id: 'site-navigation', values: { items: [] } }, { id: 'public-site-chrome', values: { same: 1 } }] });
    expect(receipt).toEqual({ status: 'success', missingConsumers: [] });
    expect(calls.filter(([endpoint]) => ['cmsSaveSettings', 'cmsPublishSettings'].includes(endpoint))).toEqual([
      ['cmsSaveSettings', { id: 'story-ctas', createOnly: true, values: { rules: [] } }],
      ['cmsPublishSettings', { id: 'story-ctas', baseVersion: 1, publicationTransport: 'public-context-no-build-v1' }],
      ['cmsSaveSettings', { id: 'site-navigation', baseVersion: 3, values: { items: [] } }],
      ['cmsPublishSettings', { id: 'site-navigation', baseVersion: 4, publicationTransport: 'public-context-no-build-v1' }]]);
  });
});
