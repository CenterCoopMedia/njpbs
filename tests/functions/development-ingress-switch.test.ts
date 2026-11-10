import { beforeEach, expect, it } from 'vitest';
import { isolatedFirestore, clearEmulatorFirestore } from '../helpers/emulator-firestore.js';
import { seedSwitch, fixtureGuard, fixtureReadOwner } from '../helpers/public-release-switch.js';
import { createPublicReleaseRouter } from '../../workers/src/public-release-router';
import { configurePublicReleaseIngress } from '../../scripts/configure-public-release-ingress.mjs';
import switches from '../../functions/lib/public-release-switch.js';
import serving from '../../functions/lib/public-release-serving.js';
import deployment from '../../functions/lib/public-deployment.js';
const db = isolatedFirestore('development-ingress-switch.test.ts');
beforeEach(async () => { await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: 'DELETE' }, db); });
it('uses the SDK guarded switch and return selectors; schema one and viewer-selected NEW never grant serving', async () => {
  const f = await seedSwitch(db);
  const config = configurePublicReleaseIngress({ oldPair: f.old, newPair: f.next, accountId: 'a'.repeat(32),
    ingressName: 'njpbs-private-ingress-development', developmentIngress: true });
  expect(config.vars.PUBLIC_PAIR_BOOTSTRAP_ID).toBe('');
  const router = createPublicReleaseRouter({ environment: 'development', bootstrapPairId: config.vars.PUBLIC_PAIR_BOOTSTRAP_ID,
    readSelector: () => serving.readPublicReleaseSelector({ firestore: db, environment: 'development' }),
    slots: [f.old, f.next].map(identity => ({ identity, serve: async () => ({ kind: 'response' as const, response: new Response(identity.pairId) }) })) });
  const read = () => router.fetch(new Request('https://dev-public.example.org/story/', { headers: { 'x-njpbs-pair': f.next.pairId } }));
  await db.doc('system/publicDeployment').set(deployment.initialPublicDeploymentPointer()); expect((await read()).status).toBe(503);
  await db.doc('system/publicDeployment').set(f.selector); router.invalidate(f.selector.epoch);
  expect(await (await read()).text()).toBe(f.old.pairId);
  const apply = async (attempt: any) => { await switches.reservePublicReleaseSwitch({ firestore: db, attempt });
    return switches.applyPublicReleaseSwitch({ firestore: db, attempt, qualificationReadOwner: fixtureReadOwner,
      assertQualificationsCurrentInTransaction: fixtureGuard, assertAcceptedWorkIncludedInTransaction: fixtureGuard }); };
  const selected = (await apply(f.attempt)).receipt.selector; router.invalidate(selected.epoch);
  expect(await (await read()).text()).toBe(f.next.pairId);
  const back = await seedSwitch(db, { selector: selected, old: f.next, next: f.old, operationId: 'return-to-old' });
  const returned = (await apply(back.attempt)).receipt.selector; router.invalidate(returned.epoch);
  expect(await (await read()).text()).toBe(f.old.pairId);
  const production = configurePublicReleaseIngress({ oldPair: { ...f.old, environment: 'production' }, newPair: { ...f.next, environment: 'production' },
    accountId: 'a'.repeat(32), ingressName: 'njpbs-private-ingress-production' });
  expect(production.vars.PUBLIC_PAIR_BOOTSTRAP_ID).toBe(f.old.pairId);
  expect(production.vars.PUBLIC_PAIR_INGRESS_ENABLED).toBe('false');
});
