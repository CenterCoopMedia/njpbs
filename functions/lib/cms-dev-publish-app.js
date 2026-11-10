"use strict";

const { createSign } = require("node:crypto");
const { defineString } = require("firebase-functions/params");
const { publishGithubRepository } = require("./cms-publish-repository");

const INSTALLATION_ID = defineString("CMS_PUBLISH_GITHUB_INSTALLATION_ID", { default: "" });
const REFRESH_SKEW_MS = 5 * 60 * 1000;

// Carries only an HTTP status or a fixed reason, never response or key material.
class AppTokenError extends Error {}

// One warm Function instance may reuse its token. Concurrent dispatches share
// the same exchange; a failed exchange never remains in the cache.
function createInstallationTokenProvider({ fetchImpl = fetch, now = Date.now, installationId } = {}) {
  let scope = null;

  return async function installationToken({ appId, privateKey }) {
    const repository = publishGithubRepository();
    const configuredId = String(installationId ??
      process.env.CMS_PUBLISH_GITHUB_INSTALLATION_ID ?? INSTALLATION_ID.value()).trim();
    if (!/^[0-9]+$/.test(configuredId) || !/^[0-9]+$/.test(appId ?? "") || !privateKey) {
      throw new Error("Development publication App credentials are not configured");
    }
    if (!scope || scope.repository !== repository || scope.installationId !== configuredId || scope.appId !== appId) {
      scope = { repository, installationId: configuredId, appId, cached: null, pending: null };
    }
    const state = scope;
    const current = now();
    if (state.cached && current < state.cached.expiresAt - REFRESH_SKEW_MS) return state.cached.token;
    if (state.pending) return state.pending;

    state.pending = (async () => {
      try {
        const issuedAt = Math.floor(now() / 1000);
        const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
        const claims = Buffer.from(JSON.stringify({ iat: issuedAt - 60, exp: issuedAt + 9 * 60, iss: appId })).toString("base64url");
        const unsigned = `${header}.${claims}`;
        const signer = createSign("RSA-SHA256");
        signer.update(unsigned);
        const jwt = `${unsigned}.${signer.sign(privateKey, "base64url")}`;
        const response = await fetchImpl(`https://api.github.com/app/installations/${configuredId}/access_tokens`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "njpbs-cms-publish",
          },
          body: JSON.stringify({ repositories: [repository.split("/")[1]], permissions: { contents: "write" } }),
        });
        if (!response.ok) {
          throw new AppTokenError(`Development publication App token exchange failed with HTTP ${Number(response.status) || "unknown"}`);
        }
        const body = await response.json();
        const expiresAt = Date.parse(body?.expires_at);
        if (typeof body?.token !== "string" || !body.token ||
            !Number.isFinite(expiresAt) || expiresAt <= now() + REFRESH_SKEW_MS) {
          throw new AppTokenError("Development publication App token response is invalid");
        }
        state.cached = { token: body.token, expiresAt };
        return body.token;
      } catch (error) {
        // GitHub response bodies and crypto errors can contain credential material.
        if (error instanceof AppTokenError) throw error;
        throw new AppTokenError("Development publication App token unavailable");
      } finally {
        state.pending = null;
      }
    })();
    return state.pending;
  };
}

module.exports = { AppTokenError, createInstallationTokenProvider, INSTALLATION_ID };
