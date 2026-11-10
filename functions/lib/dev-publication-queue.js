"use strict";

const { publicationTarget } = require("./publication-target");
const { assertPublicWorkerCandidateDatabase } = require("./public-worker-candidate");
const { assertCmsPublicationCloudAdmission } = require("./cms-publication-runtime-control");
const { assertPublicDeploymentPointer } = require("./public-deployment");
const { readNoBuildPostCapability } = require("./no-build-post-ownership");

// Only new dev GitHub jobs use this admission. A retained reservation keeps the
// runtime recorded when its published snapshot was accepted.
async function newDevGithubQueueFields({ firestore, transaction, control, transport }) {
  if (process.env.CMS_DEPLOYMENT_ENVIRONMENT !== "development" || transport !== "github") return {};
  const target = publicationTarget("development");
  assertPublicWorkerCandidateDatabase(firestore, target);
  const [capability, pointerRow] = await Promise.all([
    readNoBuildPostCapability({ firestore, transaction }),
    transaction.get(firestore.doc("system/publicDeployment")),
  ]);
  const pointer = pointerRow.exists ? assertPublicDeploymentPointer(pointerRow.data()) : null;
  if (!control?.cloud || capability?.schemaVersion !== 2 || !pointer ||
      pointer.activeCommitSha !== capability.rendererSha) {
    throw Object.assign(new Error("Development publication requires its ready cloud renderer."), { status: 409 });
  }
  const cloud = assertCmsPublicationCloudAdmission(control, { commitSha: capability.rendererSha });
  if (cloud.serializerId !== target.serializerId) {
    throw Object.assign(new Error("Development publication has a different cloud owner."), { status: 409 });
  }
  return { environment: target.environment, projectId: target.projectId,
    runtime: { owner: "cloudflare", release: cloud.commitSha } };
}

module.exports = { newDevGithubQueueFields };
