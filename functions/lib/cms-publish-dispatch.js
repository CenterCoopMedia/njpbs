"use strict";

// Dispatch admission is shared by Functions and the trusted workflow bootstrap.
function buildDispatchPayload({ queueId, triggeredBy }, env = process.env) {
  if (env.CMS_DEPLOYMENT_ENVIRONMENT === "development") {
    if ((env.GCLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT) !== "njpbs-site-dev" ||
        env.CMS_PUBLISH_TRANSPORT !== "github" ||
        [env.GCLOUD_PROJECT, env.GOOGLE_CLOUD_PROJECT].some(project => project && project !== "njpbs-site-dev")) {
      throw new Error("Development publication requires the dev project and GitHub transport");
    }
    return { event_type: "cms_dev_publish", client_payload: {
      queueId, triggeredBy, environment: "development", projectId: "njpbs-site-dev", transport: "github",
    } };
  }
  if ([env.GCLOUD_PROJECT, env.GOOGLE_CLOUD_PROJECT].includes("njpbs-site-dev")) {
    throw new Error("The dev project cannot dispatch a production publication");
  }
  return { event_type: "cms_publish", client_payload: { queueId, triggeredBy } };
}

function trustedPublishActors(env = process.env) {
  try {
    const actors = JSON.parse(env.CMS_PUBLISH_GITHUB_TRUSTED_ACTORS || "[]");
    return Array.isArray(actors) && actors.every(value => typeof value === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9-]{0,99}(?:\[bot\])?$/.test(value)) ? actors : [];
  } catch {
    return [];
  }
}

function assertPublishDispatch({ eventName, action, ref, sender, actor, payload }, environment, devActor) {
  const trusted = trustedPublishActors();
  if (!trusted.length || eventName !== "repository_dispatch" || ref !== "refs/heads/main" ||
      !/^[A-Za-z0-9]{20}$/.test(payload?.queueId ?? "")) {
    throw new Error("Invalid publication dispatch");
  }
  if (environment === "development") {
    if (!devActor || trusted.includes(devActor) || sender !== devActor || actor !== devActor ||
        action !== "cms_dev_publish" || payload.environment !== "development" ||
        payload.projectId !== "njpbs-site-dev" || payload.transport !== "github") {
      throw new Error("Invalid development publication dispatch");
    }
  } else if (environment !== "production" || action !== "cms_publish" || sender !== actor ||
      !trusted.includes(actor) || sender === devActor || payload.environment === "development" ||
      payload.projectId === "njpbs-site-dev") {
    throw new Error("Invalid production publication dispatch");
  }
}

module.exports = { buildDispatchPayload, assertPublishDispatch, trustedPublishActors };
