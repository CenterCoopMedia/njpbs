import { assertDevelopmentSource } from "../../scripts/render-development-config.mjs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadHomeSourceSnapshot } from "../src/lib/home-sources-loader";
import { buildPreviewRuntime } from "./build-preview-runtime.mjs";
import { sealCompiledRenderer } from "./compiled-renderer-release.mjs";

const site = fileURLToPath(new URL("..", import.meta.url));
const repository = path.dirname(site);
const git = (...args: string[]) => execFileSync("/usr/bin/git", [
  "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args,
], {
  cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
}).trim();
const rendererSha = git("rev-parse", "HEAD");
if (!/^[a-f0-9]{40}$/.test(rendererSha) || !assertDevelopmentSource(repository)) {
  throw new Error("Compile the renderer only from an exact clean source checkout");
}
execFileSync(process.execPath, [path.join(site, "node_modules/astro/bin/astro.mjs"),
  "build", "--config", "astro.renderer.config.mjs"], {
  cwd: site,
  env: { PATH: "/usr/local/bin:/usr/bin:/bin", NODE_ENV: "production",
    ASTRO_TELEMETRY_DISABLED: "1", TZ: "America/New_York", CMS_COMPILED_RENDERER_SHA: rendererSha },
  stdio: "inherit",
});
await buildPreviewRuntime(repository);
const homeSources = await loadHomeSourceSnapshot({});
if (git("rev-parse", "HEAD") !== rendererSha || !assertDevelopmentSource(repository)) {
  throw new Error("Renderer source changed during compilation");
}
await sealCompiledRenderer(path.join(site, ".compiled-renderer"), rendererSha, homeSources);
console.log(JSON.stringify({ event: "compiled-renderer-ready", rendererSha }));
