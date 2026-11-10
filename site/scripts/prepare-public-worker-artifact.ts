import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPublicArtifactInventoryReceipt,
} from "../src/lib/public-artifact-inventory";
import { preparePublicWorkerArtifact } from "../src/lib/public-worker-artifact";

const distDirectory = fileURLToPath(new URL("../dist", import.meta.url));

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [artifactReceiptPath, preparedOutputPath, ...extra] = argv;
  if (
    extra.length > 0 ||
    !artifactReceiptPath ||
    !preparedOutputPath ||
    !path.isAbsolute(artifactReceiptPath) ||
    !path.isAbsolute(preparedOutputPath)
  ) {
    throw new Error(
      "Absolute artifact inventory and prepared Worker receipt paths are required",
    );
  }
  let artifactReceipt: unknown;
  try {
    artifactReceipt = JSON.parse(await readFile(artifactReceiptPath, "utf8"));
  } catch {
    throw new Error("The public artifact inventory receipt is missing or invalid");
  }
  const prepared = await preparePublicWorkerArtifact({
    artifactReceipt: assertPublicArtifactInventoryReceipt(artifactReceipt),
    distDirectory,
    outputPath: preparedOutputPath,
  });
  console.log(
    `Prepared public Worker artifact ${prepared.buildBatchId} generation ${prepared.generation}`,
  );
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
