import { functionsInventoryIdentity } from "./cms-component-receipt.mjs";
import { DEV_TARGETS } from "../assert-dev-cms-targets.mjs";

const refuse = () => { throw new Error("CMS reader provider readback unavailable"); };
async function bytes(response) {
  if (!response.ok || !response.body) { await response.body?.cancel(); refuse(); }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break;
    size += part.value.length; if (size > 8 * 1024 * 1024) refuse(); chunks.push(part.value); }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
}

/** The deploy owner's inventory identity, over bounded native provider GETs.
 * No ADC fallback, provider mutation, HTTP retry or caller-selected endpoint. */
export async function readCmsReaderProviderIdentities({ projectId, accountId, readCloudflareToken, readGoogleToken, signal, fetchImpl = fetch, inspectFunctions }) {
  const development = projectId === "njpbs-site-dev";
  if (!development && projectId !== "njpbs-site" || !/^[a-f0-9]{32}$/.test(accountId ?? "") ||
      development && accountId !== DEV_TARGETS.CLOUDFLARE_ACCOUNT_ID) refuse();
  const script = development ? DEV_TARGETS.CMS_API_WORKER : "njpbs-cms-api";
  const json = async (url, readToken) => {
    try {
      signal?.throwIfAborted();
      const token = await readToken();
      if (typeof token !== "string" || !/^[\x21-\x7e]{1,32768}$/.test(token)) refuse();
      const response = await fetchImpl(url, { method: "GET", redirect: "error", cache: "no-store",
        headers: { authorization: `Bearer ${token}` }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
      const value = await bytes(response);
      if (value.success === false || value.errors?.length) refuse();
      return value;
    } catch { refuse(); }
  };
  const functions = [], seen = new Set(); let pageToken;
  for (let page = 0; page < 20; page++) {
    const url = `https://cloudfunctions.googleapis.com/v2/projects/${projectId}/locations/us-central1/functions?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const body = await json(url, readGoogleToken);
    if (!Array.isArray(body.functions) || body.functions.length > 100 || functions.length + body.functions.length > 1000 ||
        body.functions.some(fn => typeof fn.name !== "string" || !fn.name.startsWith(`projects/${projectId}/locations/us-central1/functions/`) || seen.has(fn.name))) refuse();
    body.functions.forEach(fn => seen.add(fn.name)); functions.push(...body.functions);
    if (!body.nextPageToken) { pageToken = null; break; }
    if (typeof body.nextPageToken !== "string" || body.nextPageToken.length > 2048 || body.nextPageToken === pageToken) refuse();
    pageToken = body.nextPageToken;
  }
  if (pageToken || !functions.length) refuse();
  inspectFunctions?.(functions);
  const value = (await json(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${script}/deployments`, readCloudflareToken)).result;
  const deployed = (value?.deployments ?? value)?.[0];
  const version = deployed?.versions?.[0];
  if (typeof deployed?.id !== "string" || !/^[A-Za-z0-9._:-]{1,80}$/.test(deployed.id) || deployed.versions?.length !== 1 ||
      version.percentage !== 100 || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(version.version_id ?? "")) refuse();
  return { functions: functionsInventoryIdentity(functions), cmsApi: { script, deploymentId: deployed.id, versionId: version.version_id } };
}
