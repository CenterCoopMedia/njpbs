import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/** SDK identity only, never readiness. In particular a projectId proxy or
 * serialized SDK-shaped object cannot enter the installed execution session.
 * Demo is accepted here solely for focused identity component tests; the
 * actual installed launcher independently requires the real development app.
 */
export function assertNativeRehearsalDatabase(firestore, projectId) {
  const refuse = () => { throw new Error('Native rehearsal database identity refused'); };
  if (typeof projectId !== 'string' || projectId !== 'njpbs-site-dev' && !/^demo-[a-z0-9-]+$/.test(projectId) ||
      firestore?.projectId !== projectId) refuse();
  const { getApps } = require('firebase-admin/app'), { getFirestore } = require('firebase-admin/firestore');
  const matches = getApps().filter(app => app.options.projectId === projectId && getFirestore(app) === firestore);
  if (matches.length !== 1) refuse();
}
