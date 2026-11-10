import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import {
  projectPublicArtifactContent,
  readPublicArtifactContentFromDatabase,
  resolveFirestoreConnection,
  type PublicArtifactBuildRequest,
} from "./cms-loader";
import {
  PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION,
  readPublicArtifactBundle,
  writePublicArtifactBundle,
} from "./public-artifact-bundle";

type Env = Record<string, string | undefined>;

export async function preparePublicArtifactBundle(
  request: PublicArtifactBuildRequest,
  wallClock = new Date(),
  env: Env = process.env,
): Promise<void> {
  if (request.batchMode === "deployed") {
    const retainedPath = env.PUBLIC_ARTIFACT_DEPLOYED_CONTEXT_PATH;
    if (!retainedPath) throw new Error("A deployed build requires retained public context");
    const bundle = await readPublicArtifactBundle(retainedPath);
    if (bundle.receipt.buildBatchId !== request.buildBatchId || bundle.receipt.commitSha !== request.commitSha) {
      throw new Error("Retained public context does not match the Pages build");
    }
    await writePublicArtifactBundle(request.bundlePath, bundle);
    return;
  }
  const connection = resolveFirestoreConnection(env);
  if (!connection) {
    throw new Error("The public artifact build requires Firestore credentials");
  }
  const requireModule = createRequire(import.meta.url);
  const { initializeApp, getApps, deleteApp, applicationDefault } =
    requireModule("firebase-admin/app");
  const { getFirestore } = requireModule("firebase-admin/firestore");
  const appName = "public-artifact-bundle-v3";
  const existing = getApps().find((app: { name: string }) => app.name === appName);
  if (connection.mode === "credentials") realpathSync(connection.credentialsPath);
  const app = existing || initializeApp(
    connection.mode === "credentials"
      ? { projectId: connection.projectId, credential: applicationDefault() }
      : { projectId: connection.projectId },
    appName,
  );
  try {
    const read = await readPublicArtifactContentFromDatabase(
      getFirestore(app) as never,
      request,
      wallClock,
    );
    const projected = projectPublicArtifactContent(read);
    await writePublicArtifactBundle(request.bundlePath, {
      schemaVersion: PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION,
      ...projected,
    });
  } finally {
    if (!existing) await deleteApp(app).catch(() => {});
  }
}
