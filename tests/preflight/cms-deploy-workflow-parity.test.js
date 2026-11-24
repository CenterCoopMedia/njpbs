import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { mkdtempSync, mkdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// The CMS staging deploy verifies the CMS API Worker from the deploy tree with
// its own install steps. They must install the same dependency trees as the
// Firebase CI consumer. The cms-api tests import site/scripts modules whose
// tsconfig extends astro, so the Site tree must be installed too.
const root = new URL("../../", import.meta.url);
const read = path => readFileSync(new URL(path, root), "utf8");

function job(workflow, name) {
  const match = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z-]+:\\n|(?![\\s\\S]))`, "m"));
  if (!match) throw new Error(`Job ${name} is missing`);
  return match[1];
}

function step(block, name) {
  const match = block.match(new RegExp(`- name: ${name}\\n([\\s\\S]*?)(?=\\n\\s+- (?:name|uses):|(?![\\s\\S]))`));
  if (!match) throw new Error(`Step ${name} is missing`);
  return match[1];
}

const deploy = read(".github/workflows/cms-staging-deploy.yml");
const ci = read(".github/workflows/firebase-ci.yml");
const verifyCommands = [
  "npm run cms-api:check",
  "npm run cms-api:test",
  "npx --no-install wrangler deploy --cwd cms-api --dry-run",
];
// Firebase CI writes `npm ci --prefix site`; the deploy job writes `npm --prefix site ci`.
const installPatterns = [
  /^\s*(?:run: )?npm ci --ignore-scripts\b/m,
  /^\s*(?:run: )?npm (?:ci --prefix site|--prefix site ci) --ignore-scripts\b/m,
];

describe("CMS API Worker verification parity", () => {
  it("runs the same Worker checks in Firebase CI and in the deploy job", () => {
    const deployStep = step(job(deploy, "verify"), "Verify CMS API Worker");
    const ciStep = step(job(ci, "firebase"), "CMS API Worker checks");
    const workflow = parse(deploy);
    expect(workflow.jobs["firebase-preflight"].needs).toContain("verify");
    expect(workflow.jobs["cms-api"].needs).toContain("firebase-preflight");
    expect(workflow.jobs["cms-api"].steps.some(row => row.name === "Verify CMS API Worker")).toBe(false);
    for (const command of verifyCommands) {
      expect(deployStep).toContain(command);
      expect(ciStep).toContain(command);
    }
  });

  it("installs the workspace and Site trees before the deploy job verifies the Worker", () => {
    const block = job(deploy, "verify");
    const verifyAt = block.indexOf("- name: Verify CMS API Worker");
    expect(verifyAt).toBeGreaterThan(0);
    const before = block.slice(0, verifyAt);
    const ciInstall = step(job(ci, "firebase"), "Install dependencies");
    for (const pattern of installPatterns) {
      expect(before).toMatch(pattern);
      expect(ciInstall).toMatch(pattern);
    }
  });
});


describe("credential-free deploy verification", () => {
  const workflow = parse(deploy);
  const verify = job(deploy, "verify");
  it("blocks every mutating job until verify succeeds, without credentials", () => {
    expect(workflow.jobs.verify.needs).toBeUndefined();
    // The target environment holds no secret this job reads; the release runner requires it on a dev run.
    expect(workflow.jobs.verify.environment).toBe("${{ inputs.target == 'development' && 'development' || 'production' }}");
    expect(verify).not.toContain("secrets.");
    expect(workflow.jobs.verify.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.verify.steps.find(row => row.name === "Verify preview renderer sources").env)
      .toEqual({ CLOUDFLARE_ACCOUNT_ID: "a".repeat(32) });
    const checkouts = workflow.jobs.verify.steps.filter(row => row.uses?.startsWith("actions/checkout@"));
    expect(checkouts).toHaveLength(2);
    for (const checkout of checkouts) expect(checkout.with["persist-credentials"]).toBe(false);
    expect(checkouts[0].with["fetch-depth"]).toBe(0);
    expect(checkouts[1].with.ref).toBe("${{ github.sha }}");
    expect(checkouts[1].with.path).toBe(".release-gate");
    const verifySteps = workflow.jobs.verify.steps;
    const trustedScan = verifySteps.findIndex(row => row.name === "Metered-API source scan for current release gate");
    const render = verifySteps.findIndex(row => row.name === "Render deployment resource configuration");
    const manifest = verifySteps.findIndex(row => row.run === "node scripts/component-runner.mjs functions manifest");
    expect(trustedScan).toBeGreaterThan(0);
    expect(render).toBeGreaterThan(trustedScan);
    expect(verifySteps[render].run).toContain('"$RUNNER_TEMP/release-gate/scripts/render-development-config.mjs" "${CMS_TARGET_RENDER_SCOPE:?}" --root');
    expect(workflow.env.CMS_TARGET_RENDER_SCOPE).toBe("${{ inputs.target == 'development' && '--development' || '--production' }}");
    expect(manifest).toBeGreaterThan(render);
    expect(verifySteps[manifest].id).toBe("function_plan");
    expect(workflow.jobs.verify.outputs.function_targets).toBe("${{ steps.function_plan.outputs.function_targets }}");
    expect(workflow.jobs.verify.if).toBe(workflow.jobs.firebase.if);
    for (const name of ["firebase-preflight", "firebase"]) {
      expect(workflow.jobs[name].needs).toContain("verify");
      expect(workflow.jobs[name].if).not.toMatch(/always\(|failure\(|cancelled\(/);
    }
    const preflight = workflow.jobs["firebase-preflight"].steps;
    const eventIam = preflight.find(row => row.name === "Verify selected event trigger IAM before mutation");
    expect(eventIam.env.CLOUD_PUBLICATION_WAKE_ENVIRONMENT).toBe("${{ env.CMS_TARGET }}");
    expect(eventIam.env.CLOUD_PUBLICATION_WAKE_ENABLED).toBe("${{ inputs.target != 'development' }}");
    const probeAt = preflight.findIndex(row => row.name === "Check Containers reads before any provider mutation");
    expect(probeAt).toBeGreaterThan(0);
    expect(Object.keys(preflight[probeAt].env)).toEqual(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]);
    expect(preflight[probeAt].run).toBe('node "$RUNNER_TEMP/release-gate/.github/scripts/cms-containers-read-probe.mjs"');
    const gateCheckout = preflight.find(row => row.with?.path === ".release-gate");
    expect(gateCheckout.with.ref).toBe("${{ github.sha }}");
    expect(gateCheckout.with["persist-credentials"]).toBe(false);
    // The gate's containers probe calls the shared release-wait helper.
    expect(gateCheckout.with["sparse-checkout"]).toBe(".github/scripts\nfunctions/lib/release-wait.js\n");
    expect(gateCheckout.with["sparse-checkout-cone-mode"]).toBe(false);
    for (const name of ["Require the provisioned published Post reader secret", "Verify Functions configuration without provider writes", "Verify selected event trigger IAM before mutation", "Verify Admin App Check registration"]) {
      expect(preflight.findIndex(row => row.name === name)).toBeGreaterThan(probeAt);
    }
  });
  it("runs API and renderer checks with their required dependency trees", () => {
    for (const command of verifyCommands) expect(step(verify, "Verify CMS API Worker")).toContain(command);
    const rendererCommands = [
      "npm --prefix preview-renderer run check", "npm run test:preview-renderer",
      "node preview-renderer/node_modules/wrangler/bin/wrangler.js types --config preview-renderer/wrangler.jsonc --strict-vars=false --include-runtime=false --check preview-renderer/worker-configuration.d.ts",
      'node scripts/check-prepared-worker.mjs preview-renderer "$(git rev-parse HEAD)"',
    ];
    for (const command of rendererCommands) {
      expect(step(verify, "Verify preview renderer sources")).toContain(command);
      expect(step(job(ci, "firebase"), "Cloud preview renderer and publisher checks")).toContain(command);
    }
    const before = verify.slice(0, verify.indexOf("- name: Verify CMS API Worker"));
    for (const pattern of installPatterns) expect(before).toMatch(pattern);
    expect(before).toContain("npm --prefix preview-renderer ci --ignore-scripts");
    expect(before.indexOf("- name: Require reviewed deploy ref")).toBeLessThan(before.indexOf("- name: Install workspace deps"));
  });
  it("refuses an oversized Admin file before artifact upload and permits the exact limit", () => {
    const steps = workflow.jobs["admin-build"].steps;
    const sizeAt = steps.findIndex(row => row.name === "Require Pages file size limit");
    expect(sizeAt).toBeGreaterThan(steps.findIndex(row => row.name === "Build admin app"));
    expect(sizeAt).toBeLessThan(steps.findIndex(row => row.name === "Upload admin artifact"));
    const directory = mkdtempSync(join(tmpdir(), "cms-pages-size-"));
    try {
      mkdirSync(join(directory, "admin/dist"), { recursive: true });
      const file = join(directory, "admin/dist/large file.bin");
      writeFileSync(file, "");
      truncateSync(file, 25 * 1024 * 1024);
      expect(spawnSync("bash", ["-c", steps[sizeAt].run], { cwd: directory }).status).toBe(0);
      truncateSync(file, 25 * 1024 * 1024 + 1);
      expect(spawnSync("bash", ["-c", steps[sizeAt].run], { cwd: directory }).status).toBe(1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe("Route D Cut A boundary placement", () => {
  const production = parse(deploy), development = parse(read(".github/workflows/cms-dev-deploy.yml"));
  const proof = (steps, boundary) => steps.findIndex(row => row.name === `Verify the singleton public contract at ${boundary}`);
  it("isolates both contract jobs and keeps triggers and production ancestry admission", () => {
    expect(Object.keys(production.jobs).sort()).toEqual(["admin-build", "verify", "firebase-preflight", "cms-api", "firebase", "preview-renderer", "admin-contract", "live-smoke", "admin-deploy", "contract-settlement"].sort());
    expect(Object.keys(development.jobs).sort()).toEqual(["deploy"]);
    expect(Object.keys(production.on)).toEqual(["workflow_dispatch"]);
    expect(Object.keys(development.on)).toEqual(["workflow_dispatch"]);
    expect(step(job(deploy, "admin-build"), "Require CMS deploy compatibility floor"))
      .toContain('node "$RUNNER_TEMP/admin-status-gate"/.github/scripts/cms-deploy-compatibility.mjs');
    expect(production.jobs["live-smoke"]["runs-on"]).toBe("ubuntu-24.04");
    for (const deployJob of Object.values(production.jobs)) {
      const steps = deployJob.steps ?? [];
      if (!steps.some(row => row.run?.includes("cms-contract-source/scripts/check-cms-public-contract.mjs"))) continue;
      expect(steps.find(row => row.with?.path === ".cms-contract-source")?.with)
        .toEqual({ ref: "${{ github.sha }}", path: ".cms-contract-source", "persist-credentials": false });
      const isolate = steps.find(row => row.name === "Isolate trusted singleton contract source");
      expect(isolate?.run).toContain('mv .cms-contract-source "$RUNNER_TEMP/cms-contract-source"');
      expect(isolate.run).not.toContain("node_modules");
    }
  });
  it("prepares before authentication and proves after protocol validation before the first provider mutation", () => {
    const steps = production.jobs["firebase-preflight"].steps;
    const prepare = steps.findIndex(row => row.name === "Prepare the singleton contract runtime before credentials");
    const auth = steps.findIndex(row => row.name === "Authenticate Firebase deploy service account");
    const protocol = steps.findIndex(row => row.name === "Require the legacy preview protocol before provider mutations");
    expect(prepare).toBeLessThan(auth); expect(auth).toBeLessThan(protocol); expect(protocol).toBeLessThan(proof(steps, "preflight"));
    for (const name of ["Verify Functions configuration without provider writes", "Verify selected event trigger IAM before mutation"])
      expect(steps.findIndex(row => row.name === name)).toBeGreaterThan(proof(steps, "preflight"));
    // Provider mutations now run through the component runner in the dependent job.
    expect(production.jobs.firebase.needs).toContain("firebase-preflight");
    const mutations = JSON.stringify(production.jobs.firebase.steps);
    expect(mutations).toContain("node scripts/component-runner.mjs functions prepare");
    expect(mutations).toContain("node scripts/component-runner.mjs functions deploy");
  });
  it.each([["firebase-preflight", "preflight"], ["admin-contract", "before-upload"], ["contract-settlement", "settlement"]])(
    "supplies authenticated provider and planner inputs at %s", (jobName, boundary) => {
      const steps = production.jobs[jobName].steps;
      const captureAt = proof(steps, boundary);
      const capture = steps[captureAt];
      const planner = production.jobs["firebase-preflight"].steps.find(row => row.name === "Plan Functions and renderer release");
      // Read-only contract capture proves its own graph from the pinned checkout.
      const { FUNCTION_TARGETS: functionTargets, ...providerEnvironment } = planner.env;
      // A reader binding forces the planner's Functions deploy, never the contract's refusal.
      providerEnvironment.FORCE_FIREBASE = "${{ inputs.force_firebase }}";
      expect(functionTargets).toBe("${{ needs.verify.outputs.function_targets }}");
      expect(capture.env).toMatchObject({ ...providerEnvironment,
        FIREBASE_WEB_API_KEY: "${{ vars.VITE_FIREBASE_API_KEY || inputs.target != 'development' && secrets.VITE_FIREBASE_API_KEY || '' }}",
        CMS_PREVIEW_R2_CREDENTIAL: "${{ secrets.CMS_PREVIEW_R2_CREDENTIAL }}",
        CMS_TRUSTED_WORKFLOW_SHA: "${{ github.sha }}" });
      expect(capture.run).toContain('4<<< "$CMS_PREVIEW_R2_CREDENTIAL"');
      const authAt = steps.findIndex(row => row.uses?.startsWith("google-github-actions/auth@"));
      const prepareAt = steps.findIndex(row => row.name === "Prepare the singleton contract runtime before credentials");
      expect(authAt).toBeGreaterThan(prepareAt);
      expect(authAt).toBeLessThan(captureAt);
      expect(steps[authAt].with).toEqual({ credentials_json: "${{ secrets.FIREBASE_SERVICE_ACCOUNT }}", project_id: "${{ env.CMS_TARGET_FIREBASE_PROJECT }}" });
      const result = spawnSync("bash", ["-c", `node() { test "$VITE_LIVE_PRODUCTION_ENABLED" = false && test "$(cat <&4)" = fixture-archive-access; }\n${capture.run}`], {
        env: { PATH: process.env.PATH, RUNNER_TEMP: tmpdir(), GITHUB_WORKSPACE: "/fixture", DEPLOY_SHA: "a".repeat(40), CMS_TARGET: "production",
          VITE_LIVE_PRODUCTION_ENABLED: "false", CMS_PREVIEW_R2_CREDENTIAL: "fixture-archive-access" }, encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
    });
  it("retains successful upstream summaries when only failed deployment jobs rerun", () => {
    for (const [producer, consumer, name] of [["firebase-preflight", "admin-contract", "cms-public-contract-preflight"],
      ["admin-contract", "admin-deploy", "cms-public-contract-before-upload"], ["admin-contract", "contract-settlement", "cms-public-contract-before-upload"]]) {
      const upload = production.jobs[producer].steps.find(row => row.uses?.startsWith("actions/upload-artifact@") && row.with.name === name);
      const download = production.jobs[consumer].steps.find(row => row.uses?.startsWith("actions/download-artifact@") && row.with.name === name);
      expect(upload.with.overwrite).toBe(true);
      expect(download.with.name).toBe(upload.with.name);
      expect(download.with["run-id"]).toBeUndefined();
    }
  });
  it("refuses a before-upload proof from another run attempt or past its age", () => {
    const contract = production.jobs["admin-contract"].steps, admin = production.jobs["admin-deploy"].steps;
    const binding = admin.find(row => row.name === "Require the before-upload proof for this exact Admin artifact");
    const directory = mkdtempSync(join(tmpdir(), "cms-proof-binding-"));
    try {
      mkdirSync(join(directory, "admin/dist"), { recursive: true });
      mkdirSync(join(directory, "cms-contract-proof"));
      writeFileSync(join(directory, "admin/dist/index.html"), "admin");
      const sha = "a".repeat(40);
      const summary = capturedAt => writeFileSync(join(directory, "cms-contract-proof/cms-public-contract-summary-before-upload.json"), JSON.stringify({ candidateSha: sha, capturedAt }));
      summary(Date.now());
      const outputs = join(directory, "outputs");
      const env = { PATH: process.env.PATH, RUNNER_TEMP: directory, GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "1" };
      expect(spawnSync("bash", ["-c", contract.find(row => row.id === "admin_digest").run], { cwd: directory, env: { ...env, GITHUB_OUTPUT: outputs } }).status).toBe(0);
      const proved = Object.fromEntries(readFileSync(outputs, "utf8").trim().split("\n").map(line => line.split("=")));
      const run = (attempt, overrides = {}) => spawnSync("bash", ["-c", binding.run], { cwd: directory, env: { ...env, GITHUB_RUN_ATTEMPT: attempt, DEPLOY_SHA: sha,
        PROVED_ADMIN_DIGEST: proved.value, PROVED_RUN_ID: proved.run_id, PROVED_RUN_ATTEMPT: proved.run_attempt, ...overrides } }).status;
      expect(run("1")).toBe(0);
      expect(run("2")).not.toBe(0);
      expect(run("1", { PROVED_RUN_ID: "another-run" })).not.toBe(0);
      expect(run("1", { PROVED_ADMIN_DIGEST: "" })).not.toBe(0);
      expect(run("1", { PROVED_ADMIN_DIGEST: "a".repeat(64) })).not.toBe(0);
      // Within one attempt, a proof captured two contract budgets ago no longer binds.
      summary(Date.now() - 470_000);
      expect(run("1")).toBe(0);
      summary(Date.now() - 480_000);
      expect(run("1")).not.toBe(0);
      summary(Date.now() + 60_000);
      expect(run("1")).not.toBe(0);
      summary(undefined);
      expect(run("1")).not.toBe(0);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("binds the public-first summary without evaluating selected target code", async () => {
    const binding = production.jobs["admin-deploy"].steps.find(row => row.name === "Require the before-upload proof for this exact Admin artifact");
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
    const directory = mkdtempSync(join(tmpdir(), "cms-proof-public-first-"));
    // The live renderer runs this same source, so the writer takes its public-first branch.
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ commitSha: head }), { headers: { "content-type": "application/json" } }));
    try {
      const { main } = await import("../../scripts/check-cms-public-contract.mjs");
      const selected = join(directory, "selected");
      mkdirSync(join(selected, "functions/lib"), { recursive: true });
      writeFileSync(join(selected, "package.json"), "{}");
      writeFileSync(join(selected, "functions/lib/publication-target.js"), 'throw new Error("Selected target code executed");');
      vi.stubEnv("GIT_DIR", spawnSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: root, encoding: "utf8" }).stdout.trim());
      mkdirSync(join(directory, "cms-contract-proof"));
      const summary = join(directory, "cms-contract-proof/cms-public-contract-summary-before-upload.json");
      await main(["prove", "--environment", "production", "--boundary", "before-upload", "--candidate", head,
        "--source-root", selected, "--summary", summary, "--state-directory", join(directory, "state")]);
      expect(JSON.parse(readFileSync(summary, "utf8")).result).toBe("public-first");
      mkdirSync(join(directory, "admin/dist"), { recursive: true });
      writeFileSync(join(directory, "admin/dist/index.html"), "admin");
      const digest = spawnSync("bash", ["-c", 'find admin/dist -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d" " -f1'], { cwd: directory, encoding: "utf8" }).stdout.trim();
      expect(spawnSync("bash", ["-c", binding.run], { cwd: directory, env: { PATH: process.env.PATH, RUNNER_TEMP: directory, GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "1",
        DEPLOY_SHA: head, PROVED_ADMIN_DIGEST: digest, PROVED_RUN_ID: "42", PROVED_RUN_ATTEMPT: "1" } }).status).toBe(0);
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); }
  });
  it("proves before upload apart from Cloudflare tools and binds the exact uploaded Admin", () => {
    const contractJob = production.jobs["admin-contract"], deployJob = production.jobs["admin-deploy"];
    const contract = contractJob.steps, admin = deployJob.steps, settlementJob = production.jobs["contract-settlement"], settlement = settlementJob.steps;
    // The capture follows every backend mutation, and the upload waits for it.
    expect(contractJob.needs).toEqual(deployJob.needs.filter(name => name !== "admin-contract"));
    expect(deployJob.needs).toContain("admin-contract");
    expect(settlementJob.needs).toEqual(["admin-build", "admin-contract", "live-smoke", "firebase-preflight"]);
    expect(settlementJob.if).toBe(`${production.jobs["live-smoke"].if} && needs.admin-contract.outputs.independent != 'false'`);
    expect(contractJob.outputs.independent).toBe("${{ steps.public_contract.outputs.independent }}");
    expect(contract[proof(contract, "before-upload")].id).toBe("public_contract");
    // Job ADC is allowed here only because nothing Cloudflare-side executes in this job.
    expect(contract.some(row => row.uses?.startsWith("cloudflare/") || /\bwrangler\b/.test(row.run ?? ""))).toBe(false);
    expect(JSON.stringify(contractJob.env ?? {})).not.toContain("CLOUDFLARE");
    expect(contract.filter(row => JSON.stringify(row.env ?? {}).includes("CLOUDFLARE")).map(row => row.name))
      .toEqual(["Verify the singleton public contract at before-upload"]);
    expect(JSON.stringify(admin)).not.toContain("check-cms-public-contract.mjs");
    const gate = contract.find(row => row.with?.path === ".metered-api-gate");
    expect(gate.with["sparse-checkout"]).toBe(".github/scripts");
    const source = contract.find(row => row.with?.path === ".cms-contract-source");
    expect(source.with).toEqual({ ref: "${{ github.sha }}", path: ".cms-contract-source", "persist-credentials": false });
    const scan = contract.findIndex(row => row.name === "Metered-API source scan for the singleton checker");
    expect(scan).toBeGreaterThan(contract.indexOf(source));
    expect(contract[scan].run).toBe('node "$RUNNER_TEMP/metered-api-gate"/.github/scripts/metered-api-scan.mjs --target-root "$RUNNER_TEMP/cms-contract-source"');
    const prepare = contract.findIndex(row => row.name === "Prepare the singleton contract runtime before credentials");
    const auth = contract.findIndex(row => row.name === "Authenticate Firebase deploy service account");
    expect(prepare).toBeGreaterThan(scan); expect(auth).toBeGreaterThan(prepare); expect(proof(contract, "before-upload")).toBe(auth + 1);
    for (const row of [contract[prepare], contract[proof(contract, "before-upload")]]) expect(row.run).toContain('$RUNNER_TEMP/cms-contract-source/scripts/check-cms-public-contract.mjs');
    const digest = contract.find(row => row.id === "admin_digest");
    expect(contractJob.outputs.admin_digest).toBe("${{ steps.admin_digest.outputs.value }}");
    const binding = admin.findIndex(row => row.name === "Require the before-upload proof for this exact Admin artifact");
    expect(admin[binding + 1].name).toBe("Deploy edge-based admin Pages project");
    expect(admin.findIndex(row => row.name === "Download admin artifact")).toBeLessThan(binding);
    expect(admin[binding].env).toEqual({ DEPLOY_SHA: "${{ needs.admin-build.outputs.deploy_sha }}", PROVED_ADMIN_DIGEST: "${{ needs.admin-contract.outputs.admin_digest }}",
      PROVED_RUN_ID: "${{ needs.admin-contract.outputs.proof_run_id }}", PROVED_RUN_ATTEMPT: "${{ needs.admin-contract.outputs.proof_run_attempt }}" });
    expect(admin[binding].run).toContain(digest.run.match(/digest="\$\((.+)\)"/)[1]);
    expect(contractJob.outputs).toMatchObject({ proof_run_id: "${{ steps.admin_digest.outputs.run_id }}", proof_run_attempt: "${{ steps.admin_digest.outputs.run_attempt }}" });
    expect(settlementJob.environment).toBe("${{ inputs.target == 'development' && 'development' || 'production' }}");
    expect(JSON.stringify(settlement)).not.toMatch(/cms-smoke-gate|functions smoke|test:boot|ensure-panel-browser-deps|\bwrangler\b/);
    expect(JSON.stringify(production.jobs["live-smoke"])).not.toContain("FIREBASE_SERVICE_ACCOUNT");
    for (const steps of [contract, settlement]) {
      const prepare = steps.find(row => row.name === "Prepare the singleton contract runtime before credentials");
      expect(prepare.env.SA).toBeUndefined();
      const capture = steps.find(row => row.name?.startsWith("Verify the singleton public contract"));
      expect(capture.run).toContain("umask 077");
      expect(JSON.stringify(capture)).not.toMatch(/GOOGLE_APPLICATION_CREDENTIALS|service-account\.json/);
      if (steps === settlement) expect(steps.findIndex(row => row.uses?.startsWith("google-github-actions/auth@")))
        .toBe(steps.indexOf(capture) - 1);
      expect(capture.run).toContain("--previous-summary");
    }
  });
  it("retains the current held full dev method without an Admin-only admission branch", () => {
    const preflight = read("scripts/check-cms-public-contract.mjs");
    const owner = preflight.slice(preflight.indexOf("async function nativeDevelopmentPlan"), preflight.indexOf("export async function devCompletedBaseline"));
    expect(owner).toContain('if (!runtimeParametersMatch(state.providerFunctions, servingRuntimeParameters(parameters))) refuse("dev-configuration");');
    const steps = development.jobs.deploy.steps;
    const hold = steps.findIndex(row => row.name === "Require the dev publication hold before mutation");
    expect(steps[hold].run).toBe('test "$CMS_DEV_PUBLISH_ENABLED" = false');
    expect(hold).toBeLessThan(proof(steps, "preflight"));
    const names = ["Deploy dev Firestore rules and indexes", "Set the matched dev Admin revision", "Deploy and attest dev reader mounts", "Deploy and verify isolated dev exact-preview gateways"];
    for (const name of names) {
      const index = steps.findIndex(row => row.name === name);
      expect(index).toBeGreaterThan(proof(steps, "preflight"));
      expect(steps[index].if ?? "").not.toContain("independent");
    }
    const upload = steps.findIndex(row => row.name === "Upload dev Admin to Pages");
    expect(proof(steps, "before-upload")).toBe(upload - 1);
    expect(proof(steps, "settlement")).toBeGreaterThan(upload);
  });
  it("cleans private inputs on every exit and transfers only named summary files", () => {
    for (const workflow of [production, development]) for (const current of Object.values(workflow.jobs)) {
      const steps = current.steps;
      if (!steps.some(row => row.name?.startsWith("Verify the singleton public contract"))) continue;
      const cleanup = steps.find(row => row.name === "Remove private singleton contract inputs and processes");
      expect(cleanup.if).toBe("always()");
      expect(cleanup.run).toContain("label=njpbs.cms-contract=$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB");
      for (const row of steps.filter(row => row.uses?.startsWith("actions/upload-artifact@"))) {
        expect(row.with.path).not.toContain("cms-public-contract-private");
        if (row.with.name?.includes("public-contract")) expect(row.with.path).toMatch(/^\$\{\{ runner.temp \}\}\/cms-public-contract-summary-(?:preflight|before-upload|settlement)\.json$/);
      }
    }
  });
});

describe("CMS deploy target", () => {
  const workflow = parse(deploy);
  // Each value has the form `inputs.target == 'development' && <dev> || <production>`.
  const branches = name => workflow.env[name].match(/^\$\{\{ inputs\.target == 'development' && (.+) \|\| (.+) \}\}$/).slice(1);
  it("selects the GitHub environment and every system from one input, with production unchanged", () => {
    expect(workflow.on.workflow_dispatch.inputs.target).toEqual({ description: expect.any(String), required: false,
      default: "production", type: "choice", options: ["production", "development"] });
    const environments = Object.entries(workflow.jobs).filter(([, job]) => job.environment).map(([name]) => name);
    expect(environments).toHaveLength(10);
    for (const name of environments) expect(workflow.jobs[name].environment).toBe("${{ inputs.target == 'development' && 'development' || 'production' }}");
    expect(Object.fromEntries(["CMS_TARGET", "CMS_TARGET_FIREBASE_PROJECT", "CMS_TARGET_ADMIN_ORIGIN", "CMS_TARGET_API_ORIGIN",
      "CMS_TARGET_PUBLIC_ORIGIN", "CMS_TARGET_MEDIA_ORIGIN", "CMS_TARGET_MEDIA_BUCKET", "CMS_TARGET_ADMIN_PAGES", "CMS_TARGET_RENDER_SCOPE"]
      .map(name => [name, branches(name)]))).toEqual({
      CMS_TARGET: ["'development'", "'production'"],
      CMS_TARGET_FIREBASE_PROJECT: ["'njpbs-site-dev'", "'njpbs-site'"],
      CMS_TARGET_ADMIN_ORIGIN: ["'https://dev-admin.njpbs.org'", "'https://admin.njpbs.org'"],
      CMS_TARGET_API_ORIGIN: ["'https://dev-cms-api.njpbs.org'", "vars.CMS_PRODUCTION_API_ORIGIN"],
      CMS_TARGET_PUBLIC_ORIGIN: ["'https://dev.njpbs.org'", "'https://njpbs.org'"],
      CMS_TARGET_MEDIA_ORIGIN: ["'https://dev-media.njpbs.org'", "'https://media.njpbs.org'"],
      CMS_TARGET_MEDIA_BUCKET: ["'njpbs-dev-media'", "vars.CMS_MEDIA_R2_BUCKET"],
      CMS_TARGET_ADMIN_PAGES: ["'njpbs-dev-admin'", "'njpbs-admin'"],
      CMS_TARGET_RENDER_SCOPE: ["'--development'", "'--production'"],
    });
    // Dev render inputs are empty in production, where the renderer ignores them.
    for (const name of Object.keys(workflow.env).filter(name => name.startsWith("CMS_DEV_") || name === "CLOUDFLARE_DEV_PUBLIC_WORKER")) {
      expect(branches(name)).toEqual([`vars.${name}`, "''"]);
    }
    expect(deploy).not.toMatch(/njpbs-site\.cloudfunctions|--project njpbs-site\b|project_id: njpbs-site$|environment: production$/m);
  });

  it("names every value a development run takes from outside its environment", () => {
    // A development-environment job falls back to the repository (production) value of any
    // secret or variable the environment lacks (CenterCoopMedia/njpbs#562). The release runner
    // checks env.CMS_DEVELOPMENT_ENVIRONMENT_NAMES before a development dispatch.
    const names = JSON.parse(workflow.env.CMS_DEVELOPMENT_ENVIRONMENT_NAMES);
    // A development run never evaluates `target != 'development' && X` or `target == 'development' || X`.
    const strip = text => text.replace(/inputs\.target (?:!= 'development' &&|== 'development' \|\|) (?:secrets|vars)\.[A-Z]\w*/g, "")
      .replace(/inputs\.target == 'development' && ([^|}]+?) \|\| (?:secrets|vars)\.[A-Z]\w*/g, "$1");
    const reads = { secrets: new Set(), vars: new Set() };
    const collect = value => {
      for (const [, kind, name] of strip(JSON.stringify(value)).matchAll(/\b(secrets|vars)\.([A-Z][A-Z0-9_]*)\b/g)) reads[kind].add(name);
    };
    collect(Object.fromEntries(Object.entries(workflow.env).filter(([name]) => name !== "CMS_DEVELOPMENT_ENVIRONMENT_NAMES")));
    for (const { steps, ...current } of Object.values(workflow.jobs)) {
      collect(current);
      for (const row of steps) if (!/^inputs\.target != 'development'/.test(row.if ?? "")) collect(row);
    }
    expect(names.secrets).toEqual([...reads.secrets].sort());
    // The admin-build credential check exits on any listed name its step does not bind.
    const check = workflow.jobs["admin-build"].steps.find(row => row.name === "Require the target's deploy credentials");
    for (const name of names.secrets) expect(Object.keys(check.env), name).toContain(name);
    expect(names.secrets).toEqual(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_DEV_PREVIEW_RENDERER_TOKEN", "CLOUDFLARE_DEV_PUBLIC_WORKER_TOKEN", "CMS_BUG_REPORT_GITHUB_TOKEN",
      "CMS_BUG_REPORT_GITHUB_WEBHOOK_SECRET", "CMS_BUG_REPORT_TELEGRAM_ADMIN_MAP", "CMS_BUG_REPORT_TELEGRAM_BOT_TOKEN",
      "CMS_BUG_REPORT_TELEGRAM_CHAT_ID", "CMS_BUG_REPORT_TELEGRAM_WEBHOOK_SECRET", "CMS_DEV_ACCESS_CLIENT_ID", "CMS_DEV_ACCESS_CLIENT_SECRET",
      "CMS_DEV_PREVIEW_FIREBASE_ACCOUNT", "CMS_DEV_PREVIEW_R2_CREDENTIAL", "CMS_EDGE_ORIGIN_SECRET", "CMS_MEDIA_CACHE_PURGE_TOKEN", "CMS_PREVIEW_R2_CREDENTIAL", "CMS_PREVIEW_SMOKE_CREDENTIAL",
      "CMS_STAFF_EMAIL_API_TOKEN", "CMS_VOICEOVER_R2_ACCESS_KEY_ID", "CMS_VOICEOVER_R2_SECRET_ACCESS_KEY", "FIREBASE_SERVICE_ACCOUNT"]);
    // The development environment overrides each of these, and a production value fails a check:
    // the Admin preflight checks the project, auth domain and API origin, the Admin build refuses
    // another app id, App Check compares the site key with the dev app's registration, the IAM
    // check requires the active dev deploy account, and the signed-in preview smoke signs in
    // through the dev Admin (API key) and opens its target record in dev.
    const overridden = names.variables;
    expect(overridden).toEqual(["CMS_PREVIEW_SMOKE_TARGET", "FIREBASE_DEPLOY_SERVICE_ACCOUNT", "VITE_FIREBASE_API_KEY",
      "VITE_FIREBASE_APPCHECK_SITE_KEY", "VITE_FIREBASE_APP_ID", "VITE_FIREBASE_AUTH_DOMAIN", "VITE_FIREBASE_PROJECT_ID", "VITE_FUNCTIONS_BASE_URL"]);
    for (const name of overridden) expect(reads.vars.has(name), name).toBe(true);
    // Shared on purpose: admission identities (canonical repository, deploy owner), dev resource
    // names (CMS_DEV_*, checked by scripts/lib/cms-target.mjs), render placeholders and the
    // readiness and feature flags both targets assert.
    expect([...reads.vars].filter(name => !overridden.includes(name) && !name.startsWith("CMS_DEV_")).sort()).toEqual([
      "AUTHOR_PAGES_LIVE", "CANONICAL_GITHUB_REPOSITORY", "CANONICAL_GITHUB_REPOSITORY_ID", "CLOUDFLARE_DEV_PUBLIC_WORKER", "CMS_DEPLOY_OWNER",
      "CMS_GPU_WORKER_ID", "CMS_LOCAL_PUBLICATION_OWNER", "CMS_PREVIEW_ACCESS_VERIFIED", "CMS_PREVIEW_SERIALIZER_READY",
      "CMS_PREVIEW_TRANSPORT", "CMS_PRODUCTION_API_ORIGIN", "VITE_CMS_PREVIEW_ENABLED", "VITE_VIDEO_REPLACEMENT_ENABLED",
    ]);
  });

  it("gives the dev Cloudflare tokens to development runs only", () => {
    // A production run must evaluate every dev token to ''; the dev branch never falls through to it.
    const devOnly = /^\$\{\{ inputs\.target == 'development' && secrets\.(CLOUDFLARE_DEV_\w+) \|\| (?:inputs\.target != 'development' && secrets\.\w+ \|\| )?'' \}\}$/;
    const values = Object.values(workflow.jobs).flatMap(current => [current.env, ...current.steps.flatMap(row => [row.env, row.with])])
      .flatMap(map => Object.values(map ?? {})).filter(value => /secrets\.CLOUDFLARE_DEV_/.test(String(value)));
    expect(values.length).toBeGreaterThanOrEqual(6);
    for (const value of values) expect(value).toMatch(devOnly);
    const contract = Object.values(workflow.jobs).flatMap(current => current.steps).filter(row => row.name?.startsWith("Verify the singleton public contract at "));
    expect(contract.map(row => row.name)).toEqual(["preflight", "before-upload", "settlement"].map(at => `Verify the singleton public contract at ${at}`));
    for (const row of contract) expect(row.env).toMatchObject({
      CMS_CONTRACT_PUBLIC_TOKEN: "${{ inputs.target == 'development' && secrets.CLOUDFLARE_DEV_PUBLIC_WORKER_TOKEN || '' }}",
      CMS_CONTRACT_PREVIEW_TOKEN: "${{ inputs.target == 'development' && secrets.CLOUDFLARE_DEV_PREVIEW_RENDERER_TOKEN || '' }}" });
  });

  it("keeps every Cloudflare write of a development run on dev names", () => {
    expect(branches("CMS_TARGET_FIREBASE_CONFIG")).toEqual(["'firebase.dev.json'", "'firebase.json'"]);
    expect(branches("CMS_TARGET_FIREBASE_RULES")).toEqual(["'firestore:rules,firestore:indexes'", "'firestore:rules,firestore:indexes,storage'"]);
    expect(workflow.env.CMS_TARGET_RENDERER_SHA).toBeUndefined();
    expect(deploy).not.toContain("CMS_DEV_RENDERER_SOURCE_SHA");
    const steps = Object.values(workflow.jobs).flatMap(current => current.steps);
    expect(steps.some(row => row.name === "Refuse development steps that still act on production systems")).toBe(false);
    // The Studio master steps use the target's own master bucket: dev names its bucket, and only
    // production reads the repository variable (jawn-ops#1273).
    expect(workflow.env.CMS_TARGET_STUDIO_BUCKET).toBe("${{ inputs.target == 'development' && vars.CMS_DEV_STUDIO_BUCKET || " +
      "inputs.target != 'development' && vars.CMS_MEDIA_MASTER_R2_BUCKET || '' }}");
    const studio = steps.filter(row => /CMS_TARGET_STUDIO_BUCKET/.test(row.if ?? ""));
    expect(studio.map(row => [row.name, row.if])).toEqual([
      ["Report unavailable Studio connector storage", "env.CMS_TARGET_STUDIO_BUCKET == ''"],
      ...["Build the exact-source Studio connector package", "Retain the Studio connector package for deployment",
        "Download the exact-source Studio connector package", "Store the Studio connector in private media storage"]
        .map(name => [name, "env.CMS_TARGET_STUDIO_BUCKET != ''"])]);
    expect(steps.some(row => /CMS_MEDIA_MASTER_R2_BUCKET/.test(row.if ?? ""))).toBe(false);
    const byName = Object.fromEntries(steps.filter(row => row.name).map(row => [row.name, row]));
    expect(byName["Build the exact-source Studio connector package"].env.CMS_STUDIO_API_ORIGIN)
      .toBe("${{ inputs.target == 'development' && env.CMS_TARGET_API_ORIGIN || vars.CMS_STUDIO_API_ORIGIN }}");
    expect(byName["Store the Studio connector in private media storage"].env.CMS_MEDIA_MASTER_R2_BUCKET)
      .toBe("${{ env.CMS_TARGET_STUDIO_BUCKET }}");
    // The renderer and Containers steps run on both targets. Production keeps its exact condition:
    // `(target == 'development' || E)` is E there, as `target != 'development' && E` was.
    const guard = "(inputs.target == 'development' || vars.CMS_PREVIEW_CLOUD_ENABLED == 'true')";
    const renderer = steps.filter(row => /CMS_PREVIEW_CLOUD_ENABLED/.test(row.if ?? ""));
    expect(renderer.length).toBeGreaterThan(20);
    for (const row of renderer) expect(row.if.startsWith(guard), row.name).toBe(true);
    expect(deploy).not.toContain("inputs.target != 'development' && vars.CMS_PREVIEW_CLOUD_ENABLED");
    // Each renderer credential is the dev renderer secret on dev and the production secret only on production,
    // with no fallback between them; a missing dev secret is empty, and the release runner refuses it by name.
    const rendererSecrets = { CMS_PREVIEW_FIREBASE_ACCOUNT: ["CMS_DEV_PREVIEW_FIREBASE_ACCOUNT", "FIREBASE_SERVICE_ACCOUNT"],
      CMS_PREVIEW_R2_CREDENTIAL: ["CMS_DEV_PREVIEW_R2_CREDENTIAL", "CMS_PREVIEW_R2_CREDENTIAL"],
      CLOUDFLARE_API_TOKEN: ["CLOUDFLARE_DEV_PREVIEW_RENDERER_TOKEN", "CLOUDFLARE_API_TOKEN"] };
    let checked = 0;
    for (const row of renderer) {
      for (const [name, [dev, production]] of Object.entries(rendererSecrets)) {
        if (row.env?.[name] === undefined) continue;
        expect(row.env[name], `${row.name} ${name}`).toBe(
          `${"${{"} inputs.target == 'development' && secrets.${dev} || inputs.target != 'development' && secrets.${production} || '' }}`);
        checked++;
      }
    }
    expect(checked).toBe(20);
    // Every release-script step takes the dev Access client on dev (preview storage reads and the Worker secret).
    expect(renderer.filter(row => /deploy-cms-preview-cloud\.ts /.test(row.run ?? ""))
      .map(row => [row.env.CMS_DEV_ACCESS_CLIENT_ID, row.env.CMS_DEV_ACCESS_CLIENT_SECRET])).toEqual(Array(4).fill([
      "${{ inputs.target == 'development' && secrets.CMS_DEV_ACCESS_CLIENT_ID || '' }}",
      "${{ inputs.target == 'development' && secrets.CMS_DEV_ACCESS_CLIENT_SECRET || '' }}"]));
    for (const name of ["Open only the Admin authentication shell", "Smoke-test the deployed signed-out Admin shell",
      "Verify the private guide boundary before Admin upload", "Verify the private guide boundary after Admin upload"]) {
      expect(steps.find(row => row.name === name).if).toMatch(/^inputs\.target != 'development'/);
    }
    // The remaining Cloudflare writers on a dev run: the guarded Worker deploy, the dev Pages project and the
    // reader-bridge steps, which productionReaderBinding refuses for a dev target in admin-build.
    const writers = steps.filter(row => /secrets\.CLOUDFLARE_API_TOKEN/.test(JSON.stringify({ ...row.env, ...row.with }))
      && !/inputs\.target != 'development'/.test(row.if ?? "")
      && /pages deploy|deploy-cms-api-worker|production-reader-deployment|wrangler (?:deploy|secret)/.test(`${row.run ?? ""} ${row.with?.command ?? ""}`));
    expect(writers.map(row => row.name).sort()).toEqual(["Deploy CMS API Worker", "Deploy edge-based admin Pages project",
      "Verify and record the original production API reader and complete mount", "Verify and record the original production Functions reader"]);
    expect(steps.find(row => row.name === "Deploy CMS API Worker").run).toContain("scripts/deploy-cms-api-worker.mjs");
    expect(steps.find(row => row.name === "Deploy edge-based admin Pages project").with.command).toContain("--project-name=${{ env.CMS_TARGET_ADMIN_PAGES }}");
    expect(steps.find(row => row.name === "Validate the separate production reader installation authorization").env.CMS_DEPLOYMENT_ENVIRONMENT).toBe("${{ env.CMS_TARGET }}");
  });
});
