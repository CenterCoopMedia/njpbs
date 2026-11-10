#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const ZONE_NAME = "njpbs.org";
const ADMIN_HOST = "admin.njpbs.org";
const RULE_REF = "disable_rocket_loader_admin_njpbs";
const RULESET_NAME = "Boardwalk configuration";
const RULESET_DESCRIPTION =
  "Zone configuration rules for Boardwalk Admin delivery.";
const RULE_DESCRIPTION =
  "Disable Rocket Loader on admin.njpbs.org so Vite module tags stay type=module (issue #1897).";
const RULE_ACTION_PARAMETERS = Object.freeze({ rocket_loader: false });

function adminRocketLoaderRule() {
  return {
    ref: RULE_REF,
    expression: `http.host eq "${ADMIN_HOST}"`,
    description: RULE_DESCRIPTION,
    action: "set_config",
    enabled: true,
    action_parameters: { ...RULE_ACTION_PARAMETERS },
  };
}

function ruleIdFromRuleset(result, ref = RULE_REF) {
  const rules = Array.isArray(result?.rules) ? result.rules : [];
  const match = rules.find((entry) => entry?.ref === ref);
  return typeof match?.id === "string" ? match.id : null;
}

function sameOwnedRule(existing, rule) {
  if (!existing) return false;
  if (existing.expression !== rule.expression) return false;
  if (existing.action !== rule.action) return false;
  if (existing.enabled === false) return false;
  return JSON.stringify(existing.action_parameters ?? null) === JSON.stringify(rule.action_parameters);
}

async function cloudflareRequest(
  fetchFn,
  apiToken,
  url,
  init = {},
  { allowNotFound = false } = {},
) {
  const response = await fetchFn(url, {
    ...init,
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => null);
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok || body?.success !== true) {
    const detail = Array.isArray(body?.errors)
      ? body.errors.map((error) => error?.message).filter(Boolean).join("; ")
      : "";
    throw new Error(
      `Cloudflare request failed (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  return body.result;
}

export async function configureAdminRocketLoader({
  apiToken,
  zoneName = ZONE_NAME,
  fetchFn = fetch,
} = {}) {
  if (typeof apiToken !== "string" || apiToken.trim().length < 20) {
    throw new Error("CLOUDFLARE_API_TOKEN is missing or invalid");
  }

  const zones = await cloudflareRequest(
    fetchFn,
    apiToken,
    `${CLOUDFLARE_API}/zones?name=${encodeURIComponent(zoneName)}`,
  );
  const zone = Array.isArray(zones)
    ? zones.find((entry) => entry?.name === zoneName && typeof entry?.id === "string")
    : null;
  if (!zone) {
    throw new Error(`Expected one Cloudflare zone named ${zoneName}`);
  }

  const zoneUrl = `${CLOUDFLARE_API}/zones/${zone.id}`;
  const rule = adminRocketLoaderRule();
  const entrypoint = await cloudflareRequest(
    fetchFn,
    apiToken,
    `${zoneUrl}/rulesets/phases/http_config_settings/entrypoint`,
    {},
    { allowNotFound: true },
  );

  if (!entrypoint?.id) {
    const created = await cloudflareRequest(fetchFn, apiToken, `${zoneUrl}/rulesets`, {
      method: "POST",
      body: JSON.stringify({
        name: RULESET_NAME,
        description: RULESET_DESCRIPTION,
        kind: "zone",
        phase: "http_config_settings",
        rules: [rule],
      }),
    });
    return {
      zoneId: zone.id,
      rulesetId: created?.id ?? null,
      ruleId: ruleIdFromRuleset(created),
      ruleRef: RULE_REF,
      operation: "created",
    };
  }

  const existing = Array.isArray(entrypoint.rules)
    ? entrypoint.rules.find((entry) => entry?.ref === RULE_REF)
    : null;
  if (sameOwnedRule(existing, rule)) {
    return {
      zoneId: zone.id,
      rulesetId: entrypoint.id,
      ruleId: existing.id ?? null,
      ruleRef: RULE_REF,
      operation: "unchanged",
    };
  }

  const result = await cloudflareRequest(
    fetchFn,
    apiToken,
    existing?.id
      ? `${zoneUrl}/rulesets/${entrypoint.id}/rules/${existing.id}`
      : `${zoneUrl}/rulesets/${entrypoint.id}/rules`,
    {
      method: existing?.id ? "PATCH" : "POST",
      body: JSON.stringify(rule),
    },
  );

  return {
    zoneId: zone.id,
    rulesetId: result?.id ?? entrypoint.id,
    ruleId: ruleIdFromRuleset(result) ?? existing?.id ?? null,
    ruleRef: RULE_REF,
    operation: existing?.id ? "updated" : "added",
  };
}

async function main() {
  const result = await configureAdminRocketLoader({
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
  });
  console.log(
    `Cloudflare ${result.operation} Rocket Loader off for ${ADMIN_HOST} (zone ${result.zoneId}).`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
