import path from "node:path";
import { fileURLToPath } from "node:url";
import firebaseRuntime from "../../scripts/update-publish-status.cjs";
import pagesRuntime from "../../functions/lib/pages-public-artifact.js";
import { createCmsPreviewCloudStorage } from "./cms-preview-cloud-storage.ts";
import { parsePreviewStorageCredential } from "./cms-preview-storage-credential.ts";
import { writePublicArtifactBundle } from "../src/lib/public-artifact-bundle.ts";

const { initFirebase } = firebaseRuntime;
const { selectActivePublicBuildBatch } = pagesRuntime;

export async function preparePagesPublicContext(commitSha: string, buildBatchId: string, outputPath: string) {
  if (!path.isAbsolute(outputPath)) throw new Error("The Pages context path must be absolute");
  const rawCredential = process.env.CMS_PREVIEW_R2_CREDENTIAL ?? "";
  delete process.env.CMS_PREVIEW_R2_CREDENTIAL;
  const storage = createCmsPreviewCloudStorage({ ...parsePreviewStorageCredential(rawCredential), contextMode: "code" });
  try {
    const firestore = initFirebase();
    // The reader checks the active Worker receipt before and after fetching the
    // digest-bound frozen bundle. No historical Firestore read is needed.
    const { publicContext, publication } = await storage.readPublicContext(firestore);
    const selected = await selectActivePublicBuildBatch({ firestore, commitSha });
    if (selected.buildBatchId !== buildBatchId || publication.buildBatchId !== buildBatchId ||
        publication.commitSha !== commitSha || publication.generation !== selected.generation) {
      throw new Error("The retained Pages context does not match the selected active batch");
    }
    await writePublicArtifactBundle(outputPath, publicContext);
  } finally {
    storage.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [commitSha, buildBatchId, outputPath] = process.argv.slice(2);
  preparePagesPublicContext(commitSha, buildBatchId, outputPath).catch(() => {
    console.error("Could not prepare the retained Pages public context");
    process.exitCode = 1;
  });
}
