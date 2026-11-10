#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { main as run } from './prepare-initial-pairs.mjs';
export const main = args => run(args, 'production');
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then(result => {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}).catch(() => { process.stderr.write('Production initial pairs refused; preserve the packet and use --readback\n'); process.exitCode = 1; });
