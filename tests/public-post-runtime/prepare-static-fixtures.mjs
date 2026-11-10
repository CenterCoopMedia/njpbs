import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { publicPostRenderEnvironment } from "../../site/scripts/public-post-render-environment";

const site = fileURLToPath(new URL("../../site/", import.meta.url));
// The independent full-build PostRoute oracle uses the same public settings
// as the compiler. The older shadow fixture builder also includes editor hints.
// CI gives these public fixture settings to the compiler step only.
const fixtureEnvironment = {
  PUBLIC_GA4_MEASUREMENT_ID: "G-TEST123",
  PUBLIC_REPORT_ENDPOINT: "https://report.example.test/",
  PUBLIC_TURNSTILE_SITEKEY: "public-test-sitekey",
  PUBLIC_SHARE_INTAKE_ENDPOINT: "https://intake.example.test/",
  ...process.env,
};
execFileSync(process.execPath, [fileURLToPath(new URL("../../site/node_modules/astro/bin/astro.mjs", import.meta.url)),
  "build", "--config", "astro.shadow-fixtures.config.mjs"], {
  cwd: site,
  env: { PATH: "/usr/local/bin:/usr/bin:/bin", ...publicPostRenderEnvironment(fixtureEnvironment),
    ASTRO_TELEMETRY_DISABLED: "1", TZ: "America/New_York" },
  stdio: "inherit",
});
