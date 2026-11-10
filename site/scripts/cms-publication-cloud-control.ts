import { createRequire } from "node:module";
import type { Firestore } from "firebase-admin/firestore";

const requireModule = createRequire(import.meta.url);
const liveBlog = requireModule("../../functions/lib/live-blog-compatibility.js");
const runtimeControlModule = requireModule(
  "../../functions/lib/cms-publication-runtime-control.js",
) as {
  RUNTIME_DOCUMENT_PATH: string;
  parseCmsPublicationRuntimeControl(value: unknown): PublicationRuntimeControl;
  cloudCmsPublicationRuntimeControl(value: unknown): CloudRuntimeControl;
};

export const PUBLICATION_RUNTIME_DOCUMENT =
  runtimeControlModule.RUNTIME_DOCUMENT_PATH;

export type PublicationRuntimeControl = {
  schemaVersion: 1;
  phase: "paused" | "starting" | "ready";
  commitSha: string;
  serializerId: string;
  cloud?: CloudRuntimeControl;
};
type CloudRuntimeControl = Pick<PublicationRuntimeControl, "phase" | "commitSha" | "serializerId">;

export function parsePublicationRuntimeControl(
  value: unknown,
): PublicationRuntimeControl {
  return runtimeControlModule.parseCmsPublicationRuntimeControl(value);
}

export async function assertPublicationRuntimeIdentity(
  firestore: Firestore,
  commitSha: string,
  serializerId: string,
): Promise<CloudRuntimeControl> {
  const snapshot = await firestore.doc(PUBLICATION_RUNTIME_DOCUMENT).get();
  if (!snapshot.exists) {
    throw new Error("Cloud publication requires a runtime control");
  }
  const control = runtimeControlModule.cloudCmsPublicationRuntimeControl(snapshot.data());
  if (control.commitSha !== commitSha || control.serializerId !== serializerId) {
    throw new Error("Cloud publication requires another serializer");
  }
  return control;
}

/** Startup can open only the exact control that remains in the starting phase. */
export async function confirmPublicationRuntimeReady(
  firestore: Firestore,
  commitSha: string,
  serializerId: string,
): Promise<void> {
  const ref = firestore.doc(PUBLICATION_RUNTIME_DOCUMENT);
  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) {
      throw new Error("Cloud publication runtime control disappeared during startup");
    }
    const parsed = parsePublicationRuntimeControl(snapshot.data());
    const control = parsed.cloud ?? parsed;
    if (control.commitSha !== commitSha || control.serializerId !== serializerId) {
      throw new Error("Cloud publication runtime control changed during startup");
    }
    liveBlog.writeLiveBlogContractMarker({ firestore, transaction, rendererSha: commitSha });
    if (control.phase !== "starting") return;
    transaction.update(ref, { [parsed.cloud ? "cloud.phase" : "phase"]: "ready" });
  });
}
