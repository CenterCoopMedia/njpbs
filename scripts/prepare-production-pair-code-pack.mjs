#!/usr/bin/env node
import { runFirstInstallPreparation } from './prepare-first-install-pair-code-pack.mjs';
await runFirstInstallPreparation(process.argv.slice(2), 'production');
