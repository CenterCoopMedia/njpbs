// @vitest-environment node
import { createHmac } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = readFileSync(
  fileURLToPath(new URL("../../.github/workflows/pages.yml", import.meta.url)),
  "utf8",
);
const definition = parse(workflow);
const sourceSha = "a".repeat(40);
// Public App metadata: /apps/ccm-njpbs-promote, App ID 5705771.
// The App ID is distinct from the bot account's actor_id.
const appSlug = "ccm-njpbs-promote";
const appActor = `${appSlug}[bot]`;
const owner = "fixture-owner";

function verifierSource(): string {
  const match = workflow.match(
    /# BEGIN PRODUCTION_DEPLOY_AUTH\n\s+node <<'NODE'\n([\s\S]*?)\n\s+NODE\n\s+# END PRODUCTION_DEPLOY_AUTH/,
  );
  expect(match, "production dispatch verifier missing").not.toBeNull();
  const lines = match![1].split("\n");
  const indentation = Math.min(
    ...lines.filter((line) => line.trim()).map((line) => line.match(/^ */)![0].length),
  );
  return lines.map((line) => line.slice(indentation)).join("\n");
}

function signature(secret: string, timestamp: string, refreshId: string, deployRef: string) {
  return createHmac("sha256", secret)
    .update(`${timestamp}\n${refreshId}\n${deployRef}`)
    .digest("hex");
}

function runVerifier(overrides: NodeJS.ProcessEnv) {
  const directory = mkdtempSync(path.join(tmpdir(), "njpbs-production-auth-"));
  const output = path.join(directory, "github-output");
  const result = spawnSync(process.execPath, ["-e", verifierSource()], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      GITHUB_OUTPUT: output,
      EVENT_NAME: "repository_dispatch",
      EVENT_REF: "refs/heads/main",
      EVENT_SHA: sourceSha,
      EVENT_ACTOR: owner,
      RUN_ATTEMPT: "1",
      TRIGGERING_ACTOR: owner,
      CMS_DEPLOY_OWNER: owner,
      CCM_PROMOTE_APP_SLUG: appSlug,
      INPUT_DEPLOY_REF: "",
      PAYLOAD_DEPLOY_REF: "production",
      PAYLOAD_REFRESH_ID: "refresh-123",
      PAYLOAD_TIMESTAMP: "",
      PAYLOAD_SIGNATURE: "",
      DISPATCH_SECRET: "0123456789abcdef0123456789abcdef",
      ...overrides,
    },
  });
  const outputs = existsSync(output) ? readFileSync(output, "utf8") : "";
  rmSync(directory, { recursive: true, force: true });
  return { ...result, outputs };
}

describe("production dispatch authentication", () => {
  it("accepts one fresh signed scheduler request", () => {
    const secret = "0123456789abcdef0123456789abcdef";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const result = runVerifier({
      DISPATCH_SECRET: secret,
      PAYLOAD_TIMESTAMP: timestamp,
      PAYLOAD_SIGNATURE: signature(secret, timestamp, "refresh-123", "production"),
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.outputs).toContain("deploy_ref=production\n");
    expect(result.outputs).toContain("require_fresh=1\n");
  });

  it("rejects tampering, stale requests, and unusable secrets", () => {
    const secret = "0123456789abcdef0123456789abcdef";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signed = signature(secret, timestamp, "refresh-123", "production");
    for (const overrides of [
      { PAYLOAD_DEPLOY_REF: "main", PAYLOAD_TIMESTAMP: timestamp, PAYLOAD_SIGNATURE: signed },
      { PAYLOAD_REFRESH_ID: "other", PAYLOAD_TIMESTAMP: timestamp, PAYLOAD_SIGNATURE: signed },
      { PAYLOAD_TIMESTAMP: String(Number(timestamp) - 601), PAYLOAD_SIGNATURE: signed },
      { PAYLOAD_TIMESTAMP: timestamp, PAYLOAD_SIGNATURE: "0".repeat(64) },
      { PAYLOAD_TIMESTAMP: timestamp, PAYLOAD_SIGNATURE: signed, DISPATCH_SECRET: "short" },
      { PAYLOAD_TIMESTAMP: timestamp, PAYLOAD_SIGNATURE: signed, CMS_DEPLOY_OWNER: "" },
      { PAYLOAD_TIMESTAMP: timestamp, PAYLOAD_SIGNATURE: signed, CMS_DEPLOY_OWNER: "another-owner" },
    ]) {
      expect(runVerifier(overrides).status).not.toBe(0);
    }
  });

  it("accepts owner runs only from the correct workflow ref", () => {
    const manual = runVerifier({
      EVENT_NAME: "workflow_dispatch",
      EVENT_REF: "refs/heads/main",
      INPUT_DEPLOY_REF: "production",
    });
    expect(manual.status).toBe(0);
    expect(manual.outputs).toContain("deploy_ref=production\n");
    expect(manual.outputs).toContain("require_fresh=0\n");

    const push = runVerifier({
      EVENT_NAME: "push",
      EVENT_REF: "refs/heads/production",
    });
    expect(push.status).toBe(0);
    expect(push.outputs).toContain(`deploy_ref=${sourceSha}\n`);

    expect(runVerifier({ EVENT_NAME: "workflow_dispatch", EVENT_REF: "refs/heads/topic" }).status).not.toBe(0);
    expect(runVerifier({ EVENT_NAME: "push", EVENT_REF: "refs/heads/main" }).status).not.toBe(0);
    expect(runVerifier({ EVENT_NAME: "workflow_dispatch", TRIGGERING_ACTOR: "other" }).status).not.toBe(0);
  });
});

describe("production push and rerun admission", () => {
  const variables = {
    CANONICAL_GITHUB_REPOSITORY: "fixture-org/fixture-site",
    CANONICAL_GITHUB_REPOSITORY_ID: "123456",
    CMS_DEPLOY_OWNER: owner,
    CCM_PROMOTE_APP_SLUG: appSlug,
  };
  const github = {
    event_name: "push", ref: "refs/heads/production", sha: sourceSha,
    repository: variables.CANONICAL_GITHUB_REPOSITORY,
    repository_id: variables.CANONICAL_GITHUB_REPOSITORY_ID,
    actor: appActor, triggering_actor: appActor, run_attempt: 1,
  };
  const cases = [
    { name: "promotion App production push", allowed: true },
    { name: "owner production push", github: { actor: owner, triggering_actor: owner }, allowed: true },
    { name: "owner rerun of App push", github: { triggering_actor: owner, run_attempt: 2 }, allowed: true },
    { name: "App rerun of its push", github: { run_attempt: 2 }, allowed: true },
    { name: "another bot", github: { actor: "unrelated[bot]", triggering_actor: "unrelated[bot]" }, allowed: false },
    { name: "ordinary writer", github: { actor: "writer", triggering_actor: "writer" }, allowed: false },
    { name: "owner rerun of another bot", github: { actor: "unrelated[bot]", triggering_actor: owner, run_attempt: 2 }, allowed: false },
    { name: "owner rerun of ordinary writer", github: { actor: "writer", triggering_actor: owner, run_attempt: 2 }, allowed: false },
    { name: "writer rerun of App push", github: { triggering_actor: "writer", run_attempt: 2 }, allowed: false },
    { name: "another bot rerun of App push", github: { triggering_actor: "unrelated[bot]", run_attempt: 2 }, allowed: false },
    { name: "owner as requester on App first attempt", github: { triggering_actor: owner }, allowed: false },
    { name: "App push to main", github: { ref: "refs/heads/main" }, allowed: false },
    { name: "App push to topic", github: { ref: "refs/heads/topic" }, allowed: false },
    { name: "App push to production tag", github: { ref: "refs/tags/production" }, allowed: false },
    { name: "App manual dispatch", github: { event_name: "workflow_dispatch", ref: "refs/heads/main" }, allowed: false },
    { name: "App scheduler dispatch", github: { event_name: "repository_dispatch", ref: "refs/heads/main" }, allowed: false },
    { name: "owner manual dispatch", github: { event_name: "workflow_dispatch", ref: "refs/heads/main", actor: owner, triggering_actor: owner }, allowed: true },
    { name: "owner scheduler dispatch", github: { event_name: "repository_dispatch", ref: "refs/heads/main", actor: owner, triggering_actor: owner }, allowed: true },
    { name: "owner manual without App configuration", github: { event_name: "workflow_dispatch", ref: "refs/heads/main", actor: owner, triggering_actor: owner }, vars: { CCM_PROMOTE_APP_SLUG: "" }, allowed: true },
    { name: "owner scheduler without App configuration", github: { event_name: "repository_dispatch", ref: "refs/heads/main", actor: owner, triggering_actor: owner }, vars: { CCM_PROMOTE_APP_SLUG: "" }, allowed: true },
    { name: "owner scheduler from production", github: { event_name: "repository_dispatch", actor: owner, triggering_actor: owner }, allowed: false },
    { name: "owner manual dispatch from production", github: { event_name: "workflow_dispatch", actor: owner, triggering_actor: owner }, allowed: false },
    { name: "unexpected event", github: { event_name: "pull_request", actor: owner, triggering_actor: owner }, allowed: false },
    { name: "missing App configuration", vars: { CCM_PROMOTE_APP_SLUG: "" }, allowed: false },
    { name: "different App configuration", vars: { CCM_PROMOTE_APP_SLUG: "unrelated" }, allowed: false },
    { name: "missing owner configuration", vars: { CMS_DEPLOY_OWNER: "" }, allowed: false },
  ];

  it.each(cases)("$name", ({ github: patch, vars: settings, allowed }) => {
    const event = { ...github, ...patch };
    const vars = { ...variables, ...settings };
    for (const id of ["authorize", "build", "deploy"]) {
      expect(Boolean(runInNewContext(definition.jobs[id].if, {
        github: event, vars, needs: { authorize: { result: "success" } },
        format: (pattern: string, value: string) => pattern.replace("{0}", value),
      })), id).toBe(allowed);
    }
    const timestamp = String(Math.floor(Date.now() / 1000));
    const result = runVerifier({
      EVENT_NAME: event.event_name, EVENT_REF: event.ref, EVENT_ACTOR: event.actor,
      TRIGGERING_ACTOR: event.triggering_actor, RUN_ATTEMPT: String(event.run_attempt),
      CCM_PROMOTE_APP_SLUG: vars.CCM_PROMOTE_APP_SLUG, CMS_DEPLOY_OWNER: vars.CMS_DEPLOY_OWNER,
      PAYLOAD_TIMESTAMP: timestamp,
      PAYLOAD_SIGNATURE: signature("0123456789abcdef0123456789abcdef", timestamp, "refresh-123", "production"),
    });
    expect(result.status, result.stderr).toBe(allowed ? 0 : 1);
    if (allowed && event.event_name === "push") {
      expect(result.outputs).toBe(`deploy_ref=${sourceSha}\nrequire_fresh=0\n`);
    } else if (!allowed) expect(result.outputs).toBe("");
  });

  it("refuses mismatched or absent canonical repository configuration at every job", () => {
    for (const patch of [{ repository: "other/site" }, { repository_id: "654321" }]) {
      for (const id of ["authorize", "build", "deploy"]) {
        expect(runInNewContext(definition.jobs[id].if, {
          github: { ...github, ...patch }, vars: variables,
          needs: { authorize: { result: "success" } },
          format: (pattern: string, value: string) => pattern.replace("{0}", value),
        }), id).toBe(false);
      }
    }
    for (const key of ["CANONICAL_GITHUB_REPOSITORY", "CANONICAL_GITHUB_REPOSITORY_ID"]) {
      for (const id of ["authorize", "build", "deploy"]) {
        expect(runInNewContext(definition.jobs[id].if, {
          github, vars: { ...variables, [key]: "" }, needs: { authorize: { result: "success" } },
          format: (pattern: string, value: string) => pattern.replace("{0}", value),
        }), id).toBe(false);
      }
    }
  });

  it("maps provider identity into the verifier and pins the admitted push source", () => {
    const job = definition.jobs.authorize;
    const step = job.steps.find((step: any) => step.id === "dispatch");
    expect(job.env.CCM_PROMOTE_APP_SLUG).toBe("${{ vars.CCM_PROMOTE_APP_SLUG }}");
    expect(step.env).toMatchObject({ EVENT_ACTOR: "${{ github.actor }}", EVENT_SHA: "${{ github.sha }}",
      RUN_ATTEMPT: "${{ github.run_attempt }}", TRIGGERING_ACTOR: "${{ github.triggering_actor }}" });
    expect(definition.jobs.build.steps[0].with.ref).toBe("${{ needs.authorize.outputs.deploy_ref }}");
    expect(definition.jobs.build.outputs.source_sha).toBe("${{ steps.source.outputs.sha }}");
    expect(definition.jobs.deploy.steps[0].with.ref).toBe("${{ needs.build.outputs.source_sha }}");
    for (const EVENT_SHA of ["", "production", "a".repeat(39)]) {
      expect(runVerifier({ EVENT_NAME: "push", EVENT_REF: github.ref, EVENT_SHA,
        EVENT_ACTOR: appActor, TRIGGERING_ACTOR: appActor }).status).toBe(1);
    }
  });
});
