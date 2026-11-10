import { CloudflareConfigurationError, cloudflarePublicWorkerTag } from "./cloudflare-account.mjs";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PUBLIC_WORKER_NAME,
  PublicWorkerActivationOperatorError,
  activeDeployment,
  assertProductionWorkerSubdomainDisabled,
  assertPublicWorkerIdentity,
  assertUploadOnlyProductionTrigger,
  requestCloudflareJson,
  workerApiPath,
} from "./activate-public-worker-candidate.ts";

const requireModule = createRequire(import.meta.url);
const { parseCloudflareToken } = requireModule("../../scripts/bootstrap-public-deployment.cjs") as {
  parseCloudflareToken(value: string): string;
};

type RequestJson = typeof requestCloudflareJson;
export type ActivationAccessRead = "worker-identity" | "build-trigger" | "worker-subdomain" | "active-deployment";
export interface ActivationAccessCheck { read: ActivationAccessRead; ok: boolean; reason?: string }

function refused(error: unknown): string {
  // Operator messages carry a status code or a fixed sentence, never a
  // credential, a header or a provider response body.
  return error instanceof PublicWorkerActivationOperatorError || error instanceof CloudflareConfigurationError ? error.message : "The read did not complete";
}

/** Makes each provider read of an activation with the publisher's own token,
 * and applies the activation's own assertions. It writes nothing, so it does
 * not prove the deployment write. Run it before the admission pause. */
export async function checkPublicWorkerActivationAccess({ cloudflareApiToken, requestJson = requestCloudflareJson }: {
  cloudflareApiToken: string; requestJson?: RequestJson;
}): Promise<ActivationAccessCheck[]> {
  const checks: ActivationAccessCheck[] = [];
  try { cloudflarePublicWorkerTag(); }
  catch (error) {
    return (["worker-identity", "build-trigger", "worker-subdomain", "active-deployment"] as const)
      .map(read => ({ read, ok: false, reason: refused(error) }));
  }
  const get = (suffix: string) => requestJson({ url: workerApiPath(suffix), method: "GET", token: cloudflareApiToken });
  async function check(read: ActivationAccessRead, work: () => Promise<void>) {
    try {
      await work();
      checks.push({ read, ok: true });
    } catch (error) {
      checks.push({ read, ok: false, reason: refused(error) });
    }
  }
  let workerTag: string | undefined;
  await check("worker-identity", async () => { workerTag = assertPublicWorkerIdentity(await get("/workers/scripts")); });
  await check("build-trigger", async () => {
    if (!workerTag) throw new PublicWorkerActivationOperatorError("The Worker identity was not read");
    assertUploadOnlyProductionTrigger(await get(`/builds/workers/${workerTag}/triggers`), workerTag);
  });
  await check("worker-subdomain", async () => {
    assertProductionWorkerSubdomainDisabled(await get(`/workers/scripts/${PUBLIC_WORKER_NAME}/subdomain`));
  });
  await check("active-deployment", async () => {
    const active = activeDeployment(await get(`/workers/scripts/${PUBLIC_WORKER_NAME}/deployments`));
    if (!active || typeof active !== "object" || !Object.keys(active).length) {
      throw new PublicWorkerActivationOperatorError("The active deployment was not readable");
    }
  });
  return checks;
}

/** The token arrives on file descriptor 3, as it does for the activation operator. */
export async function main(): Promise<void> {
  try {
    const checks = await checkPublicWorkerActivationAccess({ cloudflareApiToken: parseCloudflareToken(readFileSync(3, "utf8")) });
    const ok = checks.every(entry => entry.ok);
    process.stdout.write(`${JSON.stringify({ ok, checks })}\n`);
    if (!ok) process.exitCode = 1;
  } catch {
    process.stderr.write("Activation access check refused: the token input is missing or invalid\n");
    process.exitCode = 1;
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  void main();
}
