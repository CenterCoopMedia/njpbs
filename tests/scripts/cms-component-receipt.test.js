import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  collectLiveIdentities,
  fingerprintInputs,
  functionsInventoryIdentity,
  parseProviderIdentities,
  requireComponent,
  completeReceipt,
  configurationFingerprint,
  edgeOriginSecretFingerprint,
  startReceipt,
} from "../../scripts/lib/cms-component-receipt.mjs";
import { main as receiptCli, recordedIdentityMatchesSource, selectiveReceiptResumable } from "../../scripts/cms-component-receipt.mjs";

const SOURCE = "a".repeat(40);
const RENDERER_APP_ID = "11111111-1111-1111-1111-111111111111";
const RENDERER_IMAGE = "registry.cloudflare.com/preview:new";
const RENDERER_ROLLOUT = {
  id: "33333333-3333-3333-3333-333333333333",
  created_at: "2026-09-22T15:58:17Z",
  status: "completed",
  current_configuration: { image: "registry.cloudflare.com/preview:old" },
  target_configuration: { image: RENDERER_IMAGE },
  current_version: 53,
  target_version: 54,
  steps: [{ status: "completed" }],
  progress: {
    total_steps: 1,
    current_step: 1,
    updated_instances: 1,
    total_instances: 1,
    version_distribution: {
      target_version_instances: 1,
      current_version_instances: 0,
      target_version_percentage: 100,
    },
  },
};

const PARTIAL_ROLLOUT = {
  ...RENDERER_ROLLOUT,
  progress: {
    total_steps: 1,
    current_step: 1,
    updated_instances: 0,
    total_instances: 1,
    version_distribution: {
      target_version_instances: 0,
      current_version_instances: 1,
      target_version_percentage: 0,
    },
  },
};

// The default release starts before every rollout fixture.
function readyRendererFirestore(startedAt = "2026-09-20T00:00:00Z", receipt = { mutation: { sourceSha: SOURCE, startedAt, releaseStartedAt: startedAt } }) {
  return {
    doc: () => ({
      get: async () => ({
        exists: true,
        data: () => ({ phase: "ready", rendererSha: SOURCE, serializerId: "cloudflare-preview" }),
      }),
    }),
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: true, data: () => receipt }),
      }),
    }),
  };
}

function cloudflareResult(result) {
  return { ok: true, json: async () => ({ result }) };
}

describe("cms component receipt contract", () => {
  it("fingerprints API-consumed Admin runtime sources without selecting unrelated Admin edits", async () => {
    const { stdout } = await promisify(execFile)("bash", ["tests/scripts/fixtures/legion-closure-gap.sh", process.cwd()], {
      env: { ...process.env, NODE_BINARY: process.execPath }, timeout: 20_000,
    });
    expect(JSON.parse(stdout)).toMatchObject({ cmsApiInputsEqual: false, apiBundleConsumesChangedOwner: true,
      apiBundleChanged: true, tsxAndHoistedDependencyCovered: true, adminCompilerInputsEqual: false, unrelatedAdminInputsEqual: true, unrelatedApiBundleEqual: true,
      functionsInputsEqual: true, functionsGraphEqual: true });
  }, 40_000);
  it("allows only this run's earlier attempt at the exact Functions source to resume", () => {
    const receipt = { schemaVersion: 1, component: "functions", state: "in_progress", mutation: { sourceSha: SOURCE, runId: "10", runAttempt: 1 } };
    const input = { component: "functions", sourceSha: SOURCE, runId: "10", runAttempt: "2" };
    expect(selectiveReceiptResumable(receipt, input)).toBe(true);
    expect(selectiveReceiptResumable({ ...receipt, state: "complete" }, input)).toBe(true);
    for (const patch of [{ component: "renderer" }, { sourceSha: "b".repeat(40) }, { runId: "11" }, { runAttempt: "1" }, { runAttempt: "invalid" }]) {
      expect(selectiveReceiptResumable(receipt, { ...input, ...patch })).toBe(false);
    }
    expect(selectiveReceiptResumable({ ...receipt, schemaVersion: 2 }, input)).toBe(false);
    expect(selectiveReceiptResumable({ ...receipt, state: "unknown" }, input)).toBe(false);
  });
  it("fingerprints the declared input paths", async () => {
    const digest = await fingerprintInputs(SOURCE, "functions", {
      listTree: async (sha, paths) => {
        expect(sha).toBe(SOURCE);
        expect(paths).toContain("functions");
        expect(paths).not.toContain("firestore.rules");
        expect(paths).not.toContain("scripts/seed-content-sections.mjs");
        expect(paths).not.toContain("scripts/backfill-author-profiles.mjs");
        expect(paths).not.toContain("scripts/backfill-byline-projections.mjs");
        expect(paths).toContain("firebase.json");
        expect(paths).toContain(".firebaserc");
        return "100644 blob abc functions/index.js\n";
      },
    });
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects secret-shaped provider identities", () => {
    expect(() => parseProviderIdentities({ token: "x".repeat(400) })).toThrow(/invalid/i);
  });

  it("accepts only the three deployment components", () => {
    expect(requireComponent("cmsApi")).toBe("cmsApi");
    expect(() => requireComponent("admin")).toThrow(/invalid/i);
  });

  it("stamps startedAt from the clock", async () => {
    const writes = [];
    const firestore = {
      doc: () => ({ protocol: true }),
      collection: () => ({ doc: () => ({}) }),
      runTransaction: async (work) => work({
        get: async () => ({ exists: false }),
        set: (_ref, data) => { writes.push(data); },
      }),
    };
    await startReceipt(firestore, {
      component: "functions",
      sourceSha: SOURCE,
      trustedWorkflowSha: "b".repeat(40),
      runId: "1",
      runAttempt: 1,
      inputFingerprint: "c".repeat(64),
    }, { now: () => new Date("2026-09-21T13:00:00.000Z") });
    expect(writes[0].mutation.startedAt).toBe("2026-09-21T13:00:00.000Z");
  });

  it("fingerprints live Cloud Functions inventory", () => {
    const first = functionsInventoryIdentity([
      {
        name: "projects/njpbs-site/locations/us-central1/functions/health",
        state: "ACTIVE",
        updateTime: "2026-09-21T00:00:00Z",
        serviceConfig: { uri: "https://health.run.app", revision: "health-00001-abc", secretEnvironmentVariables: [{ key: "TOKEN", secret: "TOKEN", version: "1" }] },
        buildConfig: { runtime: "nodejs22", entryPoint: "health", source: { storageSource: { bucket: "b", object: "o", generation: "1" } } },
      },
    ]);
    const second = functionsInventoryIdentity([
      {
        name: "projects/njpbs-site/locations/us-central1/functions/health",
        state: "ACTIVE",
        updateTime: "2026-09-21T00:00:00Z",
        serviceConfig: { uri: "https://health.run.app", revision: "health-00002-def", secretEnvironmentVariables: [{ key: "TOKEN", secret: "TOKEN", version: "1" }] },
        buildConfig: { runtime: "nodejs22", entryPoint: "health", source: { storageSource: { bucket: "b", object: "o", generation: "1" } } },
      },
    ]);
    expect(first.activeCount).toBe("1");
    expect(first.inventoryFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(first.inventoryFingerprint).not.toBe(second.inventoryFingerprint);
  });

  it("records the live renderer container image identity", async () => {
    const identity = await collectLiveIdentities("renderer", {
      firestore: readyRendererFirestore(),
      cloudflareToken: "token",
      cloudflareAccount: "account",
      fetchFn: async (url) => {
        if (url.includes("/rollouts")) {
          return cloudflareResult([{ ...RENDERER_ROLLOUT, strategy: "new_instances", steps: undefined }]);
        }
        if (url.includes("/schedules")) {
          return { ok: true, json: async () => ({ result: { schedules: [{ cron: "* * * * *" }] } }) };
        }
        if (url.includes("/deployments")) {
          return {
            ok: true,
            json: async () => ({ result: { deployments: [{ id: "22222222-2222-2222-2222-222222222222" }] } }),
          };
        }
        expect(url).toContain("/containers/applications");
        return {
          ok: true,
          json: async () => ({
            result: [{
              id: RENDERER_APP_ID,
              name: "njpbs-cms-preview-renderer",
              version: RENDERER_ROLLOUT.current_version,
              active_rollout_id: RENDERER_ROLLOUT.id,
              configuration: { image: RENDERER_ROLLOUT.current_configuration.image },
            }],
          }),
        };
      },
    });
    expect(identity.applicationId).toBe(RENDERER_APP_ID);
    expect(identity.identityVersion).toBe("2");
    expect(identity.identityFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.legacyIdentityFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.workerDeploymentId).toBe("22222222-2222-2222-2222-222222222222");
    expect(identity.workerScheduleFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records the rollout target when the application still shows the previous image", async () => {
    // Synthetic Containers API rollout: instances use the target version while
    // the application record still reports the previous version and image.
    const previousImage = "registry.cloudflare.com/preview@sha256:1111111111111111111111111111111111111111111111111111111111111111";
    const targetImage = "registry.cloudflare.com/preview@sha256:2222222222222222222222222222222222222222222222222222222222222222";
    const completed = {
      id: "44444444-4444-4444-4444-444444444444",
      created_at: "2026-01-01T00:02:00.000000000Z",
      last_updated_at: "2026-01-01T00:02:00.000000000Z",
      status: "completed",
      kind: "full_auto",
      strategy: "rolling",
      current_version: 2,
      target_version: 3,
      current_configuration: { image: previousImage, disk: {}, memory_mib: 512, vcpu: 1 },
      target_configuration: { image: targetImage, disk: {}, memory_mib: 512, vcpu: 1 },
      steps: [{ id: 1, status: "completed", step_size: { percentage: 100 } }],
      progress: {
        total_steps: 1,
        current_step: 1,
        updated_instances: 1,
        total_instances: 1,
        version_distribution: {
          target_version_instances: 1,
          current_version_instances: 0,
          target_version_percentage: 100,
        },
      },
      health: { instances: { healthy: 1, active: 0, failed: 0 } },
    };
    const replaced = {
      ...completed,
      id: "55555555-5555-5555-5555-555555555555",
      created_at: "2026-01-01T00:01:00.000000000Z",
      status: "replaced",
      current_version: 1,
      target_version: 2,
      current_configuration: { image: "registry.cloudflare.com/preview@sha256:older" },
      target_configuration: { image: previousImage },
    };
    const application = {
      id: RENDERER_APP_ID,
      name: "njpbs-cms-preview-renderer",
      version: 2,
      updated_at: "2026-01-01T00:01:59.000Z",
      active_rollout_id: completed.id,
      health: { instances: { healthy: 1, active: 0, assigned: 0, stopped: 0, failed: 0, scheduling: 0, starting: 0 } },
      digest: "sha256:previous",
      configuration: { image: previousImage, image_digest: "sha256:previous-config" },
    };
    let applicationReads = 0;
    const sleeps = [];
    const fetchFn = async (url) => {
      if (url.endsWith("/rollouts")) return cloudflareResult([replaced, completed]);
      if (url.endsWith("/deployments")) return cloudflareResult({ deployments: [{ id: "worker-deployment" }] });
      if (url.endsWith("/schedules")) return cloudflareResult({ schedules: [] });
      applicationReads += 1;
      return cloudflareResult([application]);
    };
    const deps = {
      firestore: readyRendererFirestore("2026-01-01T00:00:00Z"),
      cloudflareToken: "token",
      cloudflareAccount: "account",
      sleep: async (ms) => { sleeps.push(ms); },
      fetchFn,
    };
    const identity = await collectLiveIdentities("renderer", deps);
    const withoutStaleDigest = {
      ...application,
      digest: undefined,
      configuration: { image: previousImage },
    };
    const sameTarget = await collectLiveIdentities("renderer", {
      ...deps,
      fetchFn: async (url) => url.endsWith("/rollouts") || url.endsWith("/deployments") || url.endsWith("/schedules")
        ? fetchFn(url)
        : cloudflareResult([withoutStaleDigest]),
    });
    const otherTarget = await collectLiveIdentities("renderer", {
      ...deps,
      rolloutDeadlineMs: 0,
      sleep: async () => { throw new Error("must not sleep"); },
      fetchFn: async (url) => {
        if (url.endsWith("/rollouts")) {
          return cloudflareResult([replaced, {
            ...completed,
            target_configuration: { ...completed.target_configuration, image: `${targetImage}-other` },
          }]);
        }
        if (url.endsWith("/deployments") || url.endsWith("/schedules")) return fetchFn(url);
        return cloudflareResult([withoutStaleDigest]);
      },
    });
    expect(applicationReads).toBe(1);
    expect(sleeps).toEqual([]);
    expect(identity.applicationId).toBe(RENDERER_APP_ID);
    expect(identity.identityFingerprint).toBe(sameTarget.identityFingerprint);
    expect(identity.legacyIdentityFingerprint).toBe(sameTarget.legacyIdentityFingerprint);
    expect(identity.identityFingerprint).not.toBe(otherTarget.identityFingerprint);
  });

  it("does not record a completed rollout that disagrees with the application", async () => {
    let applicationReads = 0;
    await expect(collectLiveIdentities("renderer", {
      firestore: readyRendererFirestore(),
      cloudflareToken: "token",
      cloudflareAccount: "account",
      rolloutDeadlineMs: 0,
      sleep: async () => { throw new Error("must not sleep"); },
      fetchFn: async (url) => {
        if (url.endsWith("/rollouts")) return cloudflareResult([RENDERER_ROLLOUT]);
        applicationReads += 1;
        return cloudflareResult([{
          id: RENDERER_APP_ID,
          name: "njpbs-cms-preview-renderer",
          version: 66,
          active_rollout_id: "66666666-6666-6666-6666-666666666666",
          configuration: { image: RENDERER_IMAGE },
        }]);
      },
    })).rejects.toThrow(/did not converge/i);
    expect(applicationReads).toBe(1);
  });

  describe("renderer rollout binding", () => {
    const boundApplication = (side, extra = {}) => ({
      id: RENDERER_APP_ID,
      name: "njpbs-cms-preview-renderer",
      version: RENDERER_ROLLOUT[`${side}_version`],
      active_rollout_id: RENDERER_ROLLOUT.id,
      configuration: { image: RENDERER_ROLLOUT[`${side}_configuration`].image },
      ...extra,
    });
    const read = (application, { rollout = RENDERER_ROLLOUT, firestore = readyRendererFirestore(), log } = {}) =>
      collectLiveIdentities("renderer", {
        firestore,
        cloudflareToken: "token",
        cloudflareAccount: "account",
        rolloutDeadlineMs: 0,
        log: log ?? (() => {}),
        sleep: async () => { throw new Error("must not sleep"); },
        fetchFn: async (url) => {
          if (url.endsWith("/rollouts")) return cloudflareResult([rollout]);
          if (url.endsWith("/deployments")) return cloudflareResult({ deployments: [{ id: "worker-deployment" }] });
          if (url.endsWith("/schedules")) return cloudflareResult({ schedules: [] });
          return cloudflareResult([application]);
        },
      });

    it("records the same target identity from either application shape", async () => {
      const current = await read(boundApplication("current", { digest: "sha256:previous" }));
      const target = await read(boundApplication("target", {
        configuration: { image: RENDERER_IMAGE, image_digest: "sha256:target-record" },
      }));
      expect(target.identityFingerprint).toBe(current.identityFingerprint);
      expect(target.legacyIdentityFingerprint).toBe(current.legacyIdentityFingerprint);
    });

    it("does not record an application that mixes the two rollout sides", async () => {
      await expect(read(boundApplication("target", {
        configuration: { image: RENDERER_ROLLOUT.current_configuration.image },
      }))).rejects.toThrow(/did not converge/i);
    });

    it("records a completed rollout after Cloudflare clears active_rollout_id", async () => {
      const bound = await read(boundApplication("target"));
      for (const cleared of [undefined, null]) {
        const identity = await read(boundApplication("target", { active_rollout_id: cleared }));
        expect(identity.identityFingerprint).toBe(bound.identityFingerprint);
      }
    });

    it("does not bind a cleared active_rollout_id before the rollout completes", async () => {
      await expect(read(boundApplication("target", { active_rollout_id: null }), {
        rollout: { ...RENDERER_ROLLOUT, status: "progressing" },
      })).rejects.toThrow(/did not converge/i);
    });

    it("does not record a distribution with no instances", async () => {
      const rollout = {
        ...RENDERER_ROLLOUT,
        progress: {
          ...RENDERER_ROLLOUT.progress,
          updated_instances: 0,
          total_instances: 0,
          version_distribution: {
            target_version_instances: 0,
            current_version_instances: 0,
            target_version_percentage: 100,
          },
        },
      };
      await expect(read(boundApplication("current"), { rollout })).rejects.toThrow(/did not converge/i);
    });

    it("does not record a rollout that started before this commit's release", async () => {
      const lines = [];
      await expect(read(boundApplication("current"), {
        firestore: readyRendererFirestore("2026-09-22T16:00:00Z"),
        log: (line) => lines.push(line),
      })).rejects.toThrow("Renderer container rollout predates this renderer release");
      expect(lines).toEqual([
        "renderer rollout not converged status=completed steps=none:completed target=54 application=53 applied=100 after_release=no bound=yes instances=1/1",
      ]);
    });

    it("keeps the first release start of a commit through a retry and completion", async () => {
      let stored = null;
      const receiptDoc = { get: async () => ({ exists: stored !== null, data: () => stored }) };
      const firestore = {
        ...readyRendererFirestore(),
        doc: () => ({ ...readyRendererFirestore().doc(), protocol: true }),
        collection: () => ({ doc: () => receiptDoc }),
        runTransaction: async (work) => work({
          get: async ref => ref.protocol ? { exists: false } : receiptDoc.get(),
          set: (_ref, data) => { stored = structuredClone(data); },
        }),
      };
      const start = (sourceSha, runAttempt, at) => startReceipt(firestore, {
        component: "renderer",
        sourceSha,
        trustedWorkflowSha: "b".repeat(40),
        runId: "7",
        runAttempt,
        inputFingerprint: "c".repeat(64),
      }, { now: () => new Date(at) });
      // Attempt 1 deploys (rollout at 15:58:17) and stops before completion.
      await start(SOURCE, 1, "2026-09-22T15:00:00.000Z");
      // Attempt 2 deploys an unchanged container, so no new rollout starts.
      await start(SOURCE, 2, "2026-09-23T00:00:00.000Z");
      expect(stored.mutation.startedAt).toBe("2026-09-23T00:00:00.000Z");
      expect(stored.mutation.releaseStartedAt).toBe("2026-09-22T15:00:00.000Z");
      const recorded = await read(boundApplication("current"), { firestore });
      await completeReceipt(firestore, {
        component: "renderer",
        sourceSha: SOURCE,
        runId: "7",
        runAttempt: 2,
        providerIdentities: { applicationId: RENDERER_APP_ID },
      });
      const confirmed = await read(boundApplication("current"), { firestore });
      expect(confirmed.identityFingerprint).toBe(recorded.identityFingerprint);
      await start("d".repeat(40), 1, "2026-09-24T00:00:00.000Z");
      expect(stored.mutation.releaseStartedAt).toBe("2026-09-24T00:00:00.000Z");
    });

    it("accepts a first application without a rollout from an earlier release of the commit", async () => {
      const receipt = {
        state: "in_progress",
        mutation: { sourceSha: SOURCE, startedAt: "2026-09-23T00:00:00Z", releaseStartedAt: "2026-09-23T00:00:00Z" },
        lastComplete: { sourceSha: SOURCE, startedAt: "2026-09-22T15:00:00Z", releaseStartedAt: "2026-09-22T15:00:00Z" },
      };
      const application = {
        id: RENDERER_APP_ID,
        name: "njpbs-cms-preview-renderer",
        version: 1,
        created_at: "2026-09-22T15:30:00Z",
        configuration: { image: RENDERER_IMAGE },
      };
      const identity = await collectLiveIdentities("renderer", {
        firestore: readyRendererFirestore(undefined, receipt),
        cloudflareToken: "token",
        cloudflareAccount: "account",
        fetchFn: async (url) => {
          if (url.endsWith("/rollouts")) return cloudflareResult([]);
          if (url.endsWith("/deployments")) return cloudflareResult({ deployments: [{ id: "worker-deployment" }] });
          if (url.endsWith("/schedules")) return cloudflareResult({ schedules: [] });
          return cloudflareResult([application]);
        },
      });
      expect(identity.applicationId).toBe(RENDERER_APP_ID);
    });

    it("does not bound a receipt written before releaseStartedAt existed", async () => {
      // An older writer stored only the completing attempt's start, which can
      // follow the rollout when that retry started no new rollout.
      const legacy = { sourceSha: SOURCE, startedAt: "2026-09-23T00:00:00Z" };
      const receipt = { state: "complete", mutation: legacy, lastComplete: legacy };
      const identity = await read(boundApplication("current"), { firestore: readyRendererFirestore(undefined, receipt) });
      expect(identity.applicationId).toBe(RENDERER_APP_ID);
      const writes = [];
      await startReceipt({
        doc: () => ({ protocol: true }),
      collection: () => ({ doc: () => ({}) }),
        runTransaction: async (work) => work({
          get: async ref => ref.protocol ? { exists: false } : ({ exists: true, data: () => receipt }),
          set: (_ref, data) => { writes.push(data); },
        }),
      }, {
        component: "renderer",
        sourceSha: SOURCE,
        trustedWorkflowSha: "b".repeat(40),
        runId: "8",
        runAttempt: 1,
        inputFingerprint: "c".repeat(64),
      }, { now: () => new Date("2026-09-24T00:00:00.000Z") });
      expect(writes[0].mutation.releaseStartedAt).toBeNull();
    });

    it("stops when the renderer receipt belongs to another commit", async () => {
      const receipt = {
        mutation: { sourceSha: "b".repeat(40), startedAt: "2026-09-20T00:00:00Z", releaseStartedAt: "2026-09-20T00:00:00Z" },
      };
      await expect(read(boundApplication("current"), { firestore: readyRendererFirestore(undefined, receipt) }))
        .rejects.toThrow("Renderer receipt does not match the live renderer commit");
    });

    it("accepts a rollout from an earlier release of the same commit", async () => {
      const receipt = {
        state: "in_progress",
        mutation: { sourceSha: SOURCE, startedAt: "2026-09-23T00:00:00Z", releaseStartedAt: "2026-09-23T00:00:00Z" },
        lastComplete: { sourceSha: SOURCE, startedAt: "2026-09-22T15:00:00Z", releaseStartedAt: "2026-09-22T15:00:00Z" },
      };
      const identity = await read(boundApplication("current"), { firestore: readyRendererFirestore(undefined, receipt) });
      expect(identity.applicationId).toBe(RENDERER_APP_ID);
      const otherCommit = { ...receipt, lastComplete: { ...receipt.lastComplete, sourceSha: "b".repeat(40) } };
      await expect(read(boundApplication("current"), { firestore: readyRendererFirestore(undefined, otherCommit) }))
        .rejects.toThrow("Renderer container rollout predates this renderer release");
    });
  });

  it("accepts a new application with no rollout after the receipt started", async () => {
    const identity = await collectLiveIdentities("renderer", {
      firestore: readyRendererFirestore("2026-09-22T15:00:00Z"),
      cloudflareToken: "token",
      cloudflareAccount: "account",
      fetchFn: async (url) => {
        if (url.endsWith("/rollouts")) return cloudflareResult([]);
        if (url.endsWith("/deployments")) return cloudflareResult({ deployments: [{ id: "worker-deployment" }] });
        if (url.endsWith("/schedules")) return cloudflareResult({ schedules: [] });
        return cloudflareResult([{
          id: RENDERER_APP_ID,
          name: "njpbs-cms-preview-renderer",
          version: 1,
          created_at: "2026-09-22T15:01:00Z",
          configuration: { image: RENDERER_IMAGE },
        }]);
      },
    });
    expect(identity.applicationId).toBe(RENDERER_APP_ID);
  });

  it.each([
    ["old application", 1, "2026-09-22T14:00:00Z"],
    ["updated application", 2, "2026-09-22T15:01:00Z"],
  ])("rejects an %s with no rollout history", async (_case, version, createdAt) => {
    await expect(collectLiveIdentities("renderer", {
      firestore: readyRendererFirestore("2026-09-22T15:00:00Z"),
      cloudflareToken: "token",
      cloudflareAccount: "account",
      fetchFn: async (url) => url.endsWith("/rollouts")
        ? cloudflareResult([])
        : cloudflareResult([{
          id: RENDERER_APP_ID,
          name: "njpbs-cms-preview-renderer",
          version,
          created_at: createdAt,
          configuration: { image: RENDERER_IMAGE },
        }]),
    })).rejects.toThrow(/rollout is invalid/i);
  });

  it("uses one comparison when the confirm wrapper owns retries", async () => {
    let applicationReads = 0;
    await expect(collectLiveIdentities("renderer", {
      firestore: readyRendererFirestore(),
      cloudflareToken: "token",
      cloudflareAccount: "account",
      rolloutDeadlineMs: 0,
      sleep: async () => { throw new Error("must not sleep"); },
      fetchFn: async (url) => {
        if (url.endsWith("/rollouts")) return cloudflareResult([PARTIAL_ROLLOUT]);
        applicationReads += 1;
        return cloudflareResult([{
          id: RENDERER_APP_ID,
          name: "njpbs-cms-preview-renderer",
          version: 54,
          configuration: { image: "registry.cloudflare.com/preview:old" },
        }]);
      },
    })).rejects.toThrow(/did not converge/i);
    expect(applicationReads).toBe(1);
  });

  it.each([
    ["partial rollout", { image: "registry.cloudflare.com/preview:old" }, [PARTIAL_ROLLOUT], 54],
    ["instances left on the current version", { image: RENDERER_IMAGE }, [{
      ...RENDERER_ROLLOUT,
      progress: {
        ...RENDERER_ROLLOUT.progress,
        version_distribution: {
          target_version_instances: 1,
          current_version_instances: 1,
          target_version_percentage: 100,
        },
      },
    }], 54],
    ["unfinished latest rollout", { image: "registry.cloudflare.com/preview:old" }, [
      { ...RENDERER_ROLLOUT, created_at: "2026-09-22T15:00:00Z", target_configuration: { image: "registry.cloudflare.com/preview:old" } },
      { ...RENDERER_ROLLOUT, id: "newer", created_at: "2026-09-22T16:00:00Z", status: "progressing" },
    ], 54],
    ["unfinished rollout step", { image: RENDERER_IMAGE }, [{ ...RENDERER_ROLLOUT, steps: [{ status: "progressing" }] }], 54],
    ["missing target version", { image: RENDERER_IMAGE }, [{ ...RENDERER_ROLLOUT, target_version: undefined }], 64],
    ["missing instance distribution", { image: RENDERER_IMAGE }, [{
      ...RENDERER_ROLLOUT,
      progress: { total_steps: 1, current_step: 1, updated_instances: 1, total_instances: 1 },
    }], 54],
  ])("does not record a %s", async (_case, configuration, rollouts, version) => {
    let applicationReads = 0;
    let sleeps = 0;
    await expect(collectLiveIdentities("renderer", {
      firestore: readyRendererFirestore(),
      cloudflareToken: "token",
      cloudflareAccount: "account",
      rolloutDeadlineMs: 0,
      sleep: async () => { sleeps += 1; },
      fetchFn: async (url) => {
        if (url.endsWith("/rollouts")) return cloudflareResult(rollouts);
        applicationReads += 1;
        return cloudflareResult([{
          id: RENDERER_APP_ID,
          name: "njpbs-cms-preview-renderer",
          version,
          configuration,
        }]);
      },
    })).rejects.toThrow(/did not converge/i);
    expect(applicationReads).toBe(1);
    expect(sleeps).toBe(0);
  });

  it("stops at the rollout deadline and logs each non-converged read", async () => {
    let clock = 0;
    const lines = [];
    const sleeps = [];
    let applicationReads = 0;
    const line = "renderer rollout not converged status=progressing steps=1:progressing,2:pending target=54 application=53 applied=100 after_release=yes bound=no instances=1/1";
    await expect(collectLiveIdentities("renderer", {
      firestore: readyRendererFirestore(),
      cloudflareToken: "token",
      cloudflareAccount: "account",
      rolloutDeadlineMs: 6_000,
      now: () => clock,
      log: (entry) => lines.push(entry),
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      fetchFn: async (url) => {
        expect(url).not.toContain("token");
        if (url.endsWith("/rollouts")) {
          return cloudflareResult([{
            ...RENDERER_ROLLOUT,
            status: "progressing",
            steps: [{ id: 1, status: "progressing" }, { id: 2, status: "pending" }],
          }]);
        }
        applicationReads += 1;
        return cloudflareResult([{
          id: RENDERER_APP_ID,
          name: "njpbs-cms-preview-renderer",
          version: 53,
          configuration: { image: RENDERER_IMAGE },
        }]);
      },
    })).rejects.toThrow(/did not converge/i);
    expect(applicationReads).toBe(3);
    expect(sleeps).toEqual([5_000, 1_000]);
    expect(lines).toEqual([line, line, line]);
  });

  it.each(["reverted", "replaced"])("fails immediately when the latest rollout is %s", async (status) => {
    const lines = [];
    let applicationReads = 0;
    await expect(collectLiveIdentities("renderer", {
      firestore: readyRendererFirestore(),
      cloudflareToken: "token",
      cloudflareAccount: "account",
      rolloutDeadlineMs: 5 * 60 * 1000,
      log: (entry) => lines.push(entry),
      sleep: async () => { throw new Error("must not sleep"); },
      fetchFn: async (url) => {
        if (url.endsWith("/rollouts")) return cloudflareResult([{ ...RENDERER_ROLLOUT, status }]);
        applicationReads += 1;
        return cloudflareResult([{
          id: RENDERER_APP_ID,
          name: "njpbs-cms-preview-renderer",
          version: 54,
          configuration: { image: RENDERER_IMAGE },
        }]);
      },
    })).rejects.toThrow(`Renderer container rollout ${status}`);
    expect(applicationReads).toBe(1);
    expect(lines).toEqual([
      `renderer rollout not converged status=${status} steps=none:completed target=54 application=54 applied=100 after_release=yes bound=no instances=1/1`,
    ]);
  });

  it("keeps waiting when the rollout status is not a documented terminal failure", async () => {
    const lines = [];
    await expect(collectLiveIdentities("renderer", {
      firestore: readyRendererFirestore(),
      cloudflareToken: "token",
      cloudflareAccount: "account",
      rolloutDeadlineMs: 0,
      log: (entry) => lines.push(entry),
      sleep: async () => { throw new Error("must not sleep"); },
      fetchFn: async (url) => url.endsWith("/rollouts")
        ? cloudflareResult([{ ...RENDERER_ROLLOUT, status: "cancelled" }])
        : cloudflareResult([{
          id: RENDERER_APP_ID,
          name: "njpbs-cms-preview-renderer",
          version: 54,
          configuration: { image: RENDERER_IMAGE },
        }]),
    })).rejects.toThrow(/did not converge/i);
    expect(lines).toEqual([
      "renderer rollout not converged status=cancelled steps=none:completed target=54 application=54 applied=100 after_release=yes bound=no instances=1/1",
    ]);
  });

  it("rejects an empty renderer SHA", async () => {
    await expect(collectLiveIdentities("renderer", {
      firestore: {
        doc: () => ({
          get: async () => ({
            exists: true,
            data: () => ({ phase: "ready", rendererSha: "", serializerId: "cloudflare-preview" }),
          }),
        }),
      },
      cloudflareToken: "token",
      cloudflareAccount: "account",
      fetchFn: async () => { throw new Error("must not fetch"); },
    })).rejects.toThrow(/not ready/i);
  });

  it("binds a recorded renderer identity to the planned source", () => {
    expect(recordedIdentityMatchesSource("renderer", { rendererSha: SOURCE }, SOURCE)).toBe(true);
    expect(recordedIdentityMatchesSource("renderer", { rendererSha: "b".repeat(40) }, SOURCE)).toBe(false);
    expect(recordedIdentityMatchesSource("functions", {}, SOURCE)).toBe(true);
  });

  it("reads the live CMS API deployment and exact fully selected version", async () => {
    const identity = await collectLiveIdentities("cmsApi", {
      cloudflareToken: "token",
      cloudflareAccount: "account",
      fetchFn: async (url) => {
        expect(url).toContain("/workers/scripts/njpbs-cms-api/deployments");
        return {
          ok: true,
          json: async () => ({ result: { deployments: [{ id: "abc123", versions: [{ version_id: "55555555-5555-4555-8555-555555555555", percentage: 100 }] }] } }),
        };
      },
    });
    expect(identity).toEqual({ script: "njpbs-cms-api", deploymentId: "abc123", versionId: "55555555-5555-4555-8555-555555555555" });
  });
});

describe("CMS API Worker receipt", () => {
  function memoryFirestore(initial) {
    let stored = structuredClone(initial);
    const doc = { get: async () => ({ exists: Boolean(stored), data: () => structuredClone(stored) }) };
    return {
      read: () => stored,
      doc: () => ({ protocol: true }),
      collection: () => ({ doc: () => doc }),
      runTransaction: async (work) => work({ get: async ref => ref.protocol ? { exists: false } : doc.get(), set: (_ref, data) => { stored = structuredClone(data); } }),
    };
  }
  const inProgress = {
    schemaVersion: 1,
    component: "cmsApi",
    state: "in_progress",
    mutation: { sourceSha: SOURCE, runId: "7", runAttempt: 1, inputFingerprint: "c".repeat(64) },
    lastComplete: null,
  };
  const complete = (firestore, configurationFingerprint) => completeReceipt(firestore, {
    component: "cmsApi",
    sourceSha: SOURCE,
    runId: "7",
    runAttempt: 1,
    providerIdentities: { script: "njpbs-cms-api", deploymentId: "d1" },
    configurationFingerprint,
  }, { readPageReaderSource: async () => null }); // This fixture represents a retained API source without the v1 descriptor.

  it("records the secret configuration digest with the completed mutation", async () => {
    const firestore = memoryFirestore(inProgress);
    await complete(firestore, "e".repeat(64));
    expect(firestore.read().mutation.configurationFingerprint).toBe("e".repeat(64));
  });

  it("records no digest when none is supplied and rejects a malformed one", async () => {
    const firestore = memoryFirestore(inProgress);
    await complete(firestore, undefined);
    expect(firestore.read().mutation.configurationFingerprint).toBeNull();
    await expect(complete(memoryFirestore(inProgress), "not-a-digest")).rejects.toThrow("Configuration fingerprint is invalid");
  });

  it("digests the Worker secrets one way, independent of key order", () => {
    const secrets = { CMS_EDGE_ORIGIN_SECRET: "s".repeat(32), FIREBASE_WEB_API_KEY: "key" };
    const digest = configurationFingerprint(secrets);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toContain("sss");
    expect(configurationFingerprint({ FIREBASE_WEB_API_KEY: "key", CMS_EDGE_ORIGIN_SECRET: "s".repeat(32) })).toBe(digest);
    expect(configurationFingerprint({ ...secrets, CMS_EDGE_ORIGIN_SECRET: "t".repeat(32) })).not.toBe(digest);
    expect(() => configurationFingerprint({ CMS_EDGE_ORIGIN_SECRET: "" })).toThrow("Configuration is invalid");
  });

  it("records the edge-only digest on Functions receipts", async () => {
    const firestore = memoryFirestore({ ...inProgress, component: "functions" });
    const digest = "f".repeat(64);
    await completeReceipt(firestore, {
      component: "functions", sourceSha: SOURCE, runId: "7", runAttempt: 1,
      providerIdentities: { region: "us-central1", inventoryFingerprint: "e".repeat(64) },
      configurationFingerprint: digest,
    });
    expect(firestore.read().mutation.configurationFingerprint).toBe(digest);
    expect(firestore.read().lastComplete.configurationFingerprint).toBe(digest);
  });

  it("keeps Worker-only configuration out of the shared edge digest", () => {
    const secrets = { CMS_EDGE_ORIGIN_SECRET: "s".repeat(32), FIREBASE_WEB_API_KEY: "key" };
    const digest = edgeOriginSecretFingerprint(secrets);
    expect(digest).toBe(configurationFingerprint({ CMS_EDGE_ORIGIN_SECRET: "s".repeat(32) }));
    expect(edgeOriginSecretFingerprint({ ...secrets, FIREBASE_WEB_API_KEY: "other" })).toBe(digest);
    expect(edgeOriginSecretFingerprint({ ...secrets, CMS_EDGE_ORIGIN_SECRET: "t".repeat(32) })).not.toBe(digest);
    for (const secret of [undefined, "", "s".repeat(31)]) {
      expect(() => edgeOriginSecretFingerprint({ CMS_EDGE_ORIGIN_SECRET: secret })).toThrow("CMS edge origin secret is missing or invalid");
    }
  });

  it("refuses to complete a Functions receipt without its preflight digest", async () => {
    await expect(receiptCli(["complete", "--component", "functions", "--source-sha", SOURCE,
      "--run-id", "7", "--run-attempt", "1", "--live"])).rejects.toThrow("Functions configuration fingerprint is required");
  });

  async function runPlan(env, extraArgs = []) {
    const saved = { ...process.env };
    const writes = [];
    const write = process.stdout.write;
    process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
    try {
      Object.assign(process.env, env);
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      delete process.env.CMS_PREVIEW_FIREBASE_ACCOUNT;
      delete process.env.FIREBASE_SERVICE_ACCOUNT;
      delete process.env.GITHUB_OUTPUT;
      await receiptCli([
        "plan", "--component", "cmsApi", "--source-sha", SOURCE, "--trusted-workflow-sha", SOURCE, ...extraArgs,
      ]);
    } finally {
      process.stdout.write = write;
      process.env = saved;
    }
    return writes.join("");
  }

  it.each(["false", "true"])("rereads Worker plan inputs when they are unavailable (Functions changed=%s)", async functionsMutated => {
    const dir = mkdtempSync(join(tmpdir(), "cms-api-plan-"));
    const secretsFile = join(dir, "secrets.json");
    const secrets = { CMS_EDGE_ORIGIN_SECRET: "s".repeat(32), FIREBASE_WEB_API_KEY: "key" };
    writeFileSync(secretsFile, JSON.stringify(secrets));
    const output = await runPlan({
      FUNCTIONS_MUTATED: functionsMutated,
      CONFIGURATION_REQUIRES_RELEASE: "false",
      CMS_EDGE_ORIGIN_SECRET_FINGERPRINT: edgeOriginSecretFingerprint(secrets),
    }, ["--secrets-file", secretsFile, "--configuration-fingerprint-file", join(dir, "config.sha256")]);
    expect(output).toBe("mutated=true\nreason=plan_unavailable\n");
  });

  it("writes the secret digest for the receipt on a paired release", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cms-api-plan-"));
    const secretsFile = join(dir, "secrets.json");
    const digestFile = join(dir, "config.sha256");
    const secrets = { CMS_EDGE_ORIGIN_SECRET: "s".repeat(32), FIREBASE_WEB_API_KEY: "key" };
    writeFileSync(secretsFile, JSON.stringify(secrets));
    const output = await runPlan(
      { FUNCTIONS_MUTATED: "true", CONFIGURATION_REQUIRES_RELEASE: "true", CMS_EDGE_ORIGIN_SECRET_FINGERPRINT: edgeOriginSecretFingerprint(secrets) },
      ["--secrets-file", secretsFile, "--configuration-fingerprint-file", digestFile],
    );
    expect(output).toBe("mutated=true\nreason=paired_release\n");
    expect(readFileSync(digestFile, "utf8").trim()).toBe(configurationFingerprint(secrets));
  });
  it.each(["true", "false"])("fails closed on a partial rerun with a changed secret and functionsMutated=%s", async (functionsMutated) => {
    const dir = mkdtempSync(join(tmpdir(), "cms-api-plan-"));
    const secretsFile = join(dir, "secrets.json");
    const digestFile = join(dir, "config.sha256");
    const secrets = { CMS_EDGE_ORIGIN_SECRET: "s".repeat(32), FIREBASE_WEB_API_KEY: "key" };
    writeFileSync(secretsFile, JSON.stringify({ ...secrets, CMS_EDGE_ORIGIN_SECRET: "t".repeat(32) }));
    for (const digest of [edgeOriginSecretFingerprint(secrets), ""]) {
      await expect(runPlan({
        FUNCTIONS_MUTATED: functionsMutated,
        CONFIGURATION_REQUIRES_RELEASE: functionsMutated,
        CMS_EDGE_ORIGIN_SECRET_FINGERPRINT: digest,
      }, ["--secrets-file", secretsFile, "--configuration-fingerprint-file", digestFile]))
        .rejects.toThrow("CMS edge origin secret differs from the Functions release; rerun the full release");
    }
  });

  it("fails closed when Worker secrets cannot be read", async () => {
    await expect(runPlan({ FUNCTIONS_MUTATED: "true", CONFIGURATION_REQUIRES_RELEASE: "true" }))
      .rejects.toThrow("CMS API secret fingerprints could not be prepared");
  });

  it("does not expose malformed secret-file content in an error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cms-api-plan-"));
    const secretsFile = join(dir, "secrets.json");
    writeFileSync(secretsFile, "synthetic-private-content: invalid JSON");
    await expect(runPlan({ FUNCTIONS_MUTATED: "true" }, ["--secrets-file", secretsFile,
      "--configuration-fingerprint-file", join(dir, "config.sha256")]))
      .rejects.toThrow(/^CMS API secret fingerprints could not be prepared$/);
  });

});

it.each([undefined, [], [{ version_id: "55555555-5555-4555-8555-555555555555", percentage: 50 }],
  [{ version_id: "55555555-5555-4555-8555-555555555555", percentage: 100 }, { version_id: "66666666-6666-4666-8666-666666666666", percentage: 0 }]])(
  "refuses CMS API provider readback without one exact fully selected version: %j", async versions => {
    await expect(collectLiveIdentities("cmsApi", { cloudflareToken: "fixture-token", cloudflareAccount: "fixture-account",
      fetchFn: async () => ({ ok: true, json: async () => ({ result: { deployments: [{ id: "deployment", versions }] } }) }),
    })).rejects.toThrow("version identity");
  },
);
