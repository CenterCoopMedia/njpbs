import { readCmsReaderProviderIdentities } from "./cms-reader-provider-readback.mjs";
const refuse = () => { throw new Error("Enabled CMS reader provider readback unavailable"); };
const readerNames = ["cmsReaderV1", "cmsReaderV2", "cmsReadPairCurrentCodeV2",
  "cmsGetPublicPage", "cmsSaveContent", "cmsTransitionContent", "onScheduledPublish"];

// Fixed native project/Worker targets; raw provider variables never leave here.
export async function readEnabledCmsReaderProviders({ projectId, accountId, sourceSha, binding, apiVars,
  readGoogleToken, readCloudflareToken, fetchImpl = fetch }) {
  const identities = await readCmsReaderProviderIdentities({ projectId, accountId,
    readCloudflareToken, readGoogleToken, fetchImpl, inspectFunctions(functions) {
      for (const name of readerNames) {
        const fn = functions.find(row => row.name === `projects/${projectId}/locations/us-central1/functions/${name}`);
        const vars = fn?.serviceConfig?.environmentVariables;
        if (fn?.state !== "ACTIVE" || fn.buildConfig?.entryPoint !== name ||
            vars?.CMS_ADMIN_BUILD_REVISION !== sourceSha ||
            Object.entries(binding).some(([key, value]) => vars?.[key] !== value)) refuse();
      }
      if (functions.some(fn => fn.state !== "ACTIVE")) refuse();
    } });
  if (apiVars === undefined) return identities;
  // Check the exact executing version's public vars, never secret field values.
  const token = await readCloudflareToken();
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${identities.cmsApi.script}/versions/${identities.cmsApi.versionId}`,
    { method: "GET", redirect: "error", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) refuse();
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length; if (size > 8 * 1024 * 1024) refuse(); chunks.push(part.value);
    }
  } finally { await reader.cancel(); }
  const body = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  const bindings = body.result?.resources?.bindings;
  if (body.success !== true || body.result?.id !== identities.cmsApi.versionId || !Array.isArray(bindings) ||
      Object.entries(apiVars).some(([name, value]) => {
        const rows = bindings.filter(row => row.name === name);
        return rows.length !== 1 || rows[0].type !== "plain_text" || rows[0].text !== value;
      })) refuse();
  return identities;
}
