// @vitest-environment node

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import {
  assertFullApexWorkerRoute,
  assertProductionFirestoreRouting,
  runPublicMediaLifecycleActivationOperator,
} from "../scripts/activate-public-media-lifecycle";

const WORKER_TOKEN = "w".repeat(40);
const ROUTE_TOKEN = "r".repeat(40);
const WORKER_TAG = "d".repeat(32);
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const DEPLOYMENT_ID = "33333333-3333-4333-8333-333333333333";
const ROUTE_ID = "a".repeat(32);
afterEach(() => vi.unstubAllEnvs());

function artifact() {
  const publication = {
    schemaVersion: 1 as const,
    digestAlgorithm: "sha256" as const,
    buildBatchId: "media-lifecycle-baseline",
    generation: 12,
    commitSha: "b".repeat(40),
    artifactDigest: "c".repeat(64),
    artifactReceiptDigest: "d".repeat(64),
    mediaManifestDigest: "e".repeat(64),
  };
  const body = `${JSON.stringify(publication, null, 2)}\n`;
  return {
    body,
    prepared: {
      ...publication,
      publicationReceiptDigest: createHash("sha256")
        .update(body)
        .digest("hex"),
      artifactFileCount: 2,
      artifactBytes: 1_000,
    },
  };
}

function workerList() {
  return {
    success: true,
    result: [{ id: "njpbs-production", tag: WORKER_TAG }],
  };
}

function trigger() {
  return {
    success: true,
    result: [{
      trigger_uuid: "11111111-1111-4111-8111-111111111111",
      external_script_id: WORKER_TAG,
      deploy_command: "npx wrangler versions upload --config workers/wrangler.jsonc",
      root_directory: "/",
      branch_includes: ["production"],
      branch_excludes: [],
    }],
  };
}

function routes(
  script = "njpbs-production",
  additionalRoutes: Array<Record<string, unknown>> = [],
) {
  return {
    success: true,
    result: [
      {
        id: ROUTE_ID,
        pattern: "https://njpbs.org/*",
        script,
      },
      ...additionalRoutes,
    ],
  };
}

function deployments(
  deploymentId = DEPLOYMENT_ID,
  versionId = VERSION_ID,
) {
  return {
    success: true,
    result: {
      deployments: [{
        id: deploymentId,
        source: "api",
        strategy: "percentage",
        annotations: { "workers/triggered_by": "deployment" },
        versions: [{ version_id: versionId, percentage: 100 }],
        created_on: "2026-09-02T20:01:00.000Z",
      }],
    },
  };
}

function exactRequestJson(deploymentResponses = [deployments(), deployments()]) {
  let deploymentRead = 0;
  return vi.fn(async ({ url, token }: { url: string; token: string }) => {
    if (url.endsWith("/workers/routes")) {
      expect(url).toBe(`https://api.cloudflare.com/client/v4/zones/${"b".repeat(32)}/workers/routes`);
      expect(token).toBe(ROUTE_TOKEN);
      return routes();
    }
    expect(token).toBe(WORKER_TOKEN);
    if (url.endsWith("/workers/scripts")) return workerList();
    if (url.endsWith("/triggers")) return trigger();
    if (url.endsWith("/deployments")) {
      return deploymentResponses[deploymentRead++];
    }
    throw new Error(`Unexpected request ${url}`);
  });
}

describe("public media lifecycle activation operator", () => {
  it.each(["", "REPLACE_ME", "b".repeat(31), `${"b".repeat(32)}\n`])("refuses an unconfigured zone before provider access (%#)", async zone => {
    vi.stubEnv("CLOUDFLARE_PUBLIC_ZONE_ID", zone);
    const requestJson = vi.fn();
    const activateFn = vi.fn();
    await expect(runPublicMediaLifecycleActivationOperator({
      firestore: {} as Firestore, cloudflareWorkerApiToken: WORKER_TOKEN,
      cloudflareRouteApiToken: ROUTE_TOKEN, preparedArtifact: artifact().prepared,
      requestJson, activateFn,
    })).rejects.toThrow("CLOUDFLARE_PUBLIC_ZONE_ID must be configured");
    expect(requestJson).not.toHaveBeenCalled();
    expect(activateFn).not.toHaveBeenCalled();
  });
  it("binds two exact provider and root observations to the activation proof", async () => {
    const { body, prepared } = artifact();
    const activateFn = vi.fn(async ({ proof }) => ({
      idempotent: false,
      receipt: { ...proof, activatedAt: {} },
    }));
    const requestJson = exactRequestJson();
    const requestPublication = vi.fn(async (_url: string) => body);

    const result = await runPublicMediaLifecycleActivationOperator({
      firestore: {} as Firestore,
      cloudflareWorkerApiToken: WORKER_TOKEN,
      cloudflareRouteApiToken: ROUTE_TOKEN,
      preparedArtifact: prepared,
      requestJson,
      requestPublication,
      activateFn,
    });

    expect(result.idempotent).toBe(false);
    expect(activateFn).toHaveBeenCalledWith({
      firestore: {},
      proof: {
        schemaVersion: 1,
        buildBatchId: prepared.buildBatchId,
        generation: prepared.generation,
        commitSha: prepared.commitSha,
        deploymentId: DEPLOYMENT_ID,
        versionId: VERSION_ID,
        publicationReceiptDigest: prepared.publicationReceiptDigest,
        publicReceiptUrl: "https://njpbs.org/_publication.json",
      },
    });
    expect(requestPublication).toHaveBeenCalledTimes(2);
    for (const [url] of requestPublication.mock.calls) {
      const probe = new URL(url);
      expect(probe.origin + probe.pathname)
        .toBe("https://njpbs.org/_publication.json");
      expect(probe.searchParams.get("candidate"))
        .toBe(prepared.buildBatchId);
      expect(probe.searchParams.get("version")).toBe(VERSION_ID);
    }
  });

  it("validates the separate route-read credential before provider reads", async () => {
    const { prepared } = artifact();
    const requestJson = vi.fn();

    await expect(runPublicMediaLifecycleActivationOperator({
      firestore: {} as Firestore,
      cloudflareWorkerApiToken: WORKER_TOKEN,
      cloudflareRouteApiToken: "invalid",
      preparedArtifact: prepared,
      requestJson,
    })).rejects.toThrow(/Cloudflare credential input is invalid/i);
    expect(requestJson).not.toHaveBeenCalled();
  });

  it("refuses a missing full-apex route", () => {
    expect(() => assertFullApexWorkerRoute(routes("another-worker")))
      .toThrow(/full apex Worker route is not active/i);
  });

  it("refuses every additional route that can override the apex artifact", () => {
    for (const conflict of [
      {
        id: "b".repeat(32),
        pattern: "https://njpbs.org/media/*",
        script: "media-worker",
      },
      {
        id: "c".repeat(32),
        pattern: "njpbs.org/private/*",
        script: null,
      },
      {
        id: "d".repeat(32),
        pattern: "*://njpbs.org/special/*",
        script: "special-worker",
      },
      {
        id: "e".repeat(32),
        pattern: "*njpbs.org/legacy/*",
        script: "legacy-worker",
      },
    ]) {
      expect(() => assertFullApexWorkerRoute(routes(
        "njpbs-production",
        [conflict],
      ))).toThrow(/another apex Worker route overlaps/i);
    }

    expect(assertFullApexWorkerRoute(routes("njpbs-production", [{
      id: "f".repeat(32),
      pattern: "https://www.njpbs.org/*",
      script: "www-redirect",
    }]))).toBe(ROUTE_ID);
    expect(assertFullApexWorkerRoute(routes("njpbs-production", [{
      id: "1".repeat(32),
      pattern: "*.njpbs.org/*",
      script: "subdomain-worker",
    }]))).toBe(ROUTE_ID);
  });

  it("refuses when the active deployment changes between observations", async () => {
    const { body, prepared } = artifact();
    const activateFn = vi.fn();

    await expect(runPublicMediaLifecycleActivationOperator({
      firestore: {} as Firestore,
      cloudflareWorkerApiToken: WORKER_TOKEN,
      cloudflareRouteApiToken: ROUTE_TOKEN,
      preparedArtifact: prepared,
      requestJson: exactRequestJson([
        deployments(),
        deployments("44444444-4444-4444-8444-444444444444"),
      ]),
      requestPublication: vi.fn(async (_url: string) => body),
      activateFn,
    })).rejects.toThrow(/changed during activation proof/i);
    expect(activateFn).not.toHaveBeenCalled();
  });

  it("rejects any Firestore emulator environment key", () => {
    expect(() => assertProductionFirestoreRouting({
      FIRESTORE_EMULATOR_HOST: "",
    })).toThrow(/emulator route is not allowed/i);
  });
});
