/** Run only in the reviewed private development workload. Default: dry run.
 * No provider target or routing flag is provisioned/enabled by this operator. */
import { pathToFileURL } from "node:url";
import { applicationDefault, deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import measurement from "../../functions/lib/public-release-routing-measurement.js";
import targets from "../../functions/lib/publication-target.js";
const refuse = (): never => { throw new Error("Private routing measurement creation was refused"); };
export async function runMeasurementOperator(args:string[]) {
  const apply = args.length === 5 && args[4] === "--apply";
  if (args[0] !== "--measurement-id" || args[2] !== "--source-digest" || !(args.length === 4 || apply) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(args[1] ?? "") || !/^[a-f0-9]{64}$/.test(args[3] ?? "") ||
      apply && (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST)) refuse();
  const app = initializeApp({ projectId: targets.publicationTarget("development").projectId, credential: applicationDefault() });
  try {
    const result = await measurement.createPrivateRoutingMeasurementSelector({ firestore:getFirestore(app),measurementId:args[1],
      expectedSourceDigest:args[3],dryRun:!apply });
    process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
  } finally { await deleteApp(app); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMeasurementOperator(process.argv.slice(2)).catch(() => { process.stderr.write("Private routing measurement creation was refused\n"); process.exitCode=1; });
}
