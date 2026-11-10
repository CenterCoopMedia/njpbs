import { renderDevelopmentConfig } from "./render-development-config.mjs";
import { cloudflareAccount, cloudflarePublicWorkerTag } from "../site/scripts/cloudflare-account.mjs";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));

/** A shallow Git fetch copies only committed files. Ignored credentials, local
 * dependencies and other worktrees can never enter the Docker build context.
 */
export async function prepareCloudPublisher(commitSha, { sourceRepository = repository, environment: targetEnvironment = "production" } = {}) {
  if (!["production", "development"].includes(targetEnvironment)) throw new Error("Invalid publisher environment");
  if (!/^[a-f0-9]{40}$/.test(commitSha ?? ""))
    throw new Error("An exact publisher commit is required");
  if (!path.isAbsolute(sourceRepository)) throw new Error("An absolute publisher source repository is required");
  // Image-only preparation also runs without deployment settings. Keep its
  // binding unconfigured; supplied deployment accounts must still validate.
  const account = process.env.CLOUDFLARE_ACCOUNT_ID ? cloudflareAccount() : undefined;
  const workerTag = process.env.CLOUDFLARE_PUBLIC_WORKER_TAG ? cloudflarePublicWorkerTag() : "";
  const uploadOrigin = process.env.PUBLIC_SHARE_UPLOAD_ORIGIN ?? "";
  if (uploadOrigin) {
    let parsed;
    try { parsed = new URL(uploadOrigin); } catch { /* Refuse below. */ }
    if (!parsed || parsed.protocol !== "https:" || parsed.origin !== uploadOrigin) {
      throw new Error("PUBLIC_SHARE_UPLOAD_ORIGIN must be an exact HTTPS origin");
    }
  }
  const directory = await mkdtemp(
    path.join(tmpdir(), "njpbs-publisher-build-"),
  );
  const source = path.join(directory, "source");
  const environment = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CI: "true",
    WRANGLER_SEND_METRICS: "false",
  };
  const git = (...args) =>
    execFileSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", ...args], {
      env: environment,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024,
    });
  git("init", "--quiet", source);
  git("-C", source, "fetch", "--quiet", "--depth=1", sourceRepository, commitSha);
  git("-C", source, "checkout", "--quiet", "--detach", "FETCH_HEAD");
  if (
    git("-C", source, "rev-parse", "HEAD").trim() !== commitSha ||
    git("-C", source, "status", "--porcelain") !== ""
  ) {
    throw new Error("Prepared publisher source differs from its commit");
  }
  renderDevelopmentConfig(source, process.env, targetEnvironment === "development" ? undefined : { only: ["CMS_PRODUCTION_API_ORIGIN"] });
  const publisherDirectory = path.join(source, "publisher");
  execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: publisherDirectory,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024,
  });
  await writeFile(
    path.join(directory, ".dockerignore"),
    "*\n!source/\n!source/**\nsource/**/node_modules\nsource/**/.wrangler\n",
  );
  const config = JSON.parse(
    await readFile(path.join(publisherDirectory, "wrangler.json"), "utf8"),
  );
  if (account !== undefined) {
    config.account_id = account;
    config.vars.CLOUDFLARE_ACCOUNT_ID = account;
  }
  config.vars.CLOUDFLARE_PUBLIC_WORKER_TAG = workerTag;
  config.vars.PUBLIC_SHARE_UPLOAD_ORIGIN = uploadOrigin;
  config.main = path.join(publisherDirectory, "worker.ts");
  config.vars.PUBLICATION_COMMIT_SHA = commitSha;
  config.containers[0].image = path.join(publisherDirectory, "Dockerfile");
  config.containers[0].image_build_context = directory;
  const configPath = path.join(directory, "wrangler.json");
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return {
    commitSha,
    directory,
    source,
    configPath,
    wrangler: path.join(
      publisherDirectory,
      "node_modules/wrangler/bin/wrangler.js",
    ),
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length !== 3)
    throw new Error("Usage: prepare-cloud-publisher <exact commit>");
  cloudflarePublicWorkerTag();
  console.log(JSON.stringify(await prepareCloudPublisher(process.argv[2])));
}
