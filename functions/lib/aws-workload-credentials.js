"use strict";

const { fromWebToken } = require("@aws-sdk/credential-providers");

const METADATA_IDENTITY_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";
const MAX_IDENTITY_TOKEN_BYTES = 32 * 1024;

async function readGoogleIdentityToken(audience, deps = {}) {
  if (typeof audience !== "string" || !audience.trim() || audience.length > 512) {
    throw new Error("AWS workload identity audience is not configured");
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${METADATA_IDENTITY_URL}?audience=${encodeURIComponent(audience)}&format=full&licenses=FALSE`,
    {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!response.ok) {
    throw new Error("Google workload identity token request failed");
  }
  const token = (await response.text()).trim();
  if (!token || Buffer.byteLength(token, "utf8") > MAX_IDENTITY_TOKEN_BYTES) {
    throw new Error("Google workload identity token response is invalid");
  }
  return token;
}

async function createAwsRoleCredentials({ roleArn, audience, region }, deps = {}) {
  const webIdentityToken = await readGoogleIdentityToken(audience, deps);
  const provider = (deps.fromWebTokenFn ?? fromWebToken)({
    roleArn,
    roleSessionName: "boardwalk-source-media",
    webIdentityToken,
    clientConfig: { region },
  });
  return provider();
}

function createAwsRoleCredentialProvider(config, deps = {}) {
  let cached = null;
  let pending = null;
  return async () => {
    const expiresAt = cached?.expiration instanceof Date
      ? cached.expiration.valueOf()
      : 0;
    if (cached && expiresAt > Date.now() + 5 * 60 * 1000) return cached;
    if (!pending) {
      pending = createAwsRoleCredentials(config, deps)
        .then((credentials) => {
          cached = credentials;
          return credentials;
        })
        .finally(() => {
          pending = null;
        });
    }
    return pending;
  };
}

module.exports = {
  MAX_IDENTITY_TOKEN_BYTES,
  METADATA_IDENTITY_URL,
  createAwsRoleCredentialProvider,
  createAwsRoleCredentials,
  readGoogleIdentityToken,
};
