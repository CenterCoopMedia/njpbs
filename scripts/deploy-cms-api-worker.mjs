import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { wranglerVersion } from "./lib/cloudflare-worker-readback.mjs";
import { assertDevelopmentWorkerConfig, cmsTarget } from "./lib/cms-target.mjs";

class CmsApiDeployError extends Error {}

export function deployCmsApiWorker(secretsFile, spawn = spawnSync, { cwd = "cms-api", devSourceSha } = {}) {
  const args = ["deploy", "--cwd", cwd];
  if (devSourceSha) args.push("--config", "wrangler.dev.jsonc", "--tag", devSourceSha);
  if (secretsFile && existsSync(secretsFile)) args.push("--secrets-file", secretsFile);
  const result = spawn(fileURLToPath(new URL("../node_modules/.bin/wrangler", import.meta.url)), args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false" },
  });
  if (result.status !== 0) throw new CmsApiDeployError("CMS API Wrangler deploy did not report success");
  const version = wranglerVersion(result.stdout);
  if (!version) throw new CmsApiDeployError("CMS API Wrangler deploy did not report a valid versionId");
  return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const target = cmsTarget();
    let devSourceSha;
    if (target.environment === "development") {
      devSourceSha = process.env.DEPLOY_SHA;
      if (!/^[a-f0-9]{40}$/.test(devSourceSha ?? "")) throw new CmsApiDeployError("DEPLOY_SHA is required for a development deploy");
      assertDevelopmentWorkerConfig(JSON.parse(readFileSync("cms-api/wrangler.dev.jsonc", "utf8")),
        { name: target.cmsApiWorker, hostnames: [new URL(target.apiOrigin).hostname] });
    }
    process.stdout.write(`${deployCmsApiWorker(process.argv[2], spawnSync, { devSourceSha })}\n`);
  } catch (error) {
    // Wrangler errors can contain configuration values.
    process.stderr.write(error instanceof CmsApiDeployError || error?.name === "CmsTargetError" ? `${error.message}\n` : "CMS API deploy could not be confirmed\n");
    process.exitCode = 1;
  }
}
