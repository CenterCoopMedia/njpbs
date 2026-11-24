import { CloudflareConfigurationError, cloudflarePublicWorkerTag } from "./cloudflare-account.mjs";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PublicWorkerActivationOperatorError,
  activeDeployment,
  assertDevelopmentWorkerPrivate,
  assertProductionWorkerSubdomainDisabled,
  assertPublicWorkerIdentity,
  assertPublicWorkerTriggers,
  publicWorkerTarget,
  requestCloudflareJson,
  workerApiPath,
} from "./activate-public-worker-candidate.ts";
import type { PublicationTarget } from "../../functions/lib/publication-target";

const requireModule = createRequire(import.meta.url);
const { parseCloudflareToken } = requireModule("../../scripts/bootstrap-public-deployment.cjs") as {
  parseCloudflareToken(value: string): string;
};
const { publicationTarget } = requireModule("../../functions/lib/publication-target.js") as
  typeof import("../../functions/lib/publication-target");

type RequestJson = typeof requestCloudflareJson;
export type ActivationAccessRead = "worker-identity" | "build-trigger" | "worker-subdomain" | "active-deployment";
export interface ActivationAccessCheck { read: ActivationAccessRead; ok: boolean; reason?: string }

function refused(error: unknown): string {
  // Operator messages carry a status code or a fixed sentence, never a
  // credential, a header or a provider response body.
  return error instanceof PublicWorkerActivationOperatorError || error instanceof CloudflareConfigurationError ? error.message : "The read did not complete";
}

/** Makes each provider read of an activation with the publisher's own token,
 * and applies the activation's own assertions for the target: production's
 * upload-only trigger and disabled subdomain, development's absent trigger and
 * private Worker. It writes nothing, so it does not prove the deployment
 * write. Run it before the admission pause, and in scripts/setup-dev.sh. */
export async function checkPublicWorkerActivationAccess({ cloudflareApiToken, requestJson = requestCloudflareJson, target }: {
  cloudflareApiToken: string; requestJson?: RequestJson; target?: PublicationTarget;
}): Promise<ActivationAccessCheck[]> {
  const selected = publicWorkerTarget(target);
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
  await check("worker-identity", async () => { workerTag = assertPublicWorkerIdentity(await get("/workers/scripts"), selected); });
  await check("build-trigger", async () => {
    if (!workerTag) throw new PublicWorkerActivationOperatorError("The Worker identity was not read");
    assertPublicWorkerTriggers(await get(`/builds/workers/${workerTag}/triggers`), workerTag, selected);
  });
  await check("worker-subdomain", async () => {
    if (selected.environment === "development") await assertDevelopmentWorkerPrivate(selected, requestJson, cloudflareApiToken);
    else assertProductionWorkerSubdomainDisabled(await get(`/workers/scripts/${selected.workerName}/subdomain`));
  });
  await check("active-deployment", async () => {
    const active = activeDeployment(await get(`/workers/scripts/${selected.workerName}/deployments`));
    if (!active || typeof active !== "object" || !Object.keys(active).length) {
      throw new PublicWorkerActivationOperatorError("The active deployment was not readable");
    }
  });
  return checks;
}

/** The token arrives on file descriptor 3, as it does for the activation
 * operator. `--target development` checks the development Worker. */
export async function main(args = process.argv.slice(2)): Promise<void> {
  if (!(args.length === 0 || (args.length === 2 && args[0] === "--target" && ["production", "development"].includes(args[1])))) {
    process.stderr.write("Usage: check-public-worker-activation-access [--target production|development]\n");
    process.exitCode = 64;
    return;
  }
  const target = args.length ? publicationTarget(args[1]) : undefined;
  try {
    const checks = await checkPublicWorkerActivationAccess({ cloudflareApiToken: parseCloudflareToken(readFileSync(3, "utf8")), target });
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
