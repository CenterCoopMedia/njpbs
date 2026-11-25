import { copyImportClosure } from "../helpers/isolated-checkout.mjs";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import functionsEnv from "firebase-tools/lib/functions/env.js";

const read = name => readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8");
const suppliers = {
  CMS_API_WORKER: "CMS_DEV_API_WORKER", CMS_PREVIEW_WORKER: "CMS_DEV_PREVIEW_WORKER",
  CMS_PREVIEW_RENDERER: "CMS_DEV_PREVIEW_RENDERER", CMS_PREVIEW_STAFF_WORKER: "CMS_DEV_PREVIEW_STAFF_WORKER",
  CMS_SITE_PAGES: "CMS_DEV_SITE_PAGES", CMS_ADMIN_PAGES: "CMS_DEV_ADMIN_PAGES",
  CMS_MEDIA_BUCKET: "CMS_DEV_MEDIA_BUCKET", CMS_PREVIEW_BUCKET: "CMS_DEV_PREVIEW_BUCKET",
  CMS_ADMIN_ORIGIN: "CMS_DEV_ADMIN_ORIGIN", CMS_API_ORIGIN: "CMS_DEV_API_ORIGIN",
  CMS_PREVIEW_ORIGIN: "CMS_DEV_PREVIEW_ORIGIN", CMS_SITE_ORIGIN: "CMS_DEV_PUBLIC_ORIGIN",
  CMS_MEDIA_ORIGIN: "CMS_DEV_MEDIA_ORIGIN", VITE_FUNCTIONS_BASE_URL: "CMS_DEV_API_ORIGIN",
  VITE_PUBLIC_SITE_ORIGIN: "CMS_DEV_PUBLIC_ORIGIN",
  CLOUDFLARE_DEV_PUBLIC_WORKER: "CLOUDFLARE_DEV_PUBLIC_WORKER",
  CMS_DEV_PUBLIC_ORIGIN: "CMS_DEV_PUBLIC_ORIGIN", CMS_DEV_PREVIEW_BUCKET: "CMS_DEV_PREVIEW_BUCKET",
};

test("enabled Studio preflight refuses invalid presets before credentials or pause-plan output", () => {
  const directory = mkdtempSync(join(tmpdir(), "studio-preflight-"));
  const output = join(directory, "release-plan-output");
  try {
    for (const preset of [undefined, "", "{}", "synthetic-private-canary"]) {
      const result = spawnSync(process.execPath, ["scripts/component-runner.mjs", "functions", "plan"], {
        cwd: new URL("../..", import.meta.url), encoding: "utf8", env: {
          PATH: process.env.PATH, GITHUB_OUTPUT: output,
          DEPLOY_SHA: "a".repeat(40), GITHUB_SHA: "b".repeat(40),
          VITE_LIVE_PRODUCTION_ENABLED: "true",
          ...(preset === undefined ? {} : { VITE_CMS_STUDIO_CONFIGURATION: preset }),
        },
      });
      assert.equal(result.status, 1);
      assert.equal(result.stderr.trim(), "Studio preset configuration is unavailable");
      assert.equal(result.stdout, "");
      assert.equal(existsSync(output), false);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
