#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { runRehearsal, recoverInstalledRehearsal, rehearsalSteps, RehearsalRefusal } from './lib/public-release-rehearsal.mjs';
import { missingBindings } from './lib/public-release-rehearsal-adapter.mjs';
import { createDevelopmentCredentialSource, closeDevelopmentCredentialSource } from './lib/development-rehearsal-credentials.mjs';
import { InstalledRehearsalStop } from './lib/rehearsal-installed-stop.mjs';

let credential, installed;
try {
  const [mode, packet, output, ...extra] = process.argv.slice(2);
  if (mode === 'plan' && !packet) {
    process.stdout.write(JSON.stringify({ schemaVersion: 1, productionAdoption: false, missingBindings,
      development: { projectId: 'njpbs-site-dev', packetSchemaVersion: 2, bindingsReady: missingBindings.length === 0 },
      steps: rehearsalSteps().map(([id, action, selected]) => ({ id, action, selected })) }, null, 2) + '\n');
  } else if (['installed-development', 'recover-installed-development'].includes(mode) && packet && /^[a-f0-9]{64}$/.test(output ?? '') && extra.length === 1) {
    const bytes = await readFile(packet);
    if (bytes.length > 750_000 || createHash('sha256').update(bytes).digest('hex') !== output) throw new Error('Bound launcher plan required');
    const { openInstalledRehearsalLauncher } = await import('./lib/rehearsal-installed-launcher.mjs');
    const recoveryOnly = mode === 'recover-installed-development';
    installed = await openInstalledRehearsalLauncher({ plan: JSON.parse(bytes.toString('utf8')), recoveryOnly, authorized: true });
    if (recoveryOnly) {
      const result = await recoverInstalledRehearsal(installed.packet, extra[0], installed);
      process.stdout.write(`Recovered original accepted effects: ${result.runId}; observation window remains failed\n`);
    } else {
      const report = await runRehearsal(installed.packet, extra[0], installed);
      const { installedRehearsalSession } = await import('./lib/rehearsal-installed-session.mjs');
      const preflights = await installedRehearsalSession(installed.installedSession, installed.packet).verifyCompletion(extra[0]);
      await writeFile(join(extra[0], 'bootstrap-preflights.json'), JSON.stringify(preflights, null, 2) + '\n', { mode: 0o600 });
      if (!preflights.passed) throw new RehearsalRefusal('installed-preflights-refused');
      process.stdout.write(`${report.verdict}: ${report.runId}; seven native preflights passed\n`);
    }
  } else if (['run', 'run-development'].includes(mode) && packet && output && !extra.length) {
    const input = JSON.parse(await readFile(packet, 'utf8'));
    if (input.schemaVersion !== (mode === 'run' ? 1 : 2)) throw new Error('Explicit rehearsal mode required');
    if (mode === 'run-development') {
      // The absent-bindings path must not even open the inherited descriptor.
      if (missingBindings.length) throw new RehearsalRefusal('development-bindings-unavailable');
      credential = createDevelopmentCredentialSource();
    }
    const report = await runRehearsal(input, output, { developmentCredential: credential });
    process.stdout.write(`${report.verdict}: ${report.runId}\n`);
  } else throw new Error('Invalid invocation');
} catch (error) {
  if (error instanceof InstalledRehearsalStop) {
    process.stderr.write(`STOP #${error.issue}: ${error.code}; blocked step ${error.blockedStep}\n`);
    process.exitCode = 1;
  } else {
    const reason = error instanceof RehearsalRefusal ? `${error.code}; step ${error.step}; action ${error.actionId}`
      : error.code === 'EEXIST' ? 'Evidence lock or create-only receipt exists; inspect the owned process before recovery'
        : 'Input or evidence is invalid. Use: node scripts/rehearse-public-release-pairs.mjs plan | run <demo-packet.json> <evidence-directory> | run-development <development-packet.json> <evidence-directory> | installed-development <plan.json> <sha256> <evidence-directory> | recover-installed-development <same-plan.json> <same-sha256> <same-evidence-directory>';
    process.stderr.write(`Rehearsal refused: ${reason}. No production calls are supported.\n`);
    process.exitCode = 1;
  }
} finally {
  await installed?.close();
  if (credential) closeDevelopmentCredentialSource(credential);
}
