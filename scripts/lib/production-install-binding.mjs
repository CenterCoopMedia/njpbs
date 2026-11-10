import targets from '../../functions/lib/publication-target.js';
import { developmentInstallCredential } from './development-install-credentials.mjs';
import { parseOperatorCredentialIdentity, operatorAccount, openOperatorDatabase, operatorRefused as refuse } from './public-release-operator-io.mjs';

// Neutral bounded pipe/token codecs; environment authority is checked above
// the consuming SDK/provider boundary, never inferred by these codecs.
export { developmentInstallCredential as productionInstallCredential,
  developmentInstallToken as productionInstallToken,
  developmentInstallAccess as productionInstallAccess } from './development-install-credentials.mjs';

/** Explicit production binding over the existing native operator identity.
 * A packet seals public identity only; credential bytes enter via a paused
 * inherited pipe at use. No ADC, path-based account or environment fallback. */
export function assertProductionInstallEnvironment(env = process.env) {
  const target = targets.publicationTarget('production');
  if (['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FUNCTIONS_EMULATOR',
    'FIREBASE_DATABASE_EMULATOR_HOST', 'STORAGE_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST',
    'GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_CONFIG']
    .some(key => Object.hasOwn(env, key))) refuse();
  for (const key of ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT'])
    // config-input: GCLOUD_PROJECT, GOOGLE_CLOUD_PROJECT
    if (env[key] !== undefined && env[key] !== target.projectId) refuse();
  if (env.CMS_DEPLOYMENT_ENVIRONMENT !== undefined && env.CMS_DEPLOYMENT_ENVIRONMENT !== target.environment) refuse();
  return target;
}

export function parseProductionInstallIdentity(identity) {
  return parseOperatorCredentialIdentity(identity, 'production');
}

export async function openProductionInstallSdk(identity, fd = 3) {
  parseProductionInstallIdentity(identity);
  assertProductionInstallEnvironment();
  const pipe = developmentInstallCredential(fd, raw => operatorAccount(raw, identity));
  try { return await openOperatorDatabase(await pipe.read()); }
  finally { pipe.close(); }
}
