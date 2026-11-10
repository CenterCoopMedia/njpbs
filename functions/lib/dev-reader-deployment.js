"use strict";

// Deployment configuration only; requests never choose these identities.
function readerBinding(env, operationId) {
  if (env.FIREBASE_PROJECT_ID !== "njpbs-site-dev" || env.CMS_DEPLOYMENT_ENVIRONMENT !== "development" ||
      env.CMS_DEV_PUBLISH_ENABLED !== "false" ||
      !/^[0-9]{1,20}$/.test(env.GITHUB_RUN_ID ?? "") || !/^[1-9][0-9]{0,3}$/.test(env.GITHUB_RUN_ATTEMPT ?? "") ||
      Number(env.GITHUB_RUN_ATTEMPT) > 1000) throw new Error("Dev reader deployment authorization refused");
  return { CMS_READER_BRIDGE_ENABLED: "true", PUBLIC_RELEASE_READERS_ENABLED: "true", PUBLIC_RELEASE_COMPOSED_READERS_ENABLED: "true", CMS_READER_BRIDGE_OPERATION_ID: operationId,
    CMS_READER_BRIDGE_FUNCTIONS_CANDIDATE: `functions-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
    CMS_READER_BRIDGE_CMS_API_CANDIDATE: `cmsApi-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}` };
}

function devReaderUpdateDeployment(env = process.env) {
  devReaderDeployment(env); // Refuse installation inputs on an ordinary update.
  if (env.CMS_DEV_INSTALL_READER_BRIDGE === "true") throw new Error("Dev reader update mode refused");
  return readerBinding(env, `reader-dev-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`);
}

function devReaderDeployment(env = process.env) {
  const mode = env.CMS_DEV_INSTALL_READER_BRIDGE;
  if (mode !== undefined && mode !== "false" && mode !== "true") throw new Error("Dev reader mode refused");
  if (mode !== "true") {
    if (env.CMS_DEV_READER_OPERATION_ID || env.CMS_DEV_READER_INSTALL_AUTHORIZATION) throw new Error("Unexpected dev reader installation binding");
    return { CMS_READER_BRIDGE_ENABLED: "false", PUBLIC_RELEASE_READERS_ENABLED: "false", PUBLIC_RELEASE_COMPOSED_READERS_ENABLED: "false" };
  }
  if (env.CMS_DEV_READER_INSTALL_AUTHORIZATION !== "INSTALL_DEV_READERS" ||
      !/^reader-[a-z0-9][a-z0-9-]{0,63}$/.test(env.CMS_DEV_READER_OPERATION_ID ?? "")) throw new Error("Dev reader installation authorization refused");
  return readerBinding(env, env.CMS_DEV_READER_OPERATION_ID);
}
module.exports = { devReaderDeployment, devReaderUpdateDeployment };
