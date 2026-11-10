import { assertDevelopmentSource } from "../../scripts/render-development-config.mjs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const site = fileURLToPath(new URL("..", import.meta.url));
const repo = path.dirname(site);
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const fixtures = process.argv.includes("--fixtures");
const sha = git("rev-parse", "HEAD");
if (!fixtures && !assertDevelopmentSource(repo)) throw new Error("Compile shadow templates from an exact clean source");
execFileSync(process.execPath, [path.join(site, "node_modules/astro/bin/astro.mjs"), "build", "--config", fixtures ? "astro.shadow-fixtures.config.mjs" : "astro.shadow.config.mjs"], {
  cwd: site,
  env: { PATH: "/usr/local/bin:/usr/bin:/bin", NODE_ENV: "production", ASTRO_TELEMETRY_DISABLED: "1",
    TZ: "America/New_York", CMS_COMPILED_RENDERER_SHA: sha },
  stdio: "inherit",
});
if (!fixtures && (git("rev-parse", "HEAD") !== sha || !assertDevelopmentSource(repo))) throw new Error("Shadow source changed during compilation");
