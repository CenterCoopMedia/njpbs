import { beforeEach, expect, it, vi } from 'vitest';
import { isolatedFirestore, clearEmulatorFirestore } from '../helpers/emulator-firestore.js';
import { seedSwitch } from '../helpers/public-release-switch.js';
import { credentialIdentity } from '../helpers/development-install';
import { saveDevelopmentScheduledPost } from '../../scripts/lib/development-scheduled-save.mjs';
import save from '../../functions/save.js';
import p from '../../functions/lib/public-release-pair.js';
import a from '../../functions/lib/public-release-admission.js';
const rawDb = isolatedFirestore('development-native-scheduled-save.test.ts');
const db = new Proxy(rawDb, { get(target, key) { if (key === 'projectId') return 'njpbs-site-dev';
  const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
const actor = { uid: 'schedule-publisher', email: 'publisher@example.test', principal: { id: 'schedule-publisher', grants: [{ role: 'admin' }] } };
const savedAt = '2026-11-03T23:00:00.000Z', scheduleAt = '2026-11-03T23:30:00.000Z';
const contract = { schemaVersion: 2, families: ['posts'], features: [] };
let packet: any, request: any;
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: 'DELETE' }, rawDb);
  const setup = await seedSwitch(db, { admittedContract: contract });
  await db.doc(`${a.CONTRACTS}/${p.publicReleaseDigest(contract)}`).set(contract);
  await db.doc(`${a.ADMISSIONS}/controls/adoption`).set({ schemaVersion: 2, enabled: true });
  await db.doc('sections/news').set({ label: 'News' });
  const document = { id: 'scheduled-post', type: 'post', title: 'Scheduled development Post', summary: 'Publication proof.', status: 'draft',
    createdBy: actor.uid, section: 'news', slug: 'scheduled-post', previousSlugs: [], locale: 'en', tags: [], categories: [],
    date: '2026-11-03', credits: [{ kind: 'custom', name: 'Reporting desk' }], blocks: [], version: 1, updatedAt: savedAt };
  await db.doc('cmsPosts/scheduled-post').set(document);
  packet = { schemaVersion: 1, kind: 'development-native-scheduled-save', operatorCommitSha: 'a'.repeat(40), credentialIdentity,
    oldPair: setup.old, documentId: document.id, baseVersion: 1, beforeDigest: p.publicReleaseDigest(document), scheduleAt };
  const handler = save.createCmsSaveHandler({ firestore: db, requirePrincipalFn: async () => actor, enablePublishSnapshot: true,
    now: () => savedAt, assertPublishReadyFn: async () => { throw new Error('Legacy path refused'); }, log: { info() {}, warn() {}, error() {} } });
  request = vi.fn(async (url: string, init: any) => {
    expect(url).toBe('https://us-central1-njpbs-site-dev.cloudfunctions.net/cmsSaveContent'); expect(init.redirect).toBe('error');
    expect(init.headers.authorization).toBe('Bearer synthetic-staff'); expect(init.headers['x-njpbs-cms-edge']).toBe('synthetic-edge');
    const response = { code: 200, headersSent: false, body: undefined as any, status(code: number) { this.code = code; return this; },
      set() { return this; }, json(body: any) { this.body = body; this.headersSent = true; return this; } };
    await handler({ method: 'POST', headers: {}, ip: '127.0.0.1', body: JSON.parse(init.body) }, response);
    return Response.json(response.body, { status: response.code });
  });
});
const run = (readback = false) => saveDevelopmentScheduledPost({ firestore: db, packet, request, readback,
  readStaffToken: async () => 'synthetic-staff', readEdgeSecret: async () => 'synthetic-edge' });
it('uses the actual native save owner, reads the saved version/time and creates no scheduler marker or acceptance', async () => {
  const receipt = await run(); expect(receipt).toMatchObject({ version: 2, publishAt: scheduleAt, documentId: 'scheduled-post' });
  expect(await run(true)).toEqual(receipt); expect(request).toHaveBeenCalledTimes(1);
  expect((await db.collection(`${a.ADMISSIONS}/operations`).get()).empty).toBe(true);
  expect((await db.collection('cmsPublishQueue').get()).empty).toBe(true);
  await expect(run()).rejects.toThrow(); expect(request).toHaveBeenCalledTimes(1);
});
it('reconciles an ambiguous successful save through reads and refuses an unrelated current schedule', async () => {
  const native = request.getMockImplementation(); request.mockImplementation(async (...args: any[]) => { await native(...args); throw new Error('Reply lost'); });
  await expect(run()).rejects.toThrow(); expect(await run(true)).toMatchObject({ version: 2, publishAt: scheduleAt });
  await db.doc('cmsPosts/scheduled-post').update({ publishAt: '2026-11-03T23:31:00.000Z' });
  await expect(run(true)).rejects.toThrow(); expect(request).toHaveBeenCalledTimes(1);
});
it('refuses source/OLD drift and production packets before sending staff credentials', async () => {
  const readStaffToken = vi.fn(async () => 'synthetic-staff');
  packet.beforeDigest = '0'.repeat(64);
  await expect(saveDevelopmentScheduledPost({ firestore: db, packet, request, readStaffToken })).rejects.toThrow();
  expect(readStaffToken).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  packet = structuredClone(packet); packet.oldPair.environment = 'production'; await expect(run()).rejects.toThrow(); expect(request).not.toHaveBeenCalled();
});
