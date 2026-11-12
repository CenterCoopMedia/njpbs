import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, cpSync, rmSync, symlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import { developmentInputs, developmentValues, renderDevelopmentText, renderDevelopmentConfig,
  assertDevelopmentSource, restoreDevelopmentTemplates, renderCommittedDeploymentSource,
  deploymentInputFingerprint, developmentDerivations } from "../../scripts/render-development-config.mjs";
import { developmentInputFixture as inputs } from "../helpers/development-inputs.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const script = join(root, "scripts/render-development-config.mjs");
const files = [...new Set([...Object.values(developmentInputs).flatMap(input => input.files), ...developmentDerivations.flatMap(item => item.consumers)])];
const git = (cwd, ...args) => execFileSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), "development-render-"));
  try {
    for (const name of [...files, ".gitignore", "config/development-inputs.json", "scripts/render-development-config.mjs", "site/scripts/cms-publication-runtime-guard.ts", "site/package.json"]) {
      mkdirSync(dirname(join(directory, name)), { recursive: true });
      copyFileSync(join(root, name), join(directory, name));
    }
    git(directory, "init", "-q"); git(directory, "add", ".");
    git(directory, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.org", "commit", "-qm", "Templates");
    return run(directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("validates every named supplier before rendering, with value-free diagnostics", () => {
  assert.deepEqual(developmentValues(inputs), inputs);
  for (const name of Object.keys(inputs)) {
    for (const value of [undefined, "", developmentInputs[name].placeholder, "unsafe\"\n$input", "https://operator:canary@fixture.test"]) {
      assert.throws(() => developmentValues({ ...inputs, [name]: value }), error => {
        assert.doesNotMatch(error.message, /unsafe|canary/); return true;
      });
    }
  }
  assert.throws(() => developmentValues({ ...inputs, CMS_DEV_API_ORIGIN: inputs.CMS_PRODUCTION_API_ORIGIN }));
  assert.throws(() => developmentValues({ ...inputs, CMS_DEV_API_WORKER: inputs.CLOUDFLARE_DEV_PUBLIC_WORKER }));
});

test("deploy and publish map identical repository variables and render before target-dependent commands", () => {
  for (const filename of ["cms-dev-deploy.yml", "cms-dev-publish.yml"]) {
    const workflow = parse(readFileSync(join(root, ".github/workflows", filename), "utf8"));
    const supplied = {};
    for (const name of Object.keys(inputs)) {
      assert.equal(workflow.env[name], "${{ vars." + name + " }}"); supplied[name] = inputs[name];
    }
    assert.deepEqual(developmentValues(supplied), inputs);
    for (const job of Object.values(workflow.jobs)) {
      const steps = job.steps ?? [], render = steps.findIndex(step => step.run?.includes("render-development-config.mjs"));
      assert.ok(render >= 0, `${filename} job lacks render`);
      // Recovery provenance admission does not read deployment target pins.
      const target = steps.findIndex(step => /assert-dev-cms-targets|cms-dev-publication/.test(step.run ?? ""));
      if (target >= 0) assert.ok(render < target);
      const selectedSource = steps.findIndex(step => step.id === "source");
      if (selectedSource >= 0) assert.ok(steps.slice(selectedSource + 1).some(step => step.run?.includes("render-development-config.mjs")));
    }
  }
});

test("dry renders every runtime/config consumer, preserving target comparisons and binding structure", () => fixture(directory => {
  const before = new Map(files.map(name => [name, readFileSync(join(directory, name), "utf8")]));
  assert.equal(assertDevelopmentSource(directory, {}), true);
  assert.equal(renderDevelopmentConfig(directory, inputs), files.length);
  for (const [name, input] of Object.entries(developmentInputs)) {
    for (const filename of input.files) {
      const source = readFileSync(join(directory, filename), "utf8");
      const expected = input.kind === "origin" ? new URL(inputs[name]).hostname : inputs[name];
      assert.ok(source.includes(expected) || source.includes(expected.replaceAll(".", "\\.")), filename);
      const marker = input.kind === "origin" ? new URL(input.placeholder).hostname : input.placeholder;
      assert.ok(!source.includes(marker), filename);
    }
  }
  const api = JSON.parse(readFileSync(join(directory, "cms-api/wrangler.dev.jsonc"), "utf8"));
  assert.equal(api.name, inputs.CMS_DEV_API_WORKER);
  assert.equal(api.services[0].binding, "PREVIEW_RENDERER");
  assert.equal(api.services[0].service, inputs.CMS_DEV_PREVIEW_RENDERER);
  assert.equal(api.vars.FIREBASE_PROJECT_ID, "njpbs-site-dev");
  assert.equal(api.vars.ADMIN_ORIGIN, inputs.CMS_DEV_ADMIN_ORIGIN);
  assert.equal(api.routes[0].pattern, new URL(inputs.CMS_DEV_API_ORIGIN).hostname);
  const published = JSON.parse(readFileSync(join(directory, "workers/wrangler.public.dev.jsonc"), "utf8"));
  assert.equal(published.name, inputs.CLOUDFLARE_DEV_PUBLIC_WORKER);
  assert.equal(published.services[0].binding, "CMS_API");
  assert.equal(published.services[0].service, api.name);
  assert.equal(published.workers_dev, false); assert.equal(published.preview_urls, false);
  assert.deepEqual(published.routes, []);
  const pins = readFileSync(join(directory, "scripts/assert-dev-cms-targets.mjs"), "utf8");
  assert.ok(pins.includes(`CMS_API_WORKER: "${api.name}"`));
  assert.ok(pins.includes(`CMS_SITE_ORIGIN: "${inputs.CMS_DEV_PUBLIC_ORIGIN}"`));
  assert.ok(pins.includes("actual[key] !== expected"));
  const inline = readFileSync(join(directory, "packages/content-core/src/boardwalk-edit-script.ts"), "utf8")
    .match(/BOARDWALK_EDIT_SCRIPT = `([\s\S]*?)`;/)[1];
  const hash = "sha256-" + createHash("sha256").update(inline).digest("base64");
  assert.ok(readFileSync(join(directory, "site/public/_headers"), "utf8").includes(hash));
  assert.ok(readFileSync(join(directory, "tests/public-worker.test.ts"), "utf8").includes(hash));
  assert.equal(assertDevelopmentSource(directory, inputs), true);
  assert.equal(assertDevelopmentSource(directory, {}), true); // the isolated container build receives the pinned receipt
  assert.equal(renderDevelopmentConfig(directory, inputs), files.length); // retained-source retries are deterministic
  restoreDevelopmentTemplates(directory, inputs);
  assert.equal(git(directory, "status", "--porcelain"), "");
  for (const [filename, source] of before) assert.equal(readFileSync(join(directory, filename), "utf8"), source);
}));

test("keeps worker output hosts outside development render inputs", () => {
  const render = environment => fixture(directory => {
    renderDevelopmentConfig(directory, environment);
    return new Map(files.map(name => [name, readFileSync(join(directory, name), "utf8")]));
  });
  assert.deepEqual(render({ ...inputs, BOARDWALK_OUTPUT_HOST: "objects.worker.test" }), render(inputs));
});

test("uses the selected source manifest and explicitly preserves older untemplated sources", () => {
  const directory = mkdtempSync(join(tmpdir(), "retained-manifest-"));
  try {
    writeFileSync(join(directory, "entry.mjs"), 'export const origin = "https://older.example.org";\n');
    git(directory, "init", "-q"); git(directory, "add", ".");
    git(directory, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.org", "commit", "-qm", "Legacy source");
    const legacy = git(directory, "rev-parse", "HEAD").trim();
    assert.equal(renderDevelopmentConfig(directory, {}), 0);
    mkdirSync(join(directory, "config"));
    writeFileSync(join(directory, "config/development-inputs.json"), JSON.stringify({ schemaVersion: 1, inputs: {
      CMS_DEV_PUBLIC_ORIGIN: { kind: "origin", placeholder: "https://older.example.org", files: ["entry.mjs"] },
    } }));
    git(directory, "add", ".");
    git(directory, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.org", "commit", "-qm", "Older manifest schema");
    assert.equal(renderDevelopmentConfig(directory, { CMS_DEV_PUBLIC_ORIGIN: inputs.CMS_DEV_PUBLIC_ORIGIN }), 1);
    assert.ok(readFileSync(join(directory, "entry.mjs"), "utf8").includes(inputs.CMS_DEV_PUBLIC_ORIGIN));
    assert.equal(assertDevelopmentSource(directory, {}), true); // receipt works before its ignore rule existed
    restoreDevelopmentTemplates(directory, {});
    git(directory, "checkout", "--detach", legacy);
    assert.equal(renderDevelopmentConfig(directory, {}), 0);
    assert.ok(readFileSync(join(directory, "entry.mjs"), "utf8").includes("older.example.org"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("production workflow isolates trusted gates and keeps disabled preview a no-op", () => {
  const workflow = parse(readFileSync(join(root, ".github/workflows/cms-staging-deploy.yml"), "utf8"));
  for (const job of Object.values(workflow.jobs)) {
    const steps = job.steps ?? [], render = steps.findIndex(step => step.name === "Render deployment resource configuration");
    if (render < 0) continue;
    for (const [index, step] of steps.entries()) {
      const path = step.with?.path;
      if (!step.uses?.startsWith("actions/checkout") || !path?.endsWith("-gate")) continue;
      assert.ok(steps.slice(index + 1, Math.max(render, index + 1) + 1).some(next => next.run?.includes(`mv ${path} `)), path);
    }
    const copy = steps.findIndex(step => step.name?.startsWith("Stage current"));
    if (copy >= 0) assert.ok(render < copy);
  }
  const preview = workflow.jobs["preview-renderer"].steps;
  const condition = preview.find(step => step.uses?.startsWith("actions/checkout") && !step.with?.path).if;
  for (const step of preview.filter(step => /configuration renderer|Render deployment resource/.test(step.name ?? ""))) {
    assert.equal(step.if, condition);
  }
});

test("runs the actual production render block after real gate moves without credentials", () => fixture(directory => {
  const runtime = mkdtempSync(join(tmpdir(), "production-render-gates-"));
  try {
    const workflow = parse(readFileSync(join(root, ".github/workflows/cms-staging-deploy.yml"), "utf8"));
    const steps = workflow.jobs["admin-build"].steps;
    const env = { PATH: process.env.PATH, RUNNER_TEMP: runtime, GITHUB_WORKSPACE: directory,
      CMS_PRODUCTION_API_ORIGIN: inputs.CMS_PRODUCTION_API_ORIGIN };
    for (const step of steps) {
      if (step.uses?.startsWith("actions/checkout") && step.with?.path) {
        const gate = join(directory, step.with.path);
        mkdirSync(gate);
        if (step.name === "Check out trusted configuration renderer") {
          for (const name of ["scripts/render-development-config.mjs", "config/development-inputs.json"]) {
            mkdirSync(dirname(join(gate, name)), { recursive: true }); copyFileSync(join(root, name), join(gate, name));
          }
        }
      }
      if (step.name?.startsWith("Isolate trusted") || step.name === "Render deployment resource configuration") {
        const result = spawnSync("bash", ["-c", step.run], { cwd: directory, env, encoding: "utf8", timeout: 5000 });
        assert.equal(result.status, 0, result.stderr);
      }
      if (step.name === "Render deployment resource configuration") break;
    }
    assert.equal(assertDevelopmentSource(directory, env), true);
  } finally { rmSync(runtime, { recursive: true, force: true }); }
}));

test("source proof refuses tampered, staged, unrelated, untracked and symlink changes", () => fixture(directory => {
  renderDevelopmentConfig(directory, inputs);
  const filename = files[0], path = join(directory, filename), rendered = readFileSync(path, "utf8");
  writeFileSync(path, rendered + "\n// unrelated edit\n");
  assert.throws(() => assertDevelopmentSource(directory, inputs));
  assert.throws(() => restoreDevelopmentTemplates(directory, inputs));
  writeFileSync(path, rendered); git(directory, "add", filename);
  assert.throws(() => assertDevelopmentSource(directory, inputs));
  git(directory, "reset", "-q", "HEAD", "--", filename);
  writeFileSync(join(directory, "untracked.txt"), "untracked");
  assert.throws(() => assertDevelopmentSource(directory, inputs));
  rmSync(join(directory, "untracked.txt"));
  const manifest = join(directory, "config/development-inputs.json"), original = readFileSync(manifest, "utf8");
  writeFileSync(manifest, original + "\n"); assert.throws(() => assertDevelopmentSource(directory, inputs)); writeFileSync(manifest, original);
  rmSync(path); symlinkSync(join(root, filename), path);
  assert.throws(() => assertDevelopmentSource(directory, inputs));
}));

test("production resolves its API input without requiring development resource settings", () => fixture(directory => {
  const env = { CMS_PRODUCTION_API_ORIGIN: inputs.CMS_PRODUCTION_API_ORIGIN };
  const only = ["CMS_PRODUCTION_API_ORIGIN"];
  assert.equal(renderDevelopmentConfig(directory, env, { only }), developmentInputs.CMS_PRODUCTION_API_ORIGIN.files.length);
  assert.equal(assertDevelopmentSource(directory, env), true);
  const api = JSON.parse(readFileSync(join(directory, "cms-api/wrangler.dev.jsonc"), "utf8"));
  assert.equal(api.name, developmentInputs.CMS_DEV_API_WORKER.placeholder);
  assert.throws(() => renderDevelopmentConfig(directory, {}));
  restoreDevelopmentTemplates(directory, env);
  assert.equal(git(directory, "status", "--porcelain"), "");
}));

test("CLI refuses malformed suppliers without writing files or exposing their values", () => fixture(directory => {
  const before = git(directory, "status", "--porcelain");
  const result = spawnSync(process.execPath, [script, "--root", directory], {
    env: { PATH: process.env.PATH, ...inputs, CMS_DEV_API_ORIGIN: "https://user:credential-canary@fixture.test" }, encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.status, 1); assert.doesNotMatch(result.stdout + result.stderr, /credential-canary|user:/);
  assert.equal(git(directory, "status", "--porcelain"), before);
}));

test("origin rendering preserves escaped regular expressions and resource suffixes", () => {
  const source = 'https://dev-public.example.org/a dev-public\\.example\\.org template-dev-public-suffix';
  assert.equal(renderDevelopmentText(source, ["CMS_DEV_PUBLIC_ORIGIN", "CLOUDFLARE_DEV_PUBLIC_WORKER"], inputs),
    'https://dev-public.fixture.test/a dev-public\\.fixture\\.test fixture-dev-public-suffix');
});

test("receipt inputs bind relevant suppliers and readback uses the rendered committed bytes", () => {
  const source = readFileSync(join(root, "functions/lib/publication-target.js"), "utf8");
  const rendered = renderCommittedDeploymentSource("functions/lib/publication-target.js", source, inputs);
  assert.ok(rendered.includes(inputs.CMS_DEV_PUBLIC_ORIGIN));
  assert.ok(rendered.includes(inputs.CLOUDFLARE_DEV_PUBLIC_WORKER));
  const original = deploymentInputFingerprint(["functions"], inputs);
  assert.match(original, /^[a-f0-9]{64}$/);
  assert.notEqual(deploymentInputFingerprint(["functions"], { ...inputs, CMS_DEV_PUBLIC_ORIGIN: "https://changed.fixture.test" }), original);
  assert.equal(deploymentInputFingerprint(["functions"], { ...inputs, CMS_DEV_SITE_PAGES: "another-fixture-site" }), original);
  assert.equal(deploymentInputFingerprint(["functions"], {}), "");
});

test("runs the documented Bash dry-render block in a disposable worktree", () => {
  const doc = readFileSync(join(root, "docs/config/development-rendering.md"), "utf8");
  const block = doc.match(/```bash\n([\s\S]*?)```/)[1];
  const result = spawnSync("bash", ["-c", block], { cwd: root, encoding: "utf8",
    env: { PATH: process.env.PATH, ...inputs }, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Development configuration rendered: \d+ files/);
});

for (const job of ["firebase-preflight", "live-smoke"]) {
test(`trusted gates resolve workspace dependencies from a separate temporary directory (${job})`, () => fixture(directory => {
  const runtime = mkdtempSync(join(tmpdir(), "external-trusted-gate-"));
  try {
    const gate = join(directory, ".cms-smoke-gate"); mkdirSync(gate);
    for (const name of ["scripts", "config", "agents/vmix", ".github/scripts"]) {
      cpSync(join(root, name), join(gate, name), { recursive: true });
    }
    symlinkSync(join(root, "node_modules"), join(directory, "node_modules"));
    const workflow = parse(readFileSync(join(root, ".github/workflows/cms-staging-deploy.yml"), "utf8"));
    const step = workflow.jobs[job].steps.find(step => step.name === "Isolate trusted cms-smoke-gate checkout");
    const moved = spawnSync("bash", ["-c", step.run], { cwd: directory,
      env: { PATH: process.env.PATH, RUNNER_TEMP: runtime, GITHUB_WORKSPACE: directory }, encoding: "utf8" });
    assert.equal(moved.status, 0, moved.stderr);
    const imported = spawnSync(process.execPath, ["--input-type=module", "-e",
      `await import(${JSON.stringify(pathToFileURL(join(runtime, "cms-smoke-gate/scripts/cms-component-receipt.mjs")).href)});
       const {createRequire} = await import('node:module');
       createRequire(${JSON.stringify(join(runtime, "cms-smoke-gate/.github/scripts/ensure-panel-browser-deps.mjs"))})('playwright');`],
      { cwd: directory, env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 5000 });
    assert.equal(imported.status, 0, imported.stderr);
  } finally { rmSync(runtime, { recursive: true, force: true }); }
}));
}

for (const job of ["firebase-preflight", "live-smoke"]) {
test(`proof installs preserve the candidate dependency graph (${job})`, () => {
  const directory = mkdtempSync(join(tmpdir(), "proof-install-boundary-"));
  const runtime = mkdtempSync(join(tmpdir(), "proof-install-runtime-"));
  try {
    const candidateModules = join(directory, "node_modules"); mkdirSync(candidateModules);
    writeFileSync(join(candidateModules, "candidate-marker"), "candidate dependency graph");
    const lock = '{"name":"proof-fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"proof-fixture","version":"1.0.0"}}}';
    writeFileSync(join(directory, "package-lock.json"), lock);
    const checkout = join(directory, ".cms-contract-source"); mkdirSync(checkout);
    writeFileSync(join(checkout, "package.json"), '{"name":"proof-fixture","version":"1.0.0"}');
    writeFileSync(join(checkout, "package-lock.json"), lock);
    const workflow = parse(readFileSync(join(root, ".github/workflows/cms-staging-deploy.yml"), "utf8"));
    const steps = workflow.jobs[job].steps;
    const source = steps.find(step => step.with?.path === ".cms-contract-source");
    assert.deepEqual(source?.with, { ref: "${{ github.sha }}", path: ".cms-contract-source", "persist-credentials": false });
    const commands = steps.filter(step => step.run?.includes("check-cms-public-contract.mjs"));
    assert.equal(commands.length, 2);
    for (const step of commands) assert.ok(step.run.includes('$RUNNER_TEMP/cms-contract-source/scripts/check-cms-public-contract.mjs'));
    const isolate = steps.find(step => step.name === "Isolate trusted singleton contract source");
    const moved = spawnSync("bash", ["-c", isolate.run], { cwd: directory,
      env: { PATH: process.env.PATH, RUNNER_TEMP: runtime, GITHUB_WORKSPACE: directory }, encoding: "utf8" });
    assert.equal(moved.status, 0, moved.stderr);
    const proof = join(runtime, "cms-contract-source");
    const installed = spawnSync("npm", ["ci", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"], {
      cwd: proof, env: { PATH: process.env.PATH, HOME: runtime, npm_config_cache: join(runtime, "cache") }, encoding: "utf8", timeout: 10000 });
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(readFileSync(join(candidateModules, "candidate-marker"), "utf8"), "candidate dependency graph");
    assert.equal(readFileSync(join(directory, "package-lock.json"), "utf8"), lock);
    assert.equal(readFileSync(join(proof, "package-lock.json"), "utf8"), lock);
  } finally { rmSync(runtime, { recursive: true, force: true }); rmSync(directory, { recursive: true, force: true }); }
});
}

test("admits only an exact committed helper copy while retaining untracked-file refusal", () => fixture(directory => {
  renderDevelopmentConfig(directory, inputs);
  const source = "scripts/render-development-config.mjs", target = "trusted-runner.mjs";
  const options = { trustedCopies: { [target]: source } };
  copyFileSync(join(directory, source), join(directory, target));
  assert.throws(() => assertDevelopmentSource(directory, inputs));
  assert.equal(assertDevelopmentSource(directory, inputs, options), true);
  writeFileSync(join(directory, target), "tampered");
  assert.throws(() => assertDevelopmentSource(directory, inputs, options));
  rmSync(join(directory, target)); symlinkSync(join(directory, source), join(directory, target));
  assert.throws(() => assertDevelopmentSource(directory, inputs, options));
}));

test("preserves placeholder sentinels and configures an unrendered trusted smoke copy", () => {
  assert.ok(!developmentInputs.CMS_PRODUCTION_API_ORIGIN.files.includes("agents/vmix/configuration.mjs"));
  const directory = mkdtempSync(join(tmpdir(), "unrendered-smoke-"));
  try {
    copyFileSync(join(root, "scripts/smoke-cms-functions.mjs"), join(directory, "smoke.mjs"));
    const program = `import assert from "node:assert/strict";
      import {parseApiOrigin} from ${JSON.stringify(pathToFileURL(join(root, "agents/vmix/configuration.mjs")).href)};
      import {runCmsFunctionSmoke} from ${JSON.stringify(pathToFileURL(join(directory, "smoke.mjs")).href)};
      assert.equal(parseApiOrigin(process.env.CMS_PRODUCTION_API_ORIGIN), process.env.CMS_PRODUCTION_API_ORIGIN);
      const requests = [];
      await assert.rejects(runCmsFunctionSmoke({ request: async url => {
        requests.push(url); throw new Error("private-provider-canary");
      }}), /health request failed/);
      assert.deepEqual(requests, [process.env.CMS_PRODUCTION_API_ORIGIN + "/health"]);
      await assert.rejects(runCmsFunctionSmoke({baseUrl:"https://other.fixture.test",request:async()=>{throw new Error("unexpected-request")}}), /CMS API URL must/);`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
      env: { PATH: process.env.PATH, CMS_PRODUCTION_API_ORIGIN: inputs.CMS_PRODUCTION_API_ORIGIN }, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("starts rendered container source guards and refuses tampered source, receipts and ignored credentials", () => fixture(directory => {
  renderDevelopmentConfig(directory, inputs);
  const sha = git(directory, "rev-parse", "HEAD").trim();
  const guard = pathToFileURL(join(directory, "site/scripts/cms-publication-runtime-guard.ts")).href;
  const run = () => spawnSync(process.execPath, ["--import", join(root, "site/node_modules/tsx/dist/loader.mjs"),
    "--input-type=module", "-e", `const g=await import(${JSON.stringify(guard)});await g.assertCmsPublicationSourceCheckout(${JSON.stringify(sha)});await g.assertCmsPreviewSourceCheckout(${JSON.stringify(sha)});`],
    { cwd: directory, env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 10000 });
  let result = run(); assert.equal(result.status, 0, result.stderr);
  const receipt = join(directory, ".rendered-deployment-inputs.json"), original = readFileSync(receipt);
  writeFileSync(receipt, "{}"); assert.equal(run().status, 1);
  rmSync(receipt); symlinkSync(join(directory, "missing-receipt"), receipt); assert.equal(run().status, 1);
  rmSync(receipt); writeFileSync(receipt, original);
  writeFileSync(join(directory, ".env"), "fixture-credential"); assert.equal(run().status, 1); rmSync(join(directory, ".env"));
  const target = join(directory, "cms-api/wrangler.dev.jsonc"), before = readFileSync(target);
  writeFileSync(target, before + "\n// tampered\n"); assert.equal(run().status, 1);
}));

test("installs the live-smoke dependency tree through a dangling link", () => {
  const directory = mkdtempSync(join(tmpdir(), "live-smoke-install-"));
  try {
    const workflow = parse(readFileSync(join(root, ".github/workflows/cms-staging-deploy.yml"), "utf8"));
    const steps = workflow.jobs["live-smoke"].steps, step = steps.find(step => step.name === "Install Admin boot smoke dependencies from the exact release source");
    const pkg = { name: "fixture-root", version: "1.0.0", private: true, workspaces: ["admin"] };
    mkdirSync(join(directory, "admin"));
    writeFileSync(join(directory, "package.json"), JSON.stringify(pkg));
    writeFileSync(join(directory, "admin/package.json"), JSON.stringify({ name: "njpbs-admin", version: "1.0.0" }));
    writeFileSync(join(directory, "package-lock.json"), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true,
      packages: { "": pkg, admin: { name: "njpbs-admin", version: "1.0.0" }, "node_modules/njpbs-admin": { resolved: "admin", link: true } } }));
    symlinkSync(join(directory, "workspace/node_modules"), join(directory, "node_modules"));
    const result = spawnSync("bash", ["-c", step.run], { cwd: directory,
      env: { PATH: process.env.PATH, npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false" },
      encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr); assert.equal(lstatSync(join(directory, "node_modules")).isDirectory(), true);

  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("production rendering protects unselected development hosts and their regex variants", () => {
  const text = 'https://api.example.org https://dev-api.example.org api\\.example\\.org dev-api\\.example\\.org api.example.org.other';
  assert.equal(renderDevelopmentText(text, ["CMS_PRODUCTION_API_ORIGIN"], inputs),
    'https://api.fixture.test https://dev-api.example.org api\\.fixture\\.test dev-api\\.example\\.org api.fixture.test.other');
});

test("panel release builds refuse templates while test artifacts cannot claim release evidence", () => fixture(directory => {
  const panel = join(directory, "premiere-boardwalk-panel");
  cpSync(join(root, "premiere-boardwalk-panel"), panel, { recursive: true,
    filter: source => !source.split(/[\\/]/).some(part => ["node_modules", "dist", "dist-local"].includes(part)) });
  for (const name of ["site/src/styles/design-tokens.css", "admin/public/brand/njpbs-horizontal-white.svg"]) {
    mkdirSync(dirname(join(directory, name)), { recursive: true }); copyFileSync(join(root, name), join(directory, name));
  }
  symlinkSync(join(root, "premiere-boardwalk-panel/node_modules"), join(panel, "node_modules"));
  git(directory, "add", "."); git(directory, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.org", "commit", "-qm", "Panel fixture");
  const run = args => spawnSync(process.execPath, [join(panel, "build.cjs"), ...args], {
    cwd: directory, env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 5000 });
  const unrendered = run([]); assert.equal(unrendered.status, 1); assert.match(unrendered.stderr, /Render CMS_PRODUCTION_API_ORIGIN/);
  const synthetic = run(["--test"]); assert.equal(synthetic.status, 0, synthetic.stderr);
  const receipt = () => JSON.parse(readFileSync(join(panel, "dist/build-receipt.json"), "utf8"));
  assert.equal(receipt().sourceRevision, null); assert.equal(receipt().testOnly, true); assert.ok(receipt().pluginId.endsWith(".test"));
  renderDevelopmentConfig(directory, inputs);
  const release = run([]); assert.equal(release.status, 0, release.stderr);
  assert.equal(receipt().sourceRevision, git(directory, "rev-parse", "HEAD").trim()); assert.equal(receipt().testOnly, false);
  assert.ok(readFileSync(join(panel, "dist/index.js"), "utf8").includes(inputs.CMS_PRODUCTION_API_ORIGIN));
}));

test("renderer or manifest source changes invalidate every component and trusted release fingerprint", async () => {
  const { fingerprintInputs } = await import("../../scripts/lib/cms-component-receipt.mjs");
  const { fingerprintTrustedSource } = await import("../../scripts/lib/cms-release-plan.mjs");
  const directory = mkdtempSync(join(tmpdir(), "render-receipt-inputs-"));
  try {
    mkdirSync(join(directory, "scripts")); mkdirSync(join(directory, "config"));
    writeFileSync(join(directory, "scripts/render-development-config.mjs"), "export const mode = 1;\n");
    const manifest = join(directory, "config/development-inputs.json");
    writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, inputs: {} }));
    // The CMS API fingerprint discovers bundle inputs from committed Worker sources.
    mkdirSync(join(directory, "cms-api/src"), { recursive: true });
    for (const name of ["wrangler.jsonc", "wrangler.dev.jsonc"]) writeFileSync(join(directory, "cms-api", name), '{ "main": "src/index.ts" }\n');
    writeFileSync(join(directory, "cms-api/tsconfig.json"), "{}\n");
    writeFileSync(join(directory, "cms-api/src/index.ts"), "export default {};\n");
    writeFileSync(join(directory, "package-lock.json"), '{ "packages": {} }\n');
    git(directory, "init", "-q");
    const checkpoint = () => {
      git(directory, "add", "."); git(directory, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.org", "commit", "-qm", "Render input source");
      return git(directory, "rev-parse", "HEAD").trim();
    };
    const fingerprints = sha => Promise.all([
      ...["functions", "renderer", "cmsApi"].map(component => fingerprintInputs(sha, component, { cwd: directory })),
      fingerprintTrustedSource(sha, { cwd: directory }),
    ]);
    let before = await fingerprints(checkpoint());
    for (const [name, content] of [["scripts/render-development-config.mjs", "export const mode = 2;\n"],
      ["config/development-inputs.json", '{ "schemaVersion": 1, "inputs": {} }\n']]) {
      writeFileSync(join(directory, name), content);
      const after = await fingerprints(checkpoint());
      after.forEach((value, index) => assert.notEqual(value, before[index])); before = after;
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
