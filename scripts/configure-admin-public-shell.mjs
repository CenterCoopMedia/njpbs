#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const ADMIN_DOMAIN = "admin.njpbs.org";
const POLICY_NAME = "Public Admin authentication shell";

async function cloudflareRequest(fetchFn, apiToken, url, init = {}) {
  const response = await fetchFn(url, {
    ...init,
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.success !== true) {
    const detail = Array.isArray(body?.errors)
      ? body.errors.map((error) => error?.message).filter(Boolean).join("; ")
      : "";
    throw new Error(
      `Cloudflare Access request failed (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  return body.result;
}

export async function configureAdminPublicShell({
  accountId,
  apiToken,
  fetchFn = fetch,
} = {}) {
  if (!/^[a-f0-9]{32}$/.test(accountId ?? "")) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID is invalid");
  }
  if (typeof apiToken !== "string" || apiToken.trim().length < 20) {
    throw new Error("CLOUDFLARE_API_TOKEN is missing or invalid");
  }

  const accountUrl = `${CLOUDFLARE_API}/accounts/${accountId}`;
  const applications = await cloudflareRequest(
    fetchFn,
    apiToken,
    `${accountUrl}/access/apps?per_page=100`,
  );
  const matches = Array.isArray(applications)
    ? applications.filter(
        (application) =>
          application?.type === "self_hosted" &&
          [
            application?.domain,
            ...(Array.isArray(application?.self_hosted_domains)
              ? application.self_hosted_domains
              : []),
          ].some((domain) => domain?.toLowerCase() === ADMIN_DOMAIN),
      )
    : [];
  if (matches.length !== 1 || typeof matches[0]?.id !== "string") {
    throw new Error(
      `Expected one self-hosted Cloudflare Access application for ${ADMIN_DOMAIN}; found ${matches.length}`,
    );
  }

  const application = matches[0];
  const policiesUrl = `${accountUrl}/access/apps/${application.id}/policies`;
  const policies = await cloudflareRequest(
    fetchFn,
    apiToken,
    `${policiesUrl}?per_page=100`,
  );
  const existing = Array.isArray(policies)
    ? policies.find((policy) => policy?.name === POLICY_NAME)
    : null;
  const payload = {
    name: POLICY_NAME,
    decision: "bypass",
    precedence: 1,
    include: [{ everyone: {} }],
    exclude: [],
    require: [],
  };
  const result = await cloudflareRequest(
    fetchFn,
    apiToken,
    existing?.id ? `${policiesUrl}/${existing.id}` : policiesUrl,
    {
      method: existing?.id ? "PUT" : "POST",
      body: JSON.stringify(payload),
    },
  );

  return {
    applicationId: application.id,
    policyId: result?.id ?? existing?.id ?? null,
    operation: existing?.id ? "updated" : "created",
  };
}

async function main() {
  const result = await configureAdminPublicShell({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
  });
  console.log(
    `Cloudflare Access ${result.operation} the public Admin authentication shell policy.`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
