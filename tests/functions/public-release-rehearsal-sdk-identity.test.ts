import { expect, it } from 'vitest';
import { isolatedFirestore } from '../helpers/emulator-firestore.js';
import { assertNativeRehearsalDatabase } from '../../scripts/lib/rehearsal-sdk-identity.mjs';

const firestore = isolatedFirestore('rehearsal-sdk-identity');
it('accepts the actual SDK object for its own genuine demo project without granting readiness', () => {
  expect(assertNativeRehearsalDatabase(firestore, firestore.projectId)).toBeUndefined();
});
it('refuses a projectId proxy and an SDK-shaped serialized object', () => {
  const copied = { projectId: firestore.projectId };
  const wrapped = new Proxy(firestore, { get: (object, key) => Reflect.get(object, key) });
  expect(() => assertNativeRehearsalDatabase(copied, firestore.projectId)).toThrow();
  expect(() => assertNativeRehearsalDatabase(wrapped, firestore.projectId)).toThrow();
});
it('refuses a different project and never opens a production SDK', () => {
  expect(() => assertNativeRehearsalDatabase(firestore, 'njpbs-site-dev')).toThrow();
  expect(() => assertNativeRehearsalDatabase({ projectId: 'njpbs-site' }, 'njpbs-site')).toThrow();
});
