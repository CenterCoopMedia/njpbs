import { cloudflareAccount } from "./cloudflare-account.mjs";
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
export const PUBLIC_WORKER_NAME = "njpbs-production";
export { cloudflarePublicWorkerTag as publicWorkerTag } from "./cloudflare-account.mjs";

export function workerApiPath(suffix: string): string {
  return `${CLOUDFLARE_API}/accounts/${cloudflareAccount()}${suffix}`;
}
