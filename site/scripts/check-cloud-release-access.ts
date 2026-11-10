import { CloudflareConfigurationError } from "./cloudflare-account.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_WORKER_NAME, publicWorkerTag, workerApiPath } from "./public-worker-cloudflare.ts";

/** Access probe only: activation still validates identity, trigger and receipts.
 * Never consume provider bodies or include exceptions in operator output. */
export async function checkCloudReleaseAccess({
  cloudflareApiToken,
  fetchImpl = fetch,
  write = (line: string) => process.stdout.write(line),
}: {
  cloudflareApiToken: string;
  fetchImpl?: typeof fetch;
  write?: (line: string) => unknown;
}): Promise<number> {
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(cloudflareApiToken)) return 1;
  let endpoints: string[];
  try {
    endpoints = [
      "/workers/scripts",
      `/builds/workers/${publicWorkerTag()}/triggers`,
      `/workers/scripts/${PUBLIC_WORKER_NAME}/subdomain`,
      `/workers/scripts/${PUBLIC_WORKER_NAME}/deployments`,
    ];
  } catch (error) {
    if (error instanceof CloudflareConfigurationError) write(`${error.message}\n`);
    return 1;
  }
  let failed = false;
  for (const endpoint of endpoints) {
    let status = 0;
    try {
      const response = await fetchImpl(workerApiPath(endpoint), {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${cloudflareApiToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      status = response.status;
      await response.body?.cancel();
    } catch {
      // HTTP 0 denotes no completed response; arbitrary errors may hold secrets.
      status = 0;
    }
    write(`${endpoint} HTTP ${status}\n`);
    if (status < 200 || status >= 300) failed = true;
  }
  return failed ? 1 : 0;
}

export async function main(environment = process.env, fetchImpl: typeof fetch = fetch,
  write = (line: string) => process.stdout.write(line)): Promise<number> {
  const cloudflareApiToken = environment.CLOUDFLARE_API_TOKEN ?? "";
  delete environment.CLOUDFLARE_API_TOKEN;
  return checkCloudReleaseAccess({ cloudflareApiToken, fetchImpl, write });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = process.argv.length === 2 ? await main() : 1;
}
