export function devAccessOrigin(env = process.env) {
  const value = env.CMS_DEV_ACCESS_ORIGIN;
  let url;
  try { url = new URL(value); } catch { /* Invalid configuration is refused below. */ }
  if (!url || url.protocol !== "https:" || url.origin !== value ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Configure CMS_DEV_ACCESS_ORIGIN as an HTTPS origin");
  }
  return url.origin;
}

export function deploymentEmail(name, env = process.env) {
  // config-input: CMS_DEV_EDITOR_EMAIL, CMS_DEV_SDK_CLIENT_EMAIL
  const value = env[name];
  if (typeof value !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ||
      value.toLowerCase() === "replace_me@example.org") {
    throw new Error(`Configure ${name} as an email identity`);
  }
  return value.toLowerCase();
}

export function deploymentOwner(env = process.env) {
  const value = env.CMS_DEPLOY_OWNER;
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(value) || value === "REPLACE_ME") {
    throw new Error("Configure CMS_DEPLOY_OWNER as a GitHub login");
  }
  return value;
}

export function previewRendererBindings(environment, account, env = process.env) {
  if (!["production", "development"].includes(environment) || !/^[a-f0-9]{32}$/.test(account ?? "")) {
    throw new Error("Configure the renderer environment and Cloudflare account");
  }
  return { CLOUDFLARE_ACCOUNT_ID: account,
    ...(environment === "development" ? { CMS_DEV_ACCESS_ORIGIN: devAccessOrigin(env) } : {}) };
}
