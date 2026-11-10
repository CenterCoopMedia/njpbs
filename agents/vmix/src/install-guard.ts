import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class ConnectorInstallError extends Error {}

/** Every normal launcher reaches this gate before configuration or credentials. */
export function assertConnectorInstallReady(directory: string) {
  if (existsSync(join(dirname(directory), 'vmix-agent-setup.lock')) || existsSync(join(directory, 'self-test.pending'))) {
    throw new ConnectorInstallError('Studio setup needs recovery or its self-test has not passed. Ask support before starting.');
  }
}
