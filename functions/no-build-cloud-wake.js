"use strict";

const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { db } = require("./lib/firebase");
const { publicationTarget, assertPublicationDatabase } = require("./lib/publication-target");
const { cloudCmsPublicationRuntimeControl } = require("./lib/cms-publication-runtime-control");
const { readCloudPublicationWakeDeployment } = require("./lib/cloud-publication-wake-deployment");

/** Delivery is only a hint. Read the current release, never trust event order,
 * and let the Worker check due ownership before starting any compute. */
async function wakeNoBuildCloud({ firestore = db, fetchImpl = fetch,
  getToken = () => process.env.CMS_PUBLICATION_WAKE_TOKEN,
  getDeployment = readCloudPublicationWakeDeployment, environment, stateCollection } = {}) {
  if (stateCollection !== undefined && !["noBuildPosts", "noBuildPostOwners", "contexts"].includes(stateCollection)) return;
  const deployment = getDeployment();
  if (!deployment.enabled) return;
  const target = publicationTarget(environment ?? deployment.environment);
  assertPublicationDatabase(firestore, target);
  let snapshot;
  try { snapshot = await firestore.doc("system/cmsPublicationRuntime").get(); }
  catch {
    console.warn("Cloud publication control read failed; minute recovery remains due");
    return;
  }
  let control;
  try { control = cloudCmsPublicationRuntimeControl(snapshot.data()); }
  catch { return; }
  if (control.serializerId !== target.serializerId) return;
  try {
    const token = getToken();
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(token ?? "")) throw new Error();
    const response = await fetchImpl(`${target.publisherOrigin}/wake`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "x-publication-release": control.commitSha,
        "x-publication-target": target.environment },
      redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();
    if (response.status !== 204) throw new Error();
  } catch {
    // Never throw provider output or alter accepted work after a missed wake.
    console.warn("Cloud publication wake failed; minute recovery remains due");
  }
}
const options = { region: "us-central1", secrets: ["CMS_PUBLICATION_WAKE_TOKEN"], minInstances: 0, maxInstances: 2, timeoutSeconds: 30 };
exports.wakeNoBuildCloud = wakeNoBuildCloud;
exports.onNoBuildCloudState = onDocumentWritten({ ...options,
  document: "system/publicDeployment/{collection}/{document}" }, async event => wakeNoBuildCloud({ stateCollection: event.params.collection }));
exports.onNoBuildCloudCandidate = onDocumentWritten({ ...options,
  document: "system/publicDeployment/buildBatches/{batch}/candidates/{candidate}" }, async () => wakeNoBuildCloud());
exports.onNoBuildCloudRelease = onDocumentWritten({ ...options,
  document: "cmsPublicationSerializerJournals/{serializer}/releases/{release}" }, async () => wakeNoBuildCloud());
