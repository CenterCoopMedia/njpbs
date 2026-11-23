import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getContainer: vi.fn(),
  readPublicationWork: vi.fn(),
  publishWithdrawalCatalog: vi.fn(),
  publishPageWithdrawalCatalog: vi.fn(),
  publishRecordWithdrawalCatalog: vi.fn(),
}));

vi.mock("@cloudflare/containers", () => ({
  Container: class {
    env: unknown;
    constructor(_ctx?: unknown, env = { PUBLIC_SHARE_INTAKE_ENDPOINT: "" }) { this.env = env; }
  },
  getContainer: mocks.getContainer,
}));
vi.mock("./wake", () => ({ PublicationWake: class {} }));
vi.mock("./pending-work", () => ({
  readNoBuildPublicationWork: mocks.readPublicationWork,
}));
vi.mock("./withdrawal-catalog", () => ({ publishWithdrawalCatalog: mocks.publishWithdrawalCatalog }));
vi.mock("./page-withdrawal-catalog", () => ({ publishPageWithdrawalCatalog: mocks.publishPageWithdrawalCatalog }));
vi.mock("./record-withdrawal-catalog", () => ({ publishRecordWithdrawalCatalog: mocks.publishRecordWithdrawalCatalog }));

import worker, { PublicationRuntime } from "./worker";
import { publicationTarget } from "../functions/lib/publication-target.js";

const COMMIT_SHA = "a".repeat(40);
const NOW = Date.parse("2026-09-10T20:00:00.000Z");

const environment = (enabled = "true") => ({
  CMS_DEPLOYMENT_ENVIRONMENT: "production",
  PUBLICATION_ENABLED: enabled,
  PUBLICATION_COMMIT_SHA: COMMIT_SHA,
  PUBLICATION_SERIALIZER_ID: "cloudflare-publisher",
  FIREBASE_SERVICE_ACCOUNT: "private-firebase-account",
  R2_PUBLICATION_CREDENTIAL: "private-publication-credential",
  R2_PREVIEW_CREDENTIAL: "private-preview-credential",
  ACTIVATION_TOKEN: "private-activation-token",
  PUBLIC_GA4_MEASUREMENT_ID: "G-TEST",
  PUBLIC_REPORT_ENDPOINT: "https://example.test/report",
  PUBLIC_SHARE_INTAKE_ENDPOINT: "https://example.test/intake",
  PUBLIC_TURNSTILE_SITEKEY: "public-site-key",
  PUBLISHER: { binding: true },
});

function runtimeFixture(enabled = "true") {
  const env = environment(enabled);
  const storage = {
    get: vi.fn(),
    put: vi.fn(async () => undefined),
  };
  const stop = vi.fn(async () => undefined);
  const containerFetch = vi.fn();
  const runtime = Object.create(PublicationRuntime.prototype) as {
    check(): Promise<void>;
    health(): Promise<boolean>;
  };
  Object.assign(runtime, {
    env,
    ctx: { storage },
    stop,
    containerFetch,
  });
  return { runtime, env, storage, stop, containerFetch };
}

async function fetchWorker(request: Request, env = environment()) {
  return (worker.fetch as Function)(request, env, {});
}

beforeEach(() => {
  mocks.getContainer.mockReset();
  mocks.readPublicationWork.mockReset();
  mocks.publishWithdrawalCatalog.mockReset().mockResolvedValue(undefined);
  mocks.publishPageWithdrawalCatalog.mockReset().mockResolvedValue(undefined);
  mocks.publishRecordWithdrawalCatalog.mockReset().mockResolvedValue(undefined);
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("cloud publisher runtime health", () => {
  it("publishes durable catalogs on the dev check using the existing R2 binding", async () => {
    const fixture = runtimeFixture();
    fixture.env.CMS_DEPLOYMENT_ENVIRONMENT = "development";
    fixture.env.PUBLICATION_SERIALIZER_ID = "cloudflare-dev-publisher";
    mocks.readPublicationWork.mockResolvedValue({ needsRuntime: false, healthy: true });
    await fixture.runtime.check();
    expect(mocks.publishWithdrawalCatalog).toHaveBeenCalledOnce();
    expect(mocks.publishPageWithdrawalCatalog).toHaveBeenCalledWith({ store: undefined,
      target: publicationTarget("development"), account: fixture.env.FIREBASE_SERVICE_ACCOUNT, commitSha: COMMIT_SHA });
    expect(fixture.storage.put).toHaveBeenCalledWith("health", expect.objectContaining({ healthy: true }));
  });
  it.each(["Page", "record"] as const)("retains recovery but marks dev health unhealthy when the %s catalog cannot persist", async family => {
    const fixture = runtimeFixture();
    fixture.env.CMS_DEPLOYMENT_ENVIRONMENT = "development";
    mocks.readPublicationWork.mockResolvedValue({ needsRuntime: false, healthy: true });
    (family === "Page" ? mocks.publishPageWithdrawalCatalog : mocks.publishRecordWithdrawalCatalog).mockRejectedValue(new Error("Fixture failure"));
    await fixture.runtime.check();
    expect(mocks.readPublicationWork).toHaveBeenCalledOnce();
    expect(fixture.storage.put).toHaveBeenCalledWith("health", expect.objectContaining({ healthy: false,
      diagnostics: { reasons: ["withdrawal_catalog_unavailable"], oldestDueAt: null } }));
  });
  it("still publishes Page markers when the independent Post catalog refuses", async () => {
    const fixture = runtimeFixture();
    fixture.env.CMS_DEPLOYMENT_ENVIRONMENT = "development";
    mocks.readPublicationWork.mockResolvedValue({ needsRuntime: false, healthy: true });
    mocks.publishWithdrawalCatalog.mockRejectedValue(new Error("Fixture Post failure"));
    await fixture.runtime.check();
    expect(mocks.publishPageWithdrawalCatalog).toHaveBeenCalledOnce();
    expect(fixture.storage.put).toHaveBeenCalledWith("health", expect.objectContaining({ healthy: false }));
  });
  it("defaults an empty share endpoint for the container", () => {
    expect(new PublicationRuntime().envVars.PUBLIC_SHARE_INTAKE_ENDPOINT).toBe("https://intake.njpbs.org");
  });
  it.each(["production", "development"])("forwards %s account and upload settings into a real container process", target => {
    const account = "b".repeat(32);
    const workerTag = "d".repeat(32);
    const origin = "https://uploads.example.test";
    const bindings = { ...environment(), CMS_DEPLOYMENT_ENVIRONMENT: target, CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_PUBLIC_WORKER_TAG: workerTag,
      PUBLIC_SHARE_PAGE: "1", PUBLIC_SHARE_UPLOAD_ORIGIN: origin };
    const runtime = new PublicationRuntime({} as DurableObjectState, bindings as unknown as Env);
    bindings.CLOUDFLARE_ACCOUNT_ID = "c".repeat(32);
    bindings.CLOUDFLARE_PUBLIC_WORKER_TAG = "e".repeat(32);
    bindings.PUBLIC_SHARE_UPLOAD_ORIGIN = "https://changed.example.test";
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("../site/node_modules/tsx/dist/cli.mjs", import.meta.url)), "--eval",
      'import { cloudflareR2Endpoint, cloudflarePublicWorkerTag } from "./site/scripts/cloudflare-account.mjs"; ' +
      'import { SHARE_UPLOAD_ORIGIN, resolveShareUploadOrigin } from "./packages/content-core/src/share-upload-origin.ts"; ' +
      'process.stdout.write(JSON.stringify({ endpoint: cloudflareR2Endpoint(), workerTag: cloudflarePublicWorkerTag(), origin: SHARE_UPLOAD_ORIGIN, ' +
      'enabledOrigin: resolveShareUploadOrigin(process.env.PUBLIC_SHARE_UPLOAD_ORIGIN, process.env.PUBLIC_SHARE_PAGE === "1") }));',
    ], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 5_000,
      env: { PATH: process.env.PATH, ...runtime.envVars } });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ endpoint: `https://${account}.r2.cloudflarestorage.com`,
      workerTag, origin, enabledOrigin: origin });
  });
  it("does not start the container when the ready publisher is idle", async () => {
    const fixture = runtimeFixture();
    mocks.readPublicationWork.mockResolvedValue({
      needsRuntime: false,
      healthy: true,
    });

    await fixture.runtime.check();

    expect(mocks.readPublicationWork).toHaveBeenCalledWith({
      account: fixture.env.FIREBASE_SERVICE_ACCOUNT,
      commitSha: COMMIT_SHA,
      serializerId: fixture.env.PUBLICATION_SERIALIZER_ID,
      target: publicationTarget(),
    });
    expect(fixture.containerFetch).not.toHaveBeenCalled();
    expect(fixture.stop).not.toHaveBeenCalled();
    expect(fixture.storage.put).toHaveBeenCalledWith("health", {
      healthy: true,
      checkedAt: NOW,
      commitSha: COMMIT_SHA,
    });
  });

  it("stops a disabled publisher without checking work or starting the container", async () => {
    const fixture = runtimeFixture("false");

    await fixture.runtime.check();

    expect(fixture.stop).toHaveBeenCalledOnce();
    expect(mocks.readPublicationWork).not.toHaveBeenCalled();
    expect(mocks.publishWithdrawalCatalog).not.toHaveBeenCalled();
    expect(fixture.containerFetch).not.toHaveBeenCalled();
    expect(fixture.storage.put).toHaveBeenCalledWith("health", {
      healthy: false,
      checkedAt: NOW,
      commitSha: COMMIT_SHA,
    });
  });

  it("starts and validates the container only when recovery needs runtime", async () => {
    const fixture = runtimeFixture();
    mocks.readPublicationWork.mockResolvedValue({
      needsRuntime: true,
      healthy: true,
    });
    fixture.containerFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "ready",
          commitSha: COMMIT_SHA,
          serializerId: fixture.env.PUBLICATION_SERIALIZER_ID,
        }),
      ),
    );

    await fixture.runtime.check();

    expect(fixture.containerFetch).toHaveBeenCalledWith(
      "http://container/wake", { method: "POST" },
    );
    expect(fixture.storage.put).toHaveBeenCalledWith(
      "health",
      expect.objectContaining({ healthy: true }),
    );
  });

  it.each([
    [503, JSON.stringify({ status: "starting" })],
    [502, "Container proxy unavailable"],
  ])("releases a body-bearing HTTP %s wake response before reporting unavailable", async (status, payload) => {
    const fixture = runtimeFixture();
    mocks.readPublicationWork.mockResolvedValue({ needsRuntime: true, healthy: true });
    let released = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
        released = true;
      },
      cancel() { released = true; },
    }, { highWaterMark: 0 });
    fixture.containerFetch.mockResolvedValue(new Response(body, { status }));

    await fixture.runtime.check();

    expect(released).toBe(true);
    expect(fixture.storage.put).toHaveBeenCalledWith("health", {
      healthy: false, checkedAt: NOW, commitSha: COMMIT_SHA,
    });
  });

  it("rejects a stale persisted health result", async () => {
    const fixture = runtimeFixture();
    fixture.storage.get.mockResolvedValue({
      healthy: true,
      checkedAt: NOW - 150_000,
      commitSha: COMMIT_SHA,
    });

    await expect(fixture.runtime.health()).resolves.toBe(false);
  });
  it("reports durable catalog refusal after recovering accepted work without exposing its error", async () => {
    const fixture = runtimeFixture();
    mocks.readPublicationWork.mockResolvedValue({ needsRuntime: true, healthy: true,
      diagnostics: { reasons: [], oldestDueAt: 1234 } });
    fixture.containerFetch.mockResolvedValue(new Response(JSON.stringify({
      status: "ready", commitSha: COMMIT_SHA, serializerId: fixture.env.PUBLICATION_SERIALIZER_ID,
    })));
    mocks.publishWithdrawalCatalog.mockRejectedValue(new Error("private-provider-detail"));
    await fixture.runtime.check();
    expect(fixture.containerFetch).toHaveBeenCalledOnce();
    expect(fixture.storage.put).toHaveBeenCalledWith("health", {
      healthy: false, checkedAt: NOW, commitSha: COMMIT_SHA,
      diagnostics: { reasons: ["withdrawal_catalog_unavailable"], oldestDueAt: 1234 },
    });
    expect(console.error).toHaveBeenCalledWith("Durable withdrawal catalog publication failed");
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining("private-provider-detail"));
  });
  it("rejects a future observer timestamp instead of extending its freshness", async () => {
    const fixture = runtimeFixture();
    fixture.storage.get.mockResolvedValue({ healthy: true, checkedAt: NOW + 1, commitSha: COMMIT_SHA });
    await expect(fixture.runtime.health()).resolves.toBe(false);
  });
  it("keeps a successful process response unhealthy while durable recovery is overdue", async () => {
    const fixture = runtimeFixture();
    mocks.readPublicationWork.mockResolvedValue({ needsRuntime: true, healthy: false });
    fixture.containerFetch.mockResolvedValue(new Response(JSON.stringify({
      status: "ready", commitSha: COMMIT_SHA, serializerId: fixture.env.PUBLICATION_SERIALIZER_ID,
    })));
    await fixture.runtime.check();
    expect(fixture.storage.put).toHaveBeenCalledWith("health", {
      healthy: false, checkedAt: NOW, commitSha: COMMIT_SHA,
    });
  });
});

describe("cloud publisher public health endpoint", () => {
  it("returns only aggregate GET and HEAD health without launch or credentials", async () => {
    const health = vi.fn(async () => true);
    const check = vi.fn();
    const containerFetch = vi.fn();
    mocks.getContainer.mockReturnValue({ health, check, containerFetch });
    const env = environment();

    const get = await fetchWorker(
      new Request("https://publisher.example/health"),
      env,
    );
    expect(get.status).toBe(200);
    expect(get.headers.get("Cache-Control")).toBe("no-store");
    const getBody = await get.text();
    expect(JSON.parse(getBody)).toEqual({ status: "ok" });

    const head = await fetchWorker(
      new Request("https://publisher.example/health", { method: "HEAD" }),
      env,
    );
    expect(head.status).toBe(200);
    const headBody = await head.text();
    expect(headBody).toBe("");
    expect(health).toHaveBeenCalledTimes(2);
    expect(check).not.toHaveBeenCalled();
    expect(containerFetch).not.toHaveBeenCalled();
    expect(mocks.publishWithdrawalCatalog).not.toHaveBeenCalled();
    const publicBodies = `${getBody} ${headBody}`;
    for (const value of Object.values(env)) {
      if (typeof value === "string" && value.startsWith("private-")) {
        expect(publicBodies).not.toContain(value);
      }
    }
  });

  it("returns 404 for every other public request without opening the runtime", async () => {
    for (const request of [
      new Request("https://publisher.example/health", { method: "POST" }),
      new Request("https://publisher.example/"),
      new Request("https://publisher.example/health?queue=secret"),
    ]) {
      await expect(fetchWorker(request)).resolves.toMatchObject({
        status: 404,
      });
    }
    expect(mocks.getContainer).not.toHaveBeenCalled();
  });

  it("maps unavailable or stale aggregate health to HTTP 503", async () => {
    const health = vi.fn(async () => false);
    mocks.getContainer.mockReturnValue({ health });

    const response = await fetchWorker(
      new Request("https://publisher.example/health"),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

it("accepts only the authenticated current-release wake without exposing it through public health", async () => {
  const check = vi.fn(async () => undefined);
  mocks.getContainer.mockReturnValue({ check });
  const env = { ...environment(), PUBLICATION_WAKE_TOKEN: "x".repeat(32) };
  const wake = (token: string, release = COMMIT_SHA, target = "production") => new Request("https://publisher-health.njpbs.org/wake", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "x-publication-release": release, "x-publication-target": target },
  });
  expect((await fetchWorker(wake("wrong"), env)).status).toBe(403);
  expect((await fetchWorker(wake(env.PUBLICATION_WAKE_TOKEN, "b".repeat(40)), env)).status).toBe(403);
  expect((await fetchWorker(wake(env.PUBLICATION_WAKE_TOKEN, COMMIT_SHA, "development"), env)).status).toBe(403);
  expect(check).not.toHaveBeenCalled();
  expect((await fetchWorker(wake(env.PUBLICATION_WAKE_TOKEN), env)).status).toBe(204);
  expect((await fetchWorker(wake(env.PUBLICATION_WAKE_TOKEN), env)).status).toBe(204);
  expect(check).toHaveBeenCalledTimes(2);
});

it.each(["running", "healthy"])("extends an already-active busy operation in the SDK's %s state", async status => {
  const fixture = runtimeFixture();
  const renew = vi.fn(async () => undefined);
  const getState = vi.fn(async () => ({ status: "stopped" }));
  Object.assign(fixture.runtime, { getState, renewActivityTimeout: renew });
  const expire = () => PublicationRuntime.prototype.onActivityExpired.call(fixture.runtime as never);
  await expire();
  expect(fixture.containerFetch).not.toHaveBeenCalled();
  expect(fixture.stop).toHaveBeenCalledOnce();
  getState.mockResolvedValue({ status });
  fixture.containerFetch.mockResolvedValue(new Response(JSON.stringify({ commitSha: COMMIT_SHA,
    serializerId: "cloudflare-publisher", busy: true })));
  await expire();
  expect(renew).toHaveBeenCalledOnce();
  fixture.containerFetch.mockResolvedValue(new Response(JSON.stringify({ commitSha: COMMIT_SHA,
    serializerId: "cloudflare-publisher", busy: false })));
  await expire();
  expect(fixture.stop).toHaveBeenCalledTimes(2);
});
