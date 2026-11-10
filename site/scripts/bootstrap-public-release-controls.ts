/** Named first-install operator. BUILD source only; default is read-only. */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { applicationDefault, deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import targets from "../../functions/lib/publication-target.js";
import protocol from "../../functions/lib/public-release-pair.js";
import { prepareInstalledPublicReleaseConsumers } from "./public-release-installed-consumer-owner";
import { inspectBootstrapControls, installBootstrapOldControls, parseBootstrapControlsAttempt } from "./public-release-bootstrap-controls";

function refuse(): never { throw new Error("Initial public release controls were refused"); }
export function parseBootstrapControlsOperatorArgs(args: string[]): { pairFile: string; dryRun: true } | { attemptFile: string; dryRun: boolean } {
  if (args.length === 3 && args[0] === "--inspect" && args[1] === "--pair" && args[2])
    return { pairFile: args[2], dryRun: true as const };
  const apply = args.length === 3 && args[2] === "--apply";
  if (args[0] !== "--attempt" || !args[1] || !(args.length === 2 || apply)) refuse();
  return { attemptFile: args[1], dryRun: !apply };
}
export async function runBootstrapControlsOperator(args: string[]) {
  const options = parseBootstrapControlsOperatorArgs(args);
  const bytes = await readFile("pairFile" in options ? options.pairFile : options.attemptFile);
  if (bytes.length > 64 * 1024) refuse();
  const raw = JSON.parse(bytes.toString("utf8"));
  if ("pairFile" in options) {
    const pair = protocol.parsePublicReleasePair(raw), target = targets.publicationTarget(pair.environment);
    const app = initializeApp({ projectId: target.projectId, credential: applicationDefault() });
    try { process.stdout.write(`${JSON.stringify(await inspectBootstrapControls({ firestore: getFirestore(app), pair }), null, 2)}\n`); }
    finally { await deleteApp(app); }
    return;
  }
  const attempt = parseBootstrapControlsAttempt(raw);
  const target = targets.publicationTarget(attempt.pair.environment);
  const app = initializeApp({ projectId: target.projectId, credential: applicationDefault() });
  try {
    const firestore = getFirestore(app);
    const installed = await prepareInstalledPublicReleaseConsumers({ firestore, environment: attempt.pair.environment,
      sourceSha: attempt.consumerSourceSha, contractDigest: attempt.admittedContractDigest });
    const result = await installBootstrapOldControls({ firestore, attempt, installed, dryRun: options.dryRun });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally { await deleteApp(app); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBootstrapControlsOperator(process.argv.slice(2)).catch(() => {
    process.stderr.write("Initial public release controls were refused\n"); process.exitCode = 1;
  });
}
