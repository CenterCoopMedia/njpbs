#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readerCredentialPipeIdentity } from "./lib/cms-reader-install-credential.mjs";

// Parent-shell metadata only. This command never opens, reads or logs bytes.
export function describeReaderCredentialPipes(fds) {
  if (!fds.length || fds.length > 4 || new Set(fds).size !== fds.length ||
      fds.some(fd => !["4", "12", "13", "14"].includes(fd))) throw new Error("Credential pipe list refused");
  return Object.fromEntries(fds.map(fd => [fd, readerCredentialPipeIdentity(Number(fd))]));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(describeReaderCredentialPipes(process.argv.slice(2)))}\n`); }
  catch { process.stderr.write("CMS reader credential pipe description refused.\n"); process.exitCode = 1; }
}
