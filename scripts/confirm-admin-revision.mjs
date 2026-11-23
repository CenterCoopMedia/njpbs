#!/usr/bin/env node
import { isDevelopmentName } from "./lib/cms-target.mjs";

const expected = process.env.DEPLOY_SHA;
if (!/^[0-9a-f]{40}$/.test(expected ?? "")) {
  throw new Error("DEPLOY_SHA is not a full revision");
}
// The dev Admin admits no service token through Access, so a development run
// reads the commit of the latest dev Pages deployment instead of admin-status.json.
const development = process.env.CMS_TARGET === "development";
const pagesProject = process.env.CMS_TARGET_ADMIN_PAGES ?? "";
if (development && !isDevelopmentName(pagesProject)) {
  throw new Error("CMS_TARGET_ADMIN_PAGES must name the dev Admin Pages project");
}

async function readRevision() {
  if (development) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/pages/projects/${pagesProject}/deployments?env=production&per_page=1`, {
      redirect: "error", headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` }, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return { error: `dev Admin Pages deployments HTTP ${response.status}` };
    const latest = (await response.json())?.result?.[0];
    const revision = latest?.deployment_trigger?.metadata?.commit_hash;
    return latest?.latest_stage?.name === "deploy" && latest.latest_stage.status === "success"
      ? { revision } : { error: "dev Admin Pages deployment is not complete" };
  }
  const response = await fetch("https://admin.njpbs.org/admin-status.json", {
    method: "GET",
    redirect: "error",
    cache: "no-store",
    headers: {
      accept: "application/json",
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return { error: `Admin status HTTP ${response.status}` };
  const body = await response.json();
  const schema = body?.schemaVersion;
  return (schema === 1 || schema === 2) && body?.environment === "Production" && body?.status === "current"
    ? { revision: body?.build?.revision } : { error: "Admin status is not the current production build" };
}

let lastError = "Admin status was not read";
for (let attempt = 1; attempt <= 12; attempt += 1) {
  try {
    const { revision, error } = await readRevision();
    if (revision === expected) {
      process.stdout.write(`live Admin revision ${revision}\n`);
      process.exit(0);
    }
    lastError = error ?? `live Admin revision ${revision || "missing"} != ${expected}`;
  } catch (error) {
    lastError = error instanceof Error ? error.message : "Admin status could not be read";
  }
  if (attempt < 12) await new Promise((resolve) => setTimeout(resolve, 5000));
}
throw new Error(lastError);
