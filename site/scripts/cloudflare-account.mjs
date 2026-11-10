/** Resolve public account configuration before creating a cloud client.
 * Container integration must forward this binding through PreviewRenderer.envVars
 * in preview-renderer/worker.ts and PublicationRuntime.envVars in publisher/worker.ts.
 * The publisher also forwards CLOUDFLARE_PUBLIC_WORKER_TAG before startup.
 */
export function cloudflareAccount(env = process.env) {
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  if (typeof account !== "string" || account.length !== 32 || !/^[a-f0-9]{32}$/.test(account)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be configured as a 32-character lowercase hex account ID");
  }
  return account;
}

export function cloudflareR2Endpoint(env = process.env) {
  return `https://${cloudflareAccount(env)}.r2.cloudflarestorage.com`;
}

export class CloudflareConfigurationError extends Error {
  constructor(message) { super(message); this.name = "CloudflareConfigurationError"; }
}

/** Resolve resource pins locally without disclosing their configured values. */
export function cloudflarePublicZone(env = process.env) {
  const zone = env.CLOUDFLARE_PUBLIC_ZONE_ID;
  if (typeof zone !== "string" || zone.length !== 32 || !/^[a-f0-9]{32}$/.test(zone)) {
    throw new CloudflareConfigurationError("CLOUDFLARE_PUBLIC_ZONE_ID must be configured as a 32-character lowercase hex zone ID");
  }
  return zone;
}

export function cloudflarePublicWorkerTag(env = process.env) {
  const tag = env.CLOUDFLARE_PUBLIC_WORKER_TAG;
  if (typeof tag !== "string" || tag.length !== 32 || !/^[a-f0-9]{32}$/.test(tag)) {
    throw new CloudflareConfigurationError("CLOUDFLARE_PUBLIC_WORKER_TAG must be configured as a 32-character lowercase hex worker tag");
  }
  return tag;
}
