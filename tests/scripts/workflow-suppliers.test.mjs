import { readCmsDeployWorkflow } from "../helpers/cms-deploy-workflow.mjs";
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

test("development deployment inputs come from named repository variables without literal fallbacks", () => {
  const seen = new Set();
  for (const name of ["cms-dev-deploy.yml", "cms-dev-publish.yml"]) {
    for (const [, key, expression] of read(name).matchAll(/^\s+([A-Z][A-Z0-9_]+): (.+)$/gm)) {
      if (!Object.hasOwn(suppliers, key)) continue;
      assert.ok(expression.trim() === `\${{ vars.${suppliers[key]} }}`, `${name} supplies ${key} from its configured variable`);
      seen.add(key);
    }
  }
  assert.deepEqual([...seen].sort(), Object.keys(suppliers).sort());
  assert.ok(read("cms-dev-deploy.yml").includes('--project-name="$CMS_ADMIN_PAGES"'));
});

test("the production origin pin refuses missing or wrong configuration at the shell boundary", () => {
  const workflow = readCmsDeployWorkflow();
  assert.ok(workflow.includes('CMS_PRODUCTION_API_ORIGIN: ${{ vars.CMS_PRODUCTION_API_ORIGIN }}'));
  assert.ok(workflow.includes("CMS_TARGET_API_ORIGIN: ${{ inputs.target == 'development' && 'https://dev-cms-api.njpbs.org' || vars.CMS_PRODUCTION_API_ORIGIN }}"));
  const block = workflow.match(/          if \[ "\$VITE_FUNCTIONS_BASE_URL" != "\$\{CMS_TARGET_API_ORIGIN:-\}" \]; then\n[\s\S]*?          fi\n/)?.[0];
  assert.ok(block, "the origin comparison uses the configured independent pin");
  for (const [pin, allowed] of [[undefined, false], ["", false], ["https://wrong.fixture.test", false], ["https://api.fixture.test", true]]) {
    const result = spawnSync("bash", ["-e", "-c", block], { encoding: "utf8", env: {
      PATH: process.env.PATH, VITE_FUNCTIONS_BASE_URL: "https://api.fixture.test",
      ...(pin === undefined ? {} : { CMS_TARGET_API_ORIGIN: pin }),
    } });
    assert.equal(result.status, allowed ? 0 : 1);
    assert.ok(!result.stdout.includes("fixture.test") && !result.stderr.includes("fixture.test"));
  }
});

test("the Studio and Admin builds receive their configured suppliers", () => {
  const workflow = readCmsDeployWorkflow();
  const step = workflow.split('      - name: Build the exact-source Studio connector package\n')[1]?.split('\n      - name:')[0];
  assert.ok(step?.includes('CMS_STUDIO_API_ORIGIN: ${{ vars.CMS_STUDIO_API_ORIGIN }}'));
  assert.ok(step?.includes('node agents/vmix/build-windows.mjs'));
  const admin = workflow.split('      - name: Build admin app\n')[1]?.split('\n      - name:')[0];
  assert.ok(admin?.includes('VITE_CMS_STUDIO_CONFIGURATION: ${{ secrets.VITE_CMS_STUDIO_CONFIGURATION }}'));
  const policy = JSON.parse(readFileSync(new URL('../../.github/deploy-environments.json', import.meta.url), 'utf8'));
  assert.ok(policy.production.secrets.includes('VITE_CMS_STUDIO_CONFIGURATION'));
});

test("the Functions writer and planner derive Studio titles from the same private preset supplier", () => {
  const workflow = parseYaml(readCmsDeployWorkflow());
  const writer = workflow.jobs.firebase.steps.find(step => step.name === "Configure functions runtime params");
  const planner = workflow.jobs["firebase-preflight"].steps.find(step => step.name === "Plan Functions and renderer release");
  const admin = workflow.jobs["admin-build"].steps.find(step => step.name === "Build admin app");
  for (const step of [writer, planner]) {
    assert.equal(step.env.VITE_CMS_STUDIO_CONFIGURATION, "${{ secrets.VITE_CMS_STUDIO_CONFIGURATION }}");
    assert.equal(step.env.VITE_LIVE_PRODUCTION_ENABLED, "${{ vars.LIVE_PRODUCTION_ENABLED || 'false' }}");
    assert.equal(step.env.VITE_LIVE_PRODUCTION_ENABLED, admin.env.VITE_LIVE_PRODUCTION_ENABLED);
  }
  assert.equal(writer.run, "node scripts/component-runner.mjs functions configure");
  const preset = { schemaVersion: 1, vmixHost: "127.0.0.1", vmixPort: 12345,
    apiAccessMode: "loopback-without-login", backgroundInput: 500,
    inputs: { headline: 501, name_title: 502 }, overlayInputs: { headline: 503, name_title: 504 },
    titleFiles: { headline: "Synthetic headline.gtzip", name_title: "Synthetic name.gtzip" } };
  const run = (value, enabled = "true") => spawnSync(process.execPath, ["--input-type=module", "-e", "\nimport {readFileSync} from \"node:fs\";\nimport {studioTitleFilesParameter} from \"./scripts/lib/studio-title-files.mjs\";\nimport {runtimeDotenv} from \"./scripts/lib/functions-configuration.mjs\";\ntry { process.stdout.write(runtimeDotenv({CMS_STUDIO_TITLE_FILES:studioTitleFilesParameter(readFileSync(0,\"utf8\"),process.argv[1])})); }\ncatch { process.stderr.write(\"Studio preset configuration is missing or invalid\\n\"); process.exitCode=1; }\n", enabled], { encoding: "utf8", input: value ?? "",
    cwd: new URL("../..", import.meta.url), env: { PATH: process.env.PATH,
      VITE_LIVE_PRODUCTION_ENABLED: enabled,
      ...(value === undefined ? {} : { VITE_CMS_STUDIO_CONFIGURATION: value }) } });
  for (const titleFiles of [preset.titleFiles,
    { headline: "Synthetic O'Brien #1.gtzip", name_title: "Synthetic 東京.GTZIP" }]) {
    const result = run(JSON.stringify({ ...preset, titleFiles }));
    assert.equal(result.status, 0);
    const parameters = functionsEnv.parseStrict(result.stdout);
    assert.deepEqual(Object.keys(parameters), ["CMS_STUDIO_TITLE_FILES"]);
    assert.deepEqual(JSON.parse(parameters.CMS_STUDIO_TITLE_FILES), titleFiles);
    assert.ok(!result.stdout.includes("vmixPort"));
    assert.equal(result.stderr, "");
  }
  for (const value of [undefined, "", "{}", "synthetic-private-canary", "x".repeat(16385),
    JSON.stringify({ ...preset, titleFiles: { headline: "same.gtzip", name_title: "SAME.gtzip" } })]) {
    const result = run(value);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes("synthetic-private-canary"));
    assert.ok(!result.stderr.includes("CMS_STUDIO_TITLE_FILES="));
    const optional = run(value, "false");
    assert.equal(optional.status, 0);
    assert.deepEqual(functionsEnv.parseStrict(optional.stdout), { CMS_STUDIO_TITLE_FILES: "" });
    assert.equal(optional.stderr, "");
  }
  assert.equal(run(JSON.stringify(preset), "false").stdout, run(JSON.stringify(preset), "true").stdout);
  assert.equal(run(JSON.stringify(preset), "invalid").status, 1);
});

test("the reviewed release supplies both Studio modules after its pinned source gate", async () => {
  const workflow = parseYaml(readCmsDeployWorkflow());
  const steps = workflow.jobs.firebase.steps;
  const gate = steps.find(step => step.name === "Require pinned release and trusted workflow identities");
  const writer = steps.find(step => step.name === "Configure functions runtime params");
  assert.equal(gate.env.CMS_RELEASE_CHECKS_SHA, "${{ inputs.deploy_ref }}");
  assert.equal(gate.env.CMS_TRUSTED_WORKFLOW_SHA, "${{ github.sha }}");
  assert.ok(steps.indexOf(gate) < steps.indexOf(writer));
  assert.ok(!steps.some(step => step.name === "Stage current function deployment helper for scanning"));
  const directory = mkdtempSync(join(tmpdir(), "studio-reviewed-source-"));
  try {
    await copyImportClosure(fileURLToPath(new URL("../../", import.meta.url)), directory,
      ["scripts/lib/studio-title-files.mjs", "scripts/lib/functions-configuration.mjs"],
      { assets: ["config/functions-configuration.json"] });
    assert.equal(writer.run, "node scripts/component-runner.mjs functions configure");
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", "\nimport {readFileSync} from \"node:fs\";\nimport {studioTitleFilesParameter} from \"./scripts/lib/studio-title-files.mjs\";\nimport {runtimeDotenv} from \"./scripts/lib/functions-configuration.mjs\";\ntry { process.stdout.write(runtimeDotenv({CMS_STUDIO_TITLE_FILES:studioTitleFilesParameter(readFileSync(0,\"utf8\"),process.argv[1])})); }\ncatch { process.stderr.write(\"Studio preset configuration is missing or invalid\\n\"); process.exitCode=1; }\n", "false"], { cwd: directory, encoding: "utf8", input: "", env: { PATH: process.env.PATH } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(functionsEnv.parseStrict(result.stdout), { CMS_STUDIO_TITLE_FILES: "" });
    assert.equal(result.stderr, "");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

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
