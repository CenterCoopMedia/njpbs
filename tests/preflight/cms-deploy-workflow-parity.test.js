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
    expect(workflow.jobs.verify.environment).toBeUndefined();
    expect(verify).not.toContain("secrets.");
    expect(workflow.jobs.verify.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.verify.steps.find(row => row.name === "Verify preview renderer sources").env)
      .toEqual({ CLOUDFLARE_ACCOUNT_ID: "a".repeat(32) });
    const checkouts = workflow.jobs.verify.steps.filter(row => row.uses?.startsWith("actions/checkout@"));
    expect(checkouts).toHaveLength(2);
    for (const checkout of checkouts) expect(checkout.with["persist-credentials"]).toBe(false);
    expect(checkouts[0].with["fetch-depth"]).toBe(0);
    expect(workflow.jobs.verify.if).toBe(workflow.jobs.firebase.if);
    for (const name of ["firebase-preflight", "firebase"]) {
      expect(workflow.jobs[name].needs).toContain("verify");
      expect(workflow.jobs[name].if).not.toMatch(/always\(|failure\(|cancelled\(/);
    }
    const preflight = workflow.jobs["firebase-preflight"].steps;
    const eventIam = preflight.find(row => row.name === "Verify selected event trigger IAM before mutation");
    expect(eventIam.env.CLOUD_PUBLICATION_WAKE_ENVIRONMENT).toBe("production");
    expect(eventIam.env.CLOUD_PUBLICATION_WAKE_ENABLED).toBe("true");
    const probeAt = preflight.findIndex(row => row.name === "Check Containers reads before any provider mutation");
    expect(probeAt).toBeGreaterThan(0);
    expect(Object.keys(preflight[probeAt].env)).toEqual(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]);
    expect(preflight[probeAt].run).toBe('node "$RUNNER_TEMP/release-gate/.github/scripts/cms-containers-read-probe.mjs"');
    const gateCheckout = preflight.find(row => row.with?.path === ".release-gate");
    expect(gateCheckout.with.ref).toBe("${{ github.sha }}");
    expect(gateCheckout.with["persist-credentials"]).toBe(false);
    expect(gateCheckout.with["sparse-checkout"]).toBe(".github/scripts");
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
    expect(Object.keys(production.jobs).sort()).toEqual(["admin-build", "verify", "smoke-manifest", "firebase-preflight", "cms-api", "firebase", "preview-renderer", "admin-contract", "live-smoke", "admin-deploy", "contract-settlement"].sort());
    expect(Object.keys(development.jobs).sort()).toEqual(["deploy", "preview-renderer"]);
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
      expect(capture.env).toMatchObject({ ...planner.env,
        FIREBASE_WEB_API_KEY: "${{ vars.VITE_FIREBASE_API_KEY || secrets.VITE_FIREBASE_API_KEY }}",
        CMS_PREVIEW_R2_CREDENTIAL: "${{ secrets.CMS_PREVIEW_R2_CREDENTIAL }}",
        CMS_TRUSTED_WORKFLOW_SHA: "${{ github.sha }}" });
      expect(capture.run).toContain('4<<< "$CMS_PREVIEW_R2_CREDENTIAL"');
      const authAt = steps.findIndex(row => row.uses?.startsWith("google-github-actions/auth@"));
      const prepareAt = steps.findIndex(row => row.name === "Prepare the singleton contract runtime before credentials");
      expect(authAt).toBeGreaterThan(prepareAt);
      expect(authAt).toBeLessThan(captureAt);
      expect(steps[authAt].with).toEqual({ credentials_json: "${{ secrets.FIREBASE_SERVICE_ACCOUNT }}", project_id: "njpbs-site" });
      const result = spawnSync("bash", ["-c", `node() { test "$VITE_LIVE_PRODUCTION_ENABLED" = false && test "$(cat <&4)" = fixture-archive-access; }\n${capture.run}`], {
        env: { PATH: process.env.PATH, RUNNER_TEMP: tmpdir(), GITHUB_WORKSPACE: "/fixture", DEPLOY_SHA: "a".repeat(40),
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
  it("binds the public-first summary that the before-upload writer emits", async () => {
    const binding = production.jobs["admin-deploy"].steps.find(row => row.name === "Require the before-upload proof for this exact Admin artifact");
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
    const directory = mkdtempSync(join(tmpdir(), "cms-proof-public-first-"));
    // The live renderer runs this same source, so the writer takes its public-first branch.
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ commitSha: head }), { headers: { "content-type": "application/json" } }));
    try {
      const { main } = await import("../../scripts/check-cms-public-contract.mjs");
      mkdirSync(join(directory, "cms-contract-proof"));
      const summary = join(directory, "cms-contract-proof/cms-public-contract-summary-before-upload.json");
      await main(["prove", "--environment", "production", "--boundary", "before-upload", "--candidate", head,
        "--source-root", new URL(".", root).pathname, "--summary", summary, "--state-directory", join(directory, "state")]);
      expect(JSON.parse(readFileSync(summary, "utf8")).result).toBe("public-first");
      mkdirSync(join(directory, "admin/dist"), { recursive: true });
      writeFileSync(join(directory, "admin/dist/index.html"), "admin");
      const digest = spawnSync("bash", ["-c", 'find admin/dist -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d" " -f1'], { cwd: directory, encoding: "utf8" }).stdout.trim();
      expect(spawnSync("bash", ["-c", binding.run], { cwd: directory, env: { PATH: process.env.PATH, RUNNER_TEMP: directory, GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "1",
        DEPLOY_SHA: head, PROVED_ADMIN_DIGEST: digest, PROVED_RUN_ID: "42", PROVED_RUN_ATTEMPT: "1" } }).status).toBe(0);
    } finally { vi.unstubAllGlobals(); rmSync(directory, { recursive: true, force: true }); }
  });
  it("proves before upload apart from Cloudflare tools and binds the exact uploaded Admin", () => {
    const contractJob = production.jobs["admin-contract"], deployJob = production.jobs["admin-deploy"];
    const contract = contractJob.steps, admin = deployJob.steps, settlementJob = production.jobs["contract-settlement"], settlement = settlementJob.steps;
    // The capture follows every backend mutation, and the upload waits for it.
    expect(contractJob.needs).toEqual(deployJob.needs.filter(name => name !== "admin-contract"));
    expect(deployJob.needs).toContain("admin-contract");
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
    expect(settlementJob.needs).toEqual(["admin-build", "live-smoke"]);
    expect(settlementJob.if).toBe(production.jobs["live-smoke"].if);
    expect(settlementJob.environment).toBe("production");
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
