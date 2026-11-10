import { createRequire } from 'node:module';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
const require = createRequire(new URL('../../site/package.json', import.meta.url));
if (!/^demo-[a-z0-9-]+$/.test(process.env.INITIAL_PAIR_TEST_PROJECT ?? '') || !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')) throw new Error('Local fixture only');
require('tsx/cjs/api').register();
const native = createRequire(import.meta.url);
const environment = process.env.INITIAL_PAIR_TEST_ENVIRONMENT ?? 'development';
if (!['development', 'production'].includes(environment)) throw new Error('Unknown fixture environment');
const app = initializeApp({ projectId: process.env.INITIAL_PAIR_TEST_PROJECT }, 'initial-pair-command-child');
const raw = getFirestore(app), firestore = new Proxy(raw, { get(target, key) { if (key === 'projectId') return environment === 'development' ? 'njpbs-site-dev' : 'njpbs-site';
  const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
const { developmentInitialPairInstallFixture } = native('./development-initial-pair-install.ts', import.meta.url);
const { openPublicReleasePairInput } = native('../../site/scripts/public-release-pair-input-storage.ts', import.meta.url);
const census = native('../../site/scripts/public-release-pair-source-census.ts', import.meta.url);
const work = createRequire(import.meta.url)('../../functions/lib/public-release-pair-work.js');
let fixture, closing = false;
const close = async () => { if (closing) return; closing = true; await fixture?.close(); await deleteApp(app); process.disconnect?.(); };
process.on('disconnect', () => { void close(); });
try {
  fixture = await developmentInitialPairInstallFixture(firestore, { environment });
  process.send({ ready: true, packet: fixture.packet, pairs: fixture.pairs });
  process.on('message', async ({ id, action, step, mode, qualifications }) => {
    try {
      let result;
      if (action === 'run') result = await fixture.run(step, mode);
      else if (action === 'refresh') result = await fixture.run('qualify', 'apply', fixture.packet.qualificationIds.map(id => id + '-after-fault'));
      else if (action === 'complete') { await fixture.complete(); result = true; }
      else if (action === 'controls') result = await fixture.controls();
      else if (action === 'convert') result = await fixture.convert(qualifications);
      else if (action === 'census') {
        result = [];
        for (const pair of fixture.pairs) {
          const rows = await firestore.collection(`${work.publicReleasePairPath(pair.pairId)}/work`).get();
          const fresh = rows.docs.find(row => row.data().identity.sourceOperationId.startsWith('baseline-controls-')).data();
          const receipt = (await firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/inputs/${fresh.identity.inputManifestDigest}`).get()).data();
          const opened = await openPublicReleasePairInput({ firestore, store: fixture.store, pair, identity: fresh.identity, expectedSource: receipt.source, expectedCursor: receipt.cursor });
          const expected = JSON.parse(new TextDecoder().decode(await opened.readFile(census.PAIR_SOURCE_METADATA_FILE)));
          const actual = await census.preparePublicReleasePairSourceCensus({ firestore, expected, cursor: receipt.cursor });
          result.push({ actual: actual.metadata.digest, expected: expected.digest, controlFile: opened.root.files.some(file => file.name === 'initial-controls.json') });
        }
      } else if (action === 'close') { await close(); return; }
      else throw new Error('Unknown fixture action');
      process.send({ id, result });
    } catch (error) { process.send({ id, error: { message: error.message, stack: error.stack } }); }
  });
} catch (error) { process.send({ ready: false, error: { message: error.message, stack: error.stack } }); await close(); }
