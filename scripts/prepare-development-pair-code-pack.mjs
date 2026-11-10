#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { runFirstInstallPreparation } from './prepare-first-install-pair-code-pack.mjs';
export { parseFirstInstallPreparationPacket, readFirstInstallPreparationPacket } from './prepare-first-install-pair-code-pack.mjs';
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await runFirstInstallPreparation(process.argv.slice(2), 'development');
