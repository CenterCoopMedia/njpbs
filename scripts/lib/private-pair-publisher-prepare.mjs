import { assertDevelopmentSource } from "../render-development-config.mjs";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import rollout from "../../functions/lib/public-release-pair-rollout.js";
import { configurePublicReleasePairPublisher } from "../configure-public-release-pair-publisher.mjs";
import { preparePrivatePairPublisher, PrivatePairProviderError } from "./private-pair-publisher-provider.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

function assertCheckout(commitSha) {
  const options = { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } };
  try {
    const args = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
    const head = execFileSync("git", [...args, "rev-parse", "HEAD"], options).trim();
    const status = assertDevelopmentSource(options.cwd) ? "" : "dirty";
    if (head !== commitSha || status) throw new Error("Source differs");
  } catch { throw new PrivatePairProviderError("source-check-failed"); }
}

/** Only the pinned offline bundler runs. No inherited credential, user config,
 * build override or working provider endpoint enters that child process.
 */
export async function preparePrivatePairPublisherInstall({ pairTemplate, retainedPairs, legacyConfig, imageReference, executorReady = false,
  continuationEnabled = false, ingressProofService, slotInstall }) {
  if (typeof executorReady !== "boolean") throw new PrivatePairProviderError("invalid-executor-ready-mode");
  const schemaVersion = slotInstall === undefined ? 2 : 3;
  const pair = rollout.publicReleasePairUploadCandidate({ pairTemplate, schemaVersion });
  assertCheckout(pair.commitSha);
  const config = configurePublicReleasePairPublisher({ pair, retainedPairs, legacyConfig, imageReference, executorReady,
    continuationEnabled, ingressProofService });
  if (config.vars.PAIR_EXECUTOR_READY !== String(executorReady)) throw new PrivatePairProviderError("executor-ready-mode-unavailable");
  const scratch = await mkdtemp(join(tmpdir(), "private-pair-bundle-"));
  try {
    const configPath = join(scratch, "worker.json");
    const multipartPath = join(scratch, "worker.multipart");
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600, flag: "wx" });
    const wrangler = join(root, "node_modules/wrangler/bin/wrangler.js");
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [wrangler, "versions", "upload", "--config", configPath,
        "--dry-run", "--outdir", join(scratch, "modules"), "--outfile", multipartPath], {
        cwd: scratch,
        env: { PATH: process.env.PATH, HOME: scratch, XDG_CONFIG_HOME: scratch,
          WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(scratch, "wrangler.log"),
          CLOUDFLARE_API_BASE_URL: "http://127.0.0.1:9/client/v4", CI: "true" },
        stdio: "ignore",
      });
      child.once("error", () => reject(new Error("Offline publisher preparation failed")));
      child.once("exit", code => code === 0 ? resolve() : reject(new Error("Offline publisher preparation failed")));
    });
    const multipart = await readFile(multipartPath);
    assertCheckout(pair.commitSha);
    const prepared = await preparePrivatePairPublisher({ multipart, config, imageReference });
    const plan = rollout.parsePublicReleasePairUploadPlan({ schemaVersion, kind: "private-pair-publisher-upload",
      pairTemplate, accountId: config.account_id, imageReference,
      bundleDigest: prepared.bundleDigest, configurationDigest: prepared.configurationDigest, ...slotInstall === undefined ? {} : { slotInstall } });
    return { plan, prepared };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
