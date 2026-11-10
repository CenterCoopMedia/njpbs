import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publicationTarget } from "../../functions/lib/publication-target";
import { ContentBaselineError } from "../../packages/content-core/src/public-content-baseline";
import { PublicWorkerArtifactError } from "../src/lib/public-publication-receipt";

const usage = "Usage: seed-public-content-baseline.sh --target production|development --dist <directory> --prepared <file> [--apply]";
class BaselineOperatorError extends ContentBaselineError {}
export function baselineOperatorErrorMessage(error: unknown): string {
  return error instanceof ContentBaselineError || error instanceof PublicWorkerArtifactError ? error.message :
    "Baseline preparation refused; verify the sealed artifact and storage readback";
}
export function parseBaselineArguments(args: string[]) {
  if (![6, 7].includes(args.length) || args[0] !== "--target" || !["production", "development"].includes(args[1]) ||
      args[2] !== "--dist" || !path.isAbsolute(args[3] ?? "") || args[4] !== "--prepared" ||
      !path.isAbsolute(args[5] ?? "") || args.length === 7 && args[6] !== "--apply") throw new BaselineOperatorError(usage);
  return { target: publicationTarget(args[1]), distDirectory: args[3], preparedPath: args[5], apply: args.length === 7 };
}
export async function main(args = process.argv.slice(2)) {
  let storage: { close(): void } | undefined;
  try {
    const { target, distDirectory, preparedPath, apply } = parseBaselineArguments(args);
    const { prepareContentBaseline, seedContentBaseline, baselineSummary } = await import("./public-content-baseline-artifact");
    const metadata = statSync(preparedPath);
    if (!metadata.isFile() || metadata.size > 16 * 1024) throw new BaselineOperatorError("The prepared artifact receipt exceeds its bound");
    const preparedArtifact = JSON.parse(readFileSync(preparedPath, "utf8"));
    const plan = await prepareContentBaseline({ target, distDirectory, preparedArtifact });
    let result = baselineSummary(plan);
    if (apply) {
      const [{ createContentBaselineStorage }, { parsePreviewStorageCredential }] = await Promise.all([
        import("./public-content-baseline-storage"), import("./cms-preview-storage-credential"),
      ]);
      const upload = createContentBaselineStorage({ target, credential: parsePreviewStorageCredential(readFileSync(3, "utf8")) });
      storage = upload;
      result = await seedContentBaseline(plan, upload);
    }
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    process.stderr.write(baselineOperatorErrorMessage(error) + "\n");
    process.exitCode = 1;
  } finally { storage?.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
