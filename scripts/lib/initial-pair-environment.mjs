import { assertDevelopmentRehearsalEnvironment } from './development-rehearsal-credentials.mjs';
import { assertProductionInstallEnvironment } from './production-install-binding.mjs';
import { operatorRefused as refuse } from './public-release-operator-io.mjs';
export function assertInitialPairEnvironment(environment) {
  if (environment === 'production') return assertProductionInstallEnvironment();
  if (environment !== 'development') refuse();
  assertDevelopmentRehearsalEnvironment();
  if (![undefined, 'development'].includes(process.env.CMS_DEPLOYMENT_ENVIRONMENT)) refuse();
}
