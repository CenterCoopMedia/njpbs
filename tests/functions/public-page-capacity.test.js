import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("lets the public Page reader scale to zero in production and development", () => {
  const capacities = Object.fromEntries(["production", "development"].map(environment => {
    // Separate processes exercise deployment-time options without a CommonJS cache.
    const result = spawnSync(process.execPath, ["-e", `
      const { cmsGetPublicPage } = require("./functions/public-content.js");
      process.stdout.write(JSON.stringify(cmsGetPublicPage.__endpoint.minInstances));
    `], {
      cwd: new URL("../../", import.meta.url),
      env: { ...process.env, CMS_DEPLOYMENT_ENVIRONMENT: environment,
        GCLOUD_PROJECT: environment === "production" ? "njpbs-site" : "njpbs-site-dev",
        FUNCTIONS_EMULATOR: "false" },
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(result.status, result.stderr).toBe(0);
    return [environment, JSON.parse(result.stdout)];
  }));
  expect(capacities).toEqual({ production: 0, development: 0 });
});
