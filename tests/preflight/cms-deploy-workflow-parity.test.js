import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
