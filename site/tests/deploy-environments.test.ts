// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runInNewContext } from "node:vm";

const workflow = (name: string) => parse(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8"));
const environmentPolicy = () => JSON.parse(readFileSync(new URL("../../.github/deploy-environments.json", import.meta.url), "utf8")) as Record<string, { branches: string[]; secrets: string[] }>;

// No job may read a repository-level secret (#2846).
const secretExceptions: Record<string, string[]> = {};

function secretNames(value: unknown): string[] {
  const expressions = JSON.stringify(value).match(/\$\{\{[\s\S]*?\}\}/g) ?? [];
  const names = new Set<string>();
  for (const expression of expressions) {
    const remaining = expression.replace(/\bsecrets\s*(?:\.\s*([a-zA-Z_][\w]*)|\[\s*'([^']+)'\s*\])/gi, (_, dot, bracket) => {
      names.add((dot ?? bracket).toUpperCase());
      return "";
    });
    expect(remaining, "Dynamic secret access needs an explicit policy").not.toMatch(/\bsecrets\b/i);
  }
  return [...names];
}

function assertConfiguredAdmission(job: any, filename: string) {
  const github = { event_name: "workflow_dispatch", ref: "refs/heads/main", repository_id: "123456",
    workflow_ref: `fixture-org/fixture-site/.github/workflows/${filename}.yml@refs/heads/main`,
    triggering_actor: "fixture-owner" };
  const vars = { CANONICAL_GITHUB_REPOSITORY: "fixture-org/fixture-site",
    CANONICAL_GITHUB_REPOSITORY_ID: "123456", CMS_DEPLOY_OWNER: "fixture-owner" };
  const admit = (changedGithub = {}, changedVars = {}) => runInNewContext(job.if, {
    github: { ...github, ...changedGithub }, vars: { ...vars, ...changedVars },
    format: (pattern: string, value: string) => pattern.replace("{0}", value),
  });
  expect(admit()).toBe(true);
  for (const patch of [{ event_name: "push" }, { ref: "refs/heads/feature" },
    { repository_id: "654321" }, { workflow_ref: "other/repository/.github/workflows/other.yml@refs/heads/main" },
    { workflow_ref: github.workflow_ref.replace("refs/heads/main", "refs/heads/feature") },
    { triggering_actor: "untrusted-fixture" }]) expect(admit(patch)).toBe(false);
  for (const patch of [{ CANONICAL_GITHUB_REPOSITORY: "" }, { CANONICAL_GITHUB_REPOSITORY_ID: "" },
    { CMS_DEPLOY_OWNER: "" }, { CANONICAL_GITHUB_REPOSITORY: "other/repository" },
    { CANONICAL_GITHUB_REPOSITORY_ID: "654321" }, { CMS_DEPLOY_OWNER: "another-fixture" }]) {
    expect(admit({}, patch)).toBe(false);
  }
}

// GitHub consumes these job definitions. Issue #2846 defines the credential
// boundary independently of the scripts that each job happens to run.
describe("deploy credential environments", () => {
  it("keeps the offline dev publication build on a hosted runner", () => {
    // Run 38048767168 failed because the rootless fleet image has no bwrap.
    // Like production, this job must stay hosted regardless of fleet variables.
    expect(workflow("cms-dev-publish").jobs.build["runs-on"]).toBe("ubuntu-24.04");
  });

  it("restricts machine receipt proof to main and the two dev Access secrets", () => {
    const definition = workflow("dev-machine-receipt-proof");
    expect(Object.keys(definition.on)).toEqual(["workflow_dispatch"]);
    expect(definition.permissions).toEqual({ contents: "read" });
    const job = definition.jobs.proof;
    expect(job.environment).toBe("development");
    expect(job.if).toContain("github.ref == 'refs/heads/main'");
    assertConfiguredAdmission(job, "dev-machine-receipt-proof");
    expect(job.permissions).toBeUndefined();
    expect(secretNames(job)).toEqual(["CMS_DEV_ACCESS_CLIENT_ID", "CMS_DEV_ACCESS_CLIENT_SECRET"]);
    expect(job.steps[0].with).toEqual({ ref: "${{ github.sha }}", "persist-credentials": false });
    for (const step of job.steps.filter((step: any) => step.uses)) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
  });

  it("restricts production promotion to configured main dispatches and a repository-scoped App token", () => {
    const definition = workflow("promote");
    expect(Object.keys(definition.on)).toEqual(["workflow_dispatch"]);
    expect(definition.permissions).toEqual({ contents: "read", actions: "read" });
    const job = definition.jobs.promote;
    expect(job.environment).toBe("production");
    assertConfiguredAdmission(job, "promote");
    expect(job.permissions).toBeUndefined();
    expect(secretNames(definition)).toEqual(["CCM_PROMOTE_APP_PRIVATE_KEY"]);
    for (const step of job.steps.filter((step: any) => step.uses)) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
    const token = job.steps.find((step: any) => step.uses?.startsWith("actions/create-github-app-token@"));
    expect(token?.with).toEqual({
      "client-id": "${{ vars.CCM_PROMOTE_APP_CLIENT_ID }}",
      "private-key": "${{ secrets.CCM_PROMOTE_APP_PRIVATE_KEY }}",
      owner: "${{ github.repository_owner }}",
      repositories: "${{ github.event.repository.name }}",
      "permission-contents": "write",
      "permission-workflows": "write",
    });
  });

  it("restricts the isolated dev staff gateway to explicit main-only development dispatches", () => {
    const definition = workflow("dev-staff-gateway-deploy");
    expect(Object.keys(definition.on)).toEqual(["workflow_dispatch"]);
    expect(definition.on.workflow_dispatch.inputs.mode.options).toEqual(["stage", "update"]);
    expect(definition.on.workflow_dispatch.inputs.version_id).toBeUndefined();
    expect(definition.on.workflow_dispatch.inputs.mode.default).toBe("stage");
    expect(definition.on.workflow_dispatch.inputs.prerequisites_verified.default).toBe(false);
    expect(definition.permissions).toEqual({ contents: "read" });
    expect(definition.concurrency).toEqual({ group: "dev-staff-gateway-deploy", "cancel-in-progress": false });
    const job = definition.jobs.deploy;
    expect(job.environment).toBe("development");
    expect(job.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(job.if).toContain("github.ref == 'refs/heads/main'");
    assertConfiguredAdmission(job, "dev-staff-gateway-deploy");
    expect(job.permissions).toBeUndefined();
    expect(secretNames(job)).toEqual(["CLOUDFLARE_DEV_WORKER_TOKEN"]);
    for (const step of job.steps.filter((step: any) => step.uses)) {
      expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
    }
    expect(job.steps[0].with).toEqual({ ref: "${{ github.sha }}", "persist-credentials": false });
    const operator = job.steps.at(-1);
    expect(operator.env.DEV_ACCESS_AUDIENCE).toBe("${{ vars.DEV_ACCESS_AUDIENCE }}");
    expect(operator.env.GATEWAY_MODE).toBe("${{ inputs.mode }}");
    expect(operator.env.GATEWAY_VERSION_ID).toBeUndefined();
    expect(operator.env.GATEWAY_PREREQUISITES_VERIFIED).toBe("${{ inputs.prerequisites_verified }}");
    expect(operator.env.CMS_DEV_PUBLISH_ENABLED).toBe("${{ vars.CMS_DEV_PUBLISH_ENABLED }}");
    expect(operator.run).toBe("node scripts/deploy-dev-staff-gateway.mjs");
  });

  it.each([
    ["cms-staging-deploy", ["admin-build", "firebase-preflight", "cms-api", "firebase", "preview-renderer", "live-smoke", "admin-deploy"]],
    ["cms-publish", ["build", "finalize"]],
    ["shadow-posts-dev-deploy", ["deploy"]],
  ] as const)("places main-only secret jobs in production: %s", (name, jobs) => {
    for (const id of jobs) expect(workflow(name).jobs[id].environment).toBe("production");
  });

  it("places dev publication credentials only in development", () => {
    const definition = workflow("cms-dev-publish");
    for (const id of ["prepare", "finalize"]) expect(definition.jobs[id].environment).toBe("development");
    expect(definition.jobs.build.environment).toBeUndefined();
    expect(secretNames(definition.jobs.build)).toEqual([]);
    expect(secretNames(definition.jobs.finalize)).toEqual([
      "CLOUDFLARE_DEV_PUBLIC_WORKER_TOKEN", "CMS_DEV_PREVIEW_R2_CREDENTIAL",
      "CMS_DEV_ACCESS_CLIENT_ID", "CMS_DEV_ACCESS_CLIENT_SECRET",
    ]);
  });

  it("places schedule App jobs in their dedicated main-only environment", () => {
    for (const id of ["bake", "deferred-merge"]) expect(workflow("schedule-bake").jobs[id].environment).toBe("schedule-bake");
  });

  it("preserves github-pages and scopes production-ref jobs to its two-branch policy", () => {
    for (const name of ["pages", "cms-publish"]) expect(workflow(name).jobs.deploy.environment.name).toBe("github-pages");
    expect(workflow("pages").on.push.branches).toEqual(["production"]);
    for (const id of ["authorize", "build"]) expect(workflow("pages").jobs[id].environment).toBe("github-pages");
    expect(workflow("probe-media-manager").jobs.probe.environment).toBe("production");
  });

  it("defines only the approved environments and exact deployment branches", () => {
    expect(Object.fromEntries(Object.entries(environmentPolicy()).map(([name, policy]) => [name, policy.branches]))).toEqual({
      production: ["main"], "schedule-bake": ["main"], development: ["main"], "github-pages": ["main", "production"],
    });
  });

  it.each(["pages", "cms-publish"])("keeps both Firebase credential paths available to %s deploy", name => {
    const environment = workflow(name).jobs.deploy.environment.name;
    expect(environmentPolicy()[environment].secrets).toEqual(expect.arrayContaining([
      "FIREBASE_PUBLISH_SERVICE_ACCOUNT", "FIREBASE_SERVICE_ACCOUNT",
    ]));
  });

  for (const file of readdirSync(new URL("../../.github/workflows/", import.meta.url)).filter(file => /\.ya?ml$/.test(file))) {
    it(`isolates deploy credentials from the shared PR runner pool: ${file}`, () => {
      const definition = parse(readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), "utf8"));
      for (const [id, job] of Object.entries(definition.jobs) as [string, any][]) {
        const secrets = secretNames([definition.env, job]);
        const hasDeployKey = secrets.some(secret => /^(FIREBASE_(PUBLISH_)?SERVICE_ACCOUNT|CLOUDFLARE_.*TOKEN)$/.test(secret));
        const permissions = job.permissions ?? definition.permissions;
        const hasOidc = permissions === "write-all" || permissions?.["id-token"] === "write";
        if (hasDeployKey || hasOidc) {
          // #2678: a different label on the same disk is not isolation. A
          // literal hosted route cannot be redirected by either fleet variable.
          expect(job["runs-on"], `${file}/${id}: deploy credentials need an isolated runner`).toBe("ubuntu-24.04");
        }
      }
    });

    it(`assigns every secret reader to an expected environment: ${file}`, () => {
      const definition = parse(readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), "utf8"));
      const policy = environmentPolicy();
      for (const [id, job] of Object.entries(definition.jobs) as [string, any][]) {
        const context = `${file}/${id}`;
        const environment = typeof job.environment === "string" ? job.environment : job.environment?.name;
        if (job.environment !== undefined) expect(Object.keys(policy), context).toContain(environment);
        expect(job.secrets, `${context}: inherited secrets need an explicit policy`).not.toBe("inherit");
        for (const secret of secretNames([definition.env, job])) {
          // GITHUB_TOKEN is created by GitHub for each job; it is not migrated.
          if (secret === "GITHUB_TOKEN") continue;
          if (secret === "SCHEDULE_BAKE_APP_PRIVATE_KEY") {
            expect(["schedule-bake.yml/bake", "schedule-bake.yml/deferred-merge"]).toContain(context);
            expect(environment, context).toBe("schedule-bake");
          }
          if (secretExceptions[context]?.includes(secret)) continue;
          expect(environment, `${context}: ${secret} has no environment`).toBeDefined();
          expect(policy[environment]?.secrets, `${context}: ${secret} is not provisioned`).toContain(secret);
        }
      }
    });
  }



});
