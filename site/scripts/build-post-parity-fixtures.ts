import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const site = fileURLToPath(new URL("..", import.meta.url));
const repo = path.dirname(site);
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const env = { PATH: "/usr/local/bin:/usr/bin:/bin", NODE_ENV: "production", ASTRO_TELEMETRY_DISABLED: "1",
  TZ: "America/New_York", CMS_COMPILED_RENDERER_SHA: git("rev-parse", "HEAD") };
for (const config of ["astro.post-parity.config.mjs", "astro.shadow-fixtures.config.mjs"]) {
  execFileSync(process.execPath, [path.join(site, "node_modules/astro/bin/astro.mjs"), "build", "--config", config], {
    cwd: site, env, stdio: "inherit",
  });
}
