import { previewRendererBindings } from "./lib/deployment-settings.mjs";
import { developmentValues, readDeploymentManifest, renderDevelopmentConfig } from "./render-development-config.mjs";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));

/** A shallow Git fetch copies only committed files. Ignored credentials, local
 * dependencies and other worktrees can never enter the Docker build context.
 */
export async function preparePreviewRenderer(rendererSha, options) {
  return prepareRenderer(rendererSha, "wrangler.jsonc", options);
}

export async function prepareDevPreviewRenderer(rendererSha, options) {
  return prepareRenderer(rendererSha, "wrangler.dev.jsonc", options);
}

async function prepareRenderer(rendererSha, configName, { sourceRepository = repository } = {}) {
  if (!path.isAbsolute(sourceRepository)) throw new Error("An absolute renderer source repository is required");
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const runtimeBindings = previewRendererBindings(configName === "wrangler.dev.jsonc" ? "development" : "production", account);
  const development = configName === "wrangler.dev.jsonc";
  if (!/^[a-f0-9]{40}$/.test(rendererSha ?? "")) throw new Error("An exact renderer commit is required");
  const directory = await mkdtemp(path.join(tmpdir(), "njpbs-preview-renderer-build-"));
  const source = path.join(directory, "source");
  const environment = { PATH: process.env.PATH, HOME: process.env.HOME, CI: "true", WRANGLER_SEND_METRICS: "false" };
  const git = (...args) => execFileSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", ...args], {
    env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024,
  });
  git("init", "--quiet", source);
  git("-C", source, "fetch", "--quiet", "--depth=1", sourceRepository, rendererSha);
  git("-C", source, "checkout", "--quiet", "--detach", "FETCH_HEAD");
  if (git("-C", source, "rev-parse", "HEAD").trim() !== rendererSha || git("-C", source, "status", "--porcelain") !== "") {
    throw new Error("Prepared renderer source differs from its commit");
  }
  // Verify the exact retained source first, then resolve its build inputs. The
  // image receives the same configured pins as the calling deployment tools.
  renderDevelopmentConfig(source, process.env, development ? undefined : { only: ["CMS_PRODUCTION_API_ORIGIN"] });
  const manifest = readDeploymentManifest(source);
  const targets = development && manifest ? developmentValues(process.env, { manifest }) : null;
  const rendererDirectory = path.join(source, "preview-renderer");
  execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: rendererDirectory, env: environment, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024,
  });
  await writeFile(path.join(directory, ".dockerignore"), "*\n!source/\n!source/**\nsource/**/node_modules\nsource/**/.wrangler\n");
  const config = JSON.parse(await readFile(path.join(rendererDirectory, configName), "utf8"));
  // A verified pre-template commit owns its legacy name; templated sources use their named supplier.
  const expectedRenderer = targets?.CMS_DEV_PREVIEW_RENDERER ?? config.name;
  if (configName === "wrangler.dev.jsonc" && (config.name !== expectedRenderer ||
      (config.account_id !== undefined && config.account_id !== account) ||
      config.vars?.CMS_DEPLOYMENT_ENVIRONMENT !== "development" ||
      config.vars?.FIREBASE_PROJECT_ID !== "njpbs-site-dev" ||
      config.vars?.PREVIEW_RENDERER_ENABLED !== "false" || config.vars?.PREVIEW_RENDERER_SHA !== "" ||
      config.vars?.PREVIEW_SERIALIZER_ID !== "cloudflare-preview" ||
      config.containers?.[0]?.name !== expectedRenderer ||
      config.containers.length !== 1 || config.workers_dev !== false || config.preview_urls !== false ||
      config.routes !== undefined || config.route !== undefined)) {
    throw new Error("Prepared dev renderer config differs from its isolated target");
  }
  config.account_id = account;
  Object.assign(config.vars, runtimeBindings);
  config.main = path.join(rendererDirectory, "worker.ts");
  config.vars.PREVIEW_RENDERER_SHA = rendererSha;
  config.containers[0].image = path.join(rendererDirectory, "Dockerfile");
  config.containers[0].image_build_context = directory;
  const configPath = path.join(directory, "wrangler.jsonc");
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { rendererSha, directory, source, configPath,
    wrangler: path.join(rendererDirectory, "node_modules/wrangler/bin/wrangler.js") };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("Usage: prepare-preview-renderer <exact commit>");
  console.log(JSON.stringify(await preparePreviewRenderer(process.argv[2])));
}
