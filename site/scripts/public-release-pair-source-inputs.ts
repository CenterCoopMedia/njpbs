import { mkdir, lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import baseline, { type PublicReleaseChangeBaseline } from "../../functions/lib/public-release-change-baseline.js";
import protocol from "../../functions/lib/public-release-pair.js";
export const PAIR_SOURCE_INPUTS_FILE = "pair-source-inputs.json";
export const PAIR_SOURCE_INPUTS_PACK_PATH = "/_pair-compiled/pair-source-inputs.json";
export class PairSourceInputsError extends Error {
  constructor(readonly code: "pair-source-inputs-missing" | "pair-source-inputs-mismatch") { super(code); this.name = "PairSourceInputsError"; }
}
export function publicReleasePairSourceInputsBytes(receipt: PublicReleaseChangeBaseline, logBaselineDigest: string) {
  const actual = baseline.parsePublicReleaseChangeBaseline(receipt);
  if (protocol.publicReleaseDigest(actual) !== logBaselineDigest) throw new PairSourceInputsError("pair-source-inputs-mismatch");
  return new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, logBaselineDigest,
    sourceMemberCensusDigest: actual.sourceMemberCensusDigest, baselineCursor: actual.baselineCursor }) + "\n");
}
/** Read the verified global receipt, then write only a local build input. No
 * production control, publication, enrollment or selector is changed. */
export async function writePublicReleasePairSourceInputs(options: { firestore: Firestore; logEpoch: string; directory: string }) {
  const receipt = baseline.parsePublicReleaseChangeBaseline((await options.firestore.doc(`system/publicReleaseChanges/baselines/${options.logEpoch}`).get()).data());
  if (receipt.logEpoch !== options.logEpoch) throw new PairSourceInputsError("pair-source-inputs-mismatch");
  const logBaselineDigest = protocol.publicReleaseDigest(receipt);
  await options.firestore.runTransaction(transaction => baseline.assertReadPublicReleaseChangeBaselineInTransaction({
    firestore: options.firestore, transaction, logBaselineDigest }), { readOnly: true });
  const bytes = publicReleasePairSourceInputsBytes(receipt, logBaselineDigest), directory = path.resolve(options.directory);
  await mkdir(directory, { recursive: true });
  const state = await lstat(directory); if (!state.isDirectory() || state.isSymbolicLink()) throw new PairSourceInputsError("pair-source-inputs-mismatch");
  const file = path.join(directory, PAIR_SOURCE_INPUTS_FILE);
  try { await writeFile(file, bytes, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!(await lstat(file)).isFile() || (await lstat(file)).isSymbolicLink() || !Buffer.from(await readFile(file)).equals(Buffer.from(bytes)))
      throw new PairSourceInputsError("pair-source-inputs-mismatch");
  }
  return { file, logBaselineDigest, receipt, bytes };
}
async function main() {
  const args = process.argv.slice(2), values = new Map<string, string>();
  if (args.length !== 6) throw new Error("Expected --project --log-epoch --directory");
  for (let index = 0; index < args.length; index += 2) {
    if (!["--project", "--log-epoch", "--directory"].includes(args[index]) || values.has(args[index]) || !args[index + 1]) throw new Error("Invalid source input option");
    values.set(args[index], args[index + 1]);
  }
  const projectId = values.get("--project")!;
  const emulator = /^demo-[a-z0-9-]+$/.test(projectId) && /^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "");
  if (!emulator && !["njpbs-site", "njpbs-site-dev"].includes(projectId)) throw new Error("Invalid source input project");
  const { initializeApp, applicationDefault, deleteApp } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  const app = initializeApp({ projectId, ...(emulator ? {} : { credential: applicationDefault() }) }, `pair-source-inputs-${randomUUID()}`);
  try {
    const result = await writePublicReleasePairSourceInputs({ firestore: getFirestore(app), logEpoch: values.get("--log-epoch")!, directory: values.get("--directory")! });
    process.stdout.write(JSON.stringify({ event: "pair-source-inputs-written", file: result.file, logBaselineDigest: result.logBaselineDigest }) + "\n");
  } finally { await deleteApp(app); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) void main().catch(error => {
  process.stderr.write(`${error instanceof PairSourceInputsError ? error.code : "pair-source-inputs-failed"}\n`); process.exitCode = 1;
});
