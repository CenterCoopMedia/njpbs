import { timingSafeEqual } from "node:crypto";
import { FUNCTION_SECRETS, FunctionsConfigurationError } from "./functions-configuration.mjs";
const project = "njpbs-site";
const names = new Set(Object.keys(FUNCTION_SECRETS));

function secretPath(name) {
  if (!names.has(name)) throw new FunctionsConfigurationError("Unknown CMS deployment secret");
  return `projects/${project}/secrets/${name}`;
}

export async function currentVersionMatches(name, desired, client) {
  const path = secretPath(name);
  const baseUrl = `https://secretmanager.googleapis.com/v1/${path}`;
  let version;
  try {
    version = (await client.request({ url: `${baseUrl}/versions/latest` })).data;
  } catch (error) {
    if (error.response?.status !== 404) {
      throw new FunctionsConfigurationError(`Could not read latest version metadata for ${name}`);
    }
    let secret;
    try {
      secret = (await client.request({ url: baseUrl })).data;
    } catch {
      throw new FunctionsConfigurationError(`Could not verify empty secret resource for ${name}`);
    }
    if (!new RegExp(`^projects/(?:${project}|[0-9]+)/secrets/${name}$`).test(secret?.name)) throw new FunctionsConfigurationError(`Invalid secret resource for ${name}`);
    return false;
  }

  if (
    version?.state !== "ENABLED" ||
    !new RegExp(`^projects/(?:${project}|[0-9]+)/secrets/${name}/versions/[0-9]+$`).test(version.name)
  ) {
    throw new FunctionsConfigurationError(`Latest secret version is not enabled for ${name}`);
  }

  let accessed;
  try {
    accessed = (await client.request({
      url: `${baseUrl}/versions/${version.name.split("/").at(-1)}:access`,
    })).data;
  } catch {
    throw new FunctionsConfigurationError(`Could not compare latest secret value for ${name}`);
  }
  const encoded = accessed?.payload?.data;
  if (accessed?.name !== version.name || typeof encoded !== "string" ||
      !/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded)) {
    throw new FunctionsConfigurationError(`Invalid latest secret payload for ${name}`);
  }
  const current = Buffer.from(encoded, "base64");
  const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (current.toString("base64").replace(/=+$/, "") !== normalized) {
    throw new FunctionsConfigurationError(`Invalid latest secret payload for ${name}`);
  }
  return current.length === desired.length && timingSafeEqual(current, desired);
}

export async function setSecret(name, desired, client) {
  const path = secretPath(name);
  try {
    // Avoid Firebase CLI debug logs, which can include the addVersion payload.
    // Do not retry a write whose response was lost: it may already have succeeded.
    const { data: version } = await client.request({
      url: `https://secretmanager.googleapis.com/v1/${path}:addVersion`,
      method: "POST",
      data: { payload: { data: desired.toString("base64") } },
      retry: false,
    });
    if (version?.state !== "ENABLED" ||
        !new RegExp(`^projects/(?:${project}|[0-9]+)/secrets/${name}/versions/[0-9]+$`).test(version?.name)) {
      throw new FunctionsConfigurationError("Unverified new secret version");
    }
  } catch {
    throw new FunctionsConfigurationError(`Secret provisioning failed for ${name}; verify latest version before retrying`);
  }
}

export async function provisionCmsSecret(name, value, client, setter = setSecret) {
  secretPath(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new FunctionsConfigurationError(`Missing provisioning value for ${name}`);
  }
  const desired = Buffer.from(value, "utf8");
  if (await currentVersionMatches(name, desired, client)) {
    console.log(`Reusing latest enabled version of ${name}`);
    return false;
  }
  await setter(name, desired, client);
  console.log(`Provisioned new version of ${name}`);
  return true;
}
