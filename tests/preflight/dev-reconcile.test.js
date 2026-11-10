import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";
import { devReconcileEnvironment, devReconcileRefusalMessage, writeDevReconcileEnvironment } from "../../.github/scripts/dev-reconcile-input.mjs";
import dev from "../../scripts/lib/dev-publication.cjs";
import candidateContract from "../../functions/lib/public-worker-candidate.js";
import { Timestamp } from "firebase-admin/firestore";

// Synthetic failed publication and retained recovery identity.
const run = {
  id: 1001, path: ".github/workflows/cms-dev-publish.yml", event: "repository_dispatch",
  status: "completed", conclusion: "failure", head_branch: "main",
  head_sha: "cccccccccccccccccccccccccccccccccccccccc",
  repository: { full_name: "CenterCoopMedia/njpbs" }, head_repository: { full_name: "CenterCoopMedia/njpbs" },
  actor: { login: "njpbs-dev-publisher[bot]" }, triggering_actor: { login: "njpbs-dev-publisher[bot]" },
};
const env = { CANONICAL_GITHUB_REPOSITORY: "CenterCoopMedia/njpbs", CANONICAL_GITHUB_REPOSITORY_ID: "1442374012",
  GITHUB_REPOSITORY: "CenterCoopMedia/njpbs",
  RETAINED_RUN_ID: "1001", RETAINED_QUEUE_ID: "QQQQQQQQQQQQQQQQQQQQ", RETAINED_GENERATION: "12",
  RETAINED_WORKER_VERSION_ID: "11111111-1111-4111-8111-111111111111",
  CMS_PUBLISH_GITHUB_TRUSTED_ACTORS: JSON.stringify(["fixture-owner"]),
  CMS_DEV_PUBLISH_ENABLED: "false", CMS_DEV_DISPATCH_ACTOR: "njpbs-dev-publisher[bot]",
};

describe("dev recovery provenance", () => {
  it("uses the original run's content source and the supplied exact identity", () => {
    expect(devReconcileEnvironment(run, env)).toEqual({ SOURCE_SHA: run.head_sha,
      QUEUE_ID: env.RETAINED_QUEUE_ID, DEV_RECONCILE_GENERATION: "12",
      DEV_RECONCILE_WORKER_VERSION_ID: env.RETAINED_WORKER_VERSION_ID });
    expect(() => devReconcileEnvironment({ ...run, event: "push", actor: { login: "fixture-owner" },
      triggering_actor: { login: "fixture-owner" } }, env)).not.toThrow();
  });
  it("admits the transferred repository but refuses cross-owner run metadata", () => {
    const repository = "CenterCoopMedia/njpbs";
    const transferred = { ...run, repository: { full_name: repository }, head_repository: { full_name: repository } };
    expect(() => devReconcileEnvironment(transferred, { ...env, GITHUB_REPOSITORY: repository })).not.toThrow();
    expect(() => devReconcileEnvironment(transferred, { ...env, GITHUB_REPOSITORY: "other/repo" })).toThrow();
    expect(() => devReconcileEnvironment({ ...transferred, head_repository: { full_name: "other/repo" } },
      { ...env, GITHUB_REPOSITORY: repository })).toThrow();
  });
  it.each([
    { id: 1 }, { path: ".github/workflows/pages.yml" }, { event: "workflow_dispatch" },
    { status: "in_progress" }, { conclusion: "success" }, { head_branch: "feature" },
    { head_sha: "wrong" }, { repository: { full_name: "other/repo" } },
    { head_repository: { full_name: "other/repo" } }, { actor: { login: "fixture-owner" } },
    { triggering_actor: { login: "collaborator" } },
  ])("refuses an untrusted original run: %j", change => {
    expect(() => devReconcileEnvironment({ ...run, ...change }, env)).toThrow();
  });
  it.each([
    { RETAINED_RUN_ID: "1001\nSOURCE_SHA=other" }, { RETAINED_QUEUE_ID: "../queue" },
    { RETAINED_GENERATION: "0" }, { RETAINED_GENERATION: "12.0" },
    { RETAINED_GENERATION: "9007199254740992" }, { RETAINED_WORKER_VERSION_ID: "wrong" },
    { CMS_DEV_PUBLISH_ENABLED: "true" }, { CMS_DEV_DISPATCH_ACTOR: "fixture-owner" },
  ])("refuses invalid recovery inputs: %j", change => {
    expect(() => devReconcileEnvironment(run, { ...env, ...change })).toThrow();
  });
});

describe("dev retained generic candidate admission", () => {
  function retained() {
    const identity = { queueId: env.RETAINED_QUEUE_ID, buildBatchId: "cms-" + env.RETAINED_QUEUE_ID, commitSha: run.head_sha };
    const runtime = { owner: "cloudflare", release: identity.commitSha };
    const seconds = Math.floor(Date.parse("2026-10-10T00:00:00.000Z") / 1000);
    const at = offset => Timestamp.fromMillis((seconds + offset) * 1000);
    const batch = { schemaVersion: 1, buildBatchId: identity.buildBatchId, generation: 12, commitSha: identity.commitSha,
      runtime, status: "reconciling", reservedAgainstGeneration: 0, reservedAgainstDeploymentId: null,
      reservedAgainstCommitSha: null, cutoffAt: at(0), reservedAt: at(0), readyAt: at(2),
      leaseToken: "11111111-1111-1111-1111-111111111111", leaseAcquiredAt: at(4),
      predecessorGeneration: 0, predecessorDeploymentId: null, predecessorCommitSha: null,
      reconcilingAt: at(5), cloudflareEvidenceDigest: "f".repeat(64) };
    const candidate = { schemaVersion: 1, buildBatchId: identity.buildBatchId, generation: 12, commitSha: identity.commitSha,
      runtime, workerName: "template-dev-public", workerVersionId: env.RETAINED_WORKER_VERSION_ID,
      artifactDigest: "a".repeat(64), artifactReceiptDigest: "b".repeat(64), publicationReceiptDigest: "c".repeat(64),
      mediaManifestDigest: "d".repeat(64), artifactFileCount: 3, artifactBytes: 300, wranglerVersion: "4.134.0",
      versionCreatedOn: "2026-10-10T00:00:01.000Z", recordedAt: at(3),
      noBuildPost: { schemaVersion: 2, families: ["posts"], rendererSha: identity.commitSha, enabled: true, authoritative: true } };
    candidate.workerVersionTag = candidateContract.publicWorkerCandidateTag(candidate);
    return { identity, generation: 12, workerVersionId: env.RETAINED_WORKER_VERSION_ID, batch, candidate,
      input: { schemaVersion: 1, ...identity, inputDigest: "e".repeat(64), recordedAt: at(1) },
      queue: { status: "publishing", transport: "github", runtime, environment: "development", projectId: "njpbs-site-dev",
        changes: [], artifactBuild: { buildBatchId: identity.buildBatchId, commitSha: identity.commitSha, generation: 12, cutoffAt: at(0) } },
      inventory: { ...identity, generation: 12, cutoffAt: at(0), families: [
        { collection: "cmsPages", complete: true, artifacts: [] }, { collection: "cmsPosts", complete: true, artifacts: [] },
        { collection: "cmsSettings", complete: true, artifacts: [] },
      ] } };
  }
  it.each(["pending", "publishing"])("admits exact retained %s work with a generic lease", status => {
    const value = retained();
    value.queue.status = status;
    expect(() => dev.assertDevReconcileInputs(value)).not.toThrow();
  });
  it.each(["reserved", "ready"])("permits provider-only candidate repair from exact frozen %s input", status => {
    const value = retained();
    value.candidate = null;
    value.batch = Object.fromEntries(Object.entries(value.batch).filter(([key]) =>
      !["leaseToken", "leaseAcquiredAt", "predecessorGeneration", "predecessorDeploymentId", "predecessorCommitSha",
        "reconcilingAt", "cloudflareEvidenceDigest", ...(status === "reserved" ? ["readyAt"] : [])].includes(key)));
    value.batch.status = status;
    expect(() => dev.assertDevReconcileInputs(value)).not.toThrow();
  });
  it.each([
    v => { v.generation = 13; }, v => { v.workerVersionId = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee"; },
    v => { v.candidate = null; }, v => { v.candidate.workerName = "njpbs-production"; },
    v => { v.batch.status = "idle"; }, v => { v.queue.status = "success"; },
    v => { v.queue.projectId = "njpbs-site"; }, v => { v.queue.artifactBuild.generation = 13; },
    v => { v.inventory.generation = 13; }, v => { v.inventory.commitSha = "a".repeat(40); },
    v => { v.queue.artifactBuild.buildBatchId = "other"; }, v => { v.input = null; },
    v => { v.input.workerVersionId = env.RETAINED_WORKER_VERSION_ID; },
    v => { v.queue.runtime = undefined; }, v => { v.queue.runtime = { owner: "node-compute", release: v.identity.commitSha }; },
    v => { v.queue.runtime = { owner: "cloudflare", release: "a".repeat(40) }; },
    v => { v.inventory.cutoffAt = { seconds: v.inventory.cutoffAt.seconds, nanoseconds: 1 }; }, v => { v.batch.commitSha = "a".repeat(40); },
    v => { v.candidate.noBuildPost.rendererSha = "a".repeat(40); },
  ])("refuses altered immutable input or generic ownership %#", change => {
    const value = retained(); change(value);
    expect(() => dev.assertDevReconcileInputs(value)).toThrow();
  });
});

describe("dev source selection boundary", () => {
  const queueId = "A1b2C3d4E5f6G7h8I9j0";
  const sha = "a".repeat(40);
  function boundary({ queue = { transport: "github", environment: "development", projectId: "njpbs-site-dev",
    changes: [], runtime: { owner: "cloudflare", release: sha } }, legacy } = {}) {
    const records = new Map([["cmsPublishQueue/" + queueId, queue], ["system/devPublication", legacy]]);
    const reference = path => ({ path });
    const snapshot = ref => ({ exists: records.get(ref.path) !== undefined,
      data: () => structuredClone(records.get(ref.path)) });
    const forbidWrite = () => { throw new Error("Source selection must not write state"); };
    return { records, db: { projectId: "njpbs-site-dev", doc: reference,
      collection: collection => ({ doc: id => reference(collection + "/" + id) }),
      runTransaction: read => read({ getAll: async (...refs) => refs.map(snapshot),
        create: forbidWrite, set: forbidWrite, update: forbidWrite, delete: forbidWrite }) } };
  }
  it.each(["repository_dispatch", "workflow_dispatch"])("selects the accepted cloud release for %s without writes", async eventName => {
    const { db, records } = boundary();
    const before = structuredClone(records);
    expect(await dev.selectDevPublicationSource(db, { eventName, eventSha: "b".repeat(40), queueId })).toBe(sha);
    expect(records).toEqual(before);
  });
  it("reads the accepted queue afresh", async () => {
    const { db, records } = boundary();
    expect(await dev.selectDevPublicationSource(db, { eventName: "repository_dispatch", queueId })).toBe(sha);
    records.get("cmsPublishQueue/" + queueId).runtime.release = "b".repeat(40);
    expect(await dev.selectDevPublicationSource(db, { eventName: "repository_dispatch", queueId })).toBe("b".repeat(40));
  });
  it("uses the validated push source before the new code queue exists", async () => {
    const { db, records } = boundary({ queue: undefined });
    records.delete("cmsPublishQueue/" + queueId);
    expect(await dev.selectDevPublicationSource(db, { eventName: "push", eventSha: sha, queueId })).toBe(sha);
    expect(records.has("cmsPublishQueue/" + queueId)).toBe(false);
  });
  it.each(["invalid", "a".repeat(40) + "\n", "b".repeat(40)])("refuses invalid or conflicting push source %j", async eventSha => {
    const { db } = boundary();
    await expect(dev.selectDevPublicationSource(db, { eventName: "push", eventSha, queueId })).rejects.toThrow();
  });
  it.each([undefined, { owner: "node-compute", release: sha }, { owner: "cloudflare", release: "invalid" }])(
    "refuses old or invalid accepted runtime %j", async runtime => {
      const { db } = boundary({ queue: { transport: "github", environment: "development", projectId: "njpbs-site-dev", changes: [], runtime } });
      await expect(dev.selectDevPublicationSource(db, { eventName: "repository_dispatch", queueId })).rejects.toThrow();
    });
  it("refuses an idle legacy journal without deleting it", async () => {
    const { db, records } = boundary({ legacy: { status: "idle" } });
    const before = structuredClone(records);
    await expect(dev.selectDevPublicationSource(db, { eventName: "repository_dispatch", queueId })).rejects.toThrow("drained-state migration");
    expect(records).toEqual(before);
  });
  it("requires retained frozen source identity to match", async () => {
    const { db } = boundary();
    const retainedIdentity = { queueId, buildBatchId: "cms-" + queueId, commitSha: sha };
    expect(await dev.selectDevPublicationSource(db, { eventName: "workflow_dispatch", queueId, retainedIdentity })).toBe(sha);
    await expect(dev.selectDevPublicationSource(db, { eventName: "workflow_dispatch", queueId,
      retainedIdentity: { ...retainedIdentity, commitSha: "b".repeat(40) } })).rejects.toThrow("Retained dev source differs");
  });
});

describe("dev recovery workflow admission", () => {
  const workflow = parse(readFileSync(".github/workflows/cms-dev-publish.yml", "utf8"));
  const context = { format: (pattern, value) => pattern.replace("{0}", value), github: { repository_id: "1442374012", event_name: "workflow_dispatch", ref: "refs/heads/main",
    workflow_ref: "CenterCoopMedia/njpbs/.github/workflows/cms-dev-publish.yml@refs/heads/main",
    actor: "fixture-owner", triggering_actor: "fixture-owner" }, vars: { CANONICAL_GITHUB_REPOSITORY: "CenterCoopMedia/njpbs", CANONICAL_GITHUB_REPOSITORY_ID: "1442374012", CMS_DEV_PUBLISH_ENABLED: "false", CMS_DEPLOY_OWNER: "fixture-owner",
      CMS_PUBLISH_GITHUB_TRUSTED_ACTORS: JSON.stringify(["fixture-owner"]) },
    contains: (list, value) => list.includes(value), fromJSON: JSON.parse };
  it("admits main-only owner recovery while normal publication jobs stay off", () => {
    expect(runInNewContext(workflow.jobs.reconcile.if, context)).toBe(true);
    expect(runInNewContext(workflow.jobs.prepare.if, context)).toBe(false);
    expect(runInNewContext(workflow.jobs.build.if, context)).toBe(false);
    const auth = workflow.jobs.reconcile.steps.find(step => step.uses?.startsWith("google-github-actions/auth@"));
    expect(auth.with.service_account).toBe("${{ vars.CMS_DEV_PUBLISH_SERVICE_ACCOUNT }}");
    expect(workflow.jobs.reconcile.environment).toBe("development");
    const commands = workflow.jobs.reconcile.steps.map(step => step.run ?? "").join("\n");
    expect(commands).toContain("cms-dev-publication.mjs reconcile");
    expect(commands).not.toMatch(/cms-dev-publication\.mjs (?:prepare|build|upload|fail)\b/);
  });
  it.each([
    { event_name: "push" }, { ref: "refs/heads/feature" }, { workflow_ref: "other" },
    { actor: "collaborator" }, { triggering_actor: "collaborator" },
  ])("refuses another dispatch context: %j", change => {
    expect(runInNewContext(workflow.jobs.reconcile.if, { ...context, github: { ...context.github, ...change } })).toBe(false);
  });
  it("refuses recovery while writers are enabled", () => {
    expect(runInNewContext(workflow.jobs.reconcile.if, { ...context, vars: { ...context.vars, CMS_DEV_PUBLISH_ENABLED: "true" } })).toBe(false);
  });
});


describe("safe dev recovery refusal diagnostics", () => {
  const unsafe = "untrusted-response-or-exception";
  async function refusal(change = {}, response = { ok: true, json: async () => run }) {
    const appendEnvironment = vi.fn();
    const fetchRun = vi.fn(async () => { if (response instanceof Error) throw response; return response; });
    try {
      await writeDevReconcileEnvironment({ ...env, ...change }, { fetchRun, appendEnvironment });
      throw new Error("expected refusal");
    } catch (error) {
      expect(appendEnvironment).not.toHaveBeenCalled();
      return { message: devReconcileRefusalMessage(error), fetchRun };
    }
  }
  it.each([
    new Error(unsafe), { ok: false, json: async () => { throw new Error(unsafe); } },
    { ok: true, json: async () => { throw new Error(unsafe); } },
  ])("categorizes HTTP, network and malformed JSON failures without their details %#", async response => {
    expect((await refusal({}, response)).message).toBe("Dev reconciliation provenance check failed: API lookup");
  });
  it("rejects malformed run IDs before making an API request", async () => {
    const result = await refusal({ RETAINED_RUN_ID: unsafe });
    expect(result.message).toBe("Dev reconciliation provenance check failed: run or input identity");
    expect(result.fetchRun).not.toHaveBeenCalled();
  });
  it.each([null, { ...run, head_sha: unsafe }])("categorizes invalid run identity %#", async value => {
    expect((await refusal({}, { ok: true, json: async () => value })).message)
      .toBe("Dev reconciliation provenance check failed: run or input identity");
  });
  it("categorizes actor admission separately", async () => {
    expect((await refusal({}, { ok: true, json: async () => ({ ...run, actor: { login: unsafe } }) })).message)
      .toBe("Dev reconciliation provenance check failed: actor admission");
  });
  it("does not trust exception messages or lookalike category properties", () => {
    for (const error of [new Error(unsafe), { category: unsafe }, { category: "api_lookup", message: unsafe }, null]) {
      expect(devReconcileRefusalMessage(error)).toBe("Dev reconciliation provenance check failed: internal error");
    }
  });
  it("writes only the validated environment values on success", async () => {
    const appendEnvironment = vi.fn();
    await writeDevReconcileEnvironment({ ...env, GITHUB_ENV: "owned-output" }, {
      fetchRun: async () => ({ ok: true, json: async () => run }), appendEnvironment,
    });
    expect(appendEnvironment).toHaveBeenCalledExactlyOnceWith("owned-output",
      `SOURCE_SHA=${run.head_sha}\nQUEUE_ID=${env.RETAINED_QUEUE_ID}\nDEV_RECONCILE_GENERATION=12\nDEV_RECONCILE_WORKER_VERSION_ID=${env.RETAINED_WORKER_VERSION_ID}\n`);
  });
  it("does not expose environment-write exception details", async () => {
    const error = await writeDevReconcileEnvironment(env, {
      fetchRun: async () => ({ ok: true, json: async () => run }),
      appendEnvironment: () => { throw new Error(unsafe); },
    }).catch(error => error);
    expect(devReconcileRefusalMessage(error)).toBe("Dev reconciliation provenance check failed: environment write");
  });
});
