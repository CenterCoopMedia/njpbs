import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { afterEach, beforeEach, expect, it } from "vitest";
import { prepareCloudPublicationWake } from "../../scripts/prepare-cloud-publication-wake.mjs";
const { readCloudPublicationWakeDeployment, CLOUD_WAKE_FUNCTIONS } = createRequire(import.meta.url)("../../functions/lib/cloud-publication-wake-deployment.js");
let directory: string;
let path: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "cloud-wake-deployment-")); path = join(directory, "decision.json"); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
it("makes missing and malformed deployment decisions inactive despite a shell flag", async () => {
  const env = { GCLOUD_PROJECT: "njpbs-site", CMS_PUBLICATION_CLOUD_WAKE: "true" };
  expect(readCloudPublicationWakeDeployment({ path, env }).enabled).toBe(false);
  for (const raw of ["not-json", "null", "[]", JSON.stringify({ schemaVersion: 1, environment: "production", enabled: "true" }),
    JSON.stringify({ schemaVersion: 1, environment: "production", enabled: true, extra: true })]) {
    await writeFile(path, raw);
    expect(readCloudPublicationWakeDeployment({ path, env }).enabled).toBe(false);
  }
});
it.each([["production", "njpbs-site"], ["development", "njpbs-site-dev"]])(
  "uses one exact decision in discovery and runtime for %s", async (environment, projectId) => {
    await prepareCloudPublicationWake({ environment, enabled: true, path });
    const discovery = readCloudPublicationWakeDeployment({ path, env: { GCLOUD_PROJECT: projectId } });
    const runtime = readCloudPublicationWakeDeployment({ path, env: { GCLOUD_PROJECT: projectId,
      CMS_PUBLICATION_CLOUD_WAKE: "false", CMS_DEPLOYMENT_ENVIRONMENT: "opposite" } });
    expect(discovery).toEqual({ enabled: true, environment });
    expect(runtime).toEqual(discovery);
    expect(readCloudPublicationWakeDeployment({ path, env: { GCLOUD_PROJECT: projectId === "njpbs-site" ? "njpbs-site-dev" : "njpbs-site" } }).enabled).toBe(false);
    expect(readCloudPublicationWakeDeployment({ path, env: {} }).enabled).toBe(false);
    await prepareCloudPublicationWake({ environment, enabled: false, path });
    expect(readCloudPublicationWakeDeployment({ path, env: { GCLOUD_PROJECT: projectId } }).enabled).toBe(false);
  });
it("refuses an unknown environment or a non-boolean producer flag", async () => {
  await expect(prepareCloudPublicationWake({ environment: "staging", enabled: true, path })).rejects.toThrow();
  await expect(prepareCloudPublicationWake({ environment: undefined, enabled: true, path })).rejects.toThrow();
  await expect(prepareCloudPublicationWake({ environment: "production", enabled: "true", path })).rejects.toThrow();
});
it("packages public decisions readable by the runtime UID and repairs owner-only rewrites", async () => {
  await prepareCloudPublicationWake({ environment: "production", enabled: true, path });
  expect((await stat(path)).mode & 0o777).toBe(0o644);
  await chmod(path, 0o600);
  await prepareCloudPublicationWake({ environment: "production", enabled: false, path });
  expect((await stat(path)).mode & 0o777).toBe(0o644);
  expect(readCloudPublicationWakeDeployment({ path, env: { GCLOUD_PROJECT: "njpbs-site" } }).enabled).toBe(false);
});

it("rewrites an enabled decision and then disables it without a live write", async () => {
  await prepareCloudPublicationWake({ environment: "production", enabled: true, path });
  await prepareCloudPublicationWake({ environment: "production", enabled: true, path });
  expect(readCloudPublicationWakeDeployment({ path, env: { GCLOUD_PROJECT: "njpbs-site" } })).toEqual({
    enabled: true, environment: "production",
  });
  await prepareCloudPublicationWake({ environment: "production", enabled: false, path });
  expect(readCloudPublicationWakeDeployment({ path, env: { GCLOUD_PROJECT: "njpbs-site" } }).enabled).toBe(false);
  expect(readCloudPublicationWakeDeployment({ path: join(directory, "missing.json"), env: { GCLOUD_PROJECT: "njpbs-site" } }).enabled).toBe(false);
});
it("includes dev wake handlers only for an enabled development decision", () => {
  const { devFunctionManifest, DEV_FUNCTIONS } = createRequire(import.meta.url)("../../functions/dev-manifest.js");
  const absent = devFunctionManifest({ enabled: false, environment: "development" });
  const wrongTarget = devFunctionManifest({ enabled: true, environment: "production" });
  const enabled = devFunctionManifest({ enabled: true, environment: "development" });
  expect(Object.keys(absent)).toEqual(Object.keys(DEV_FUNCTIONS));
  expect(Object.keys(wrongTarget)).toEqual(Object.keys(DEV_FUNCTIONS));
  for (const name of CLOUD_WAKE_FUNCTIONS) {
    expect(Object.keys(DEV_FUNCTIONS)).not.toContain(name);
    expect(enabled[name]).toBe("./no-build-cloud-wake");
  }
});
it("binds wake handlers to the named secret and min zero max two", () => {
  const wake = createRequire(import.meta.url)("../../functions/no-build-cloud-wake.js");
  for (const name of CLOUD_WAKE_FUNCTIONS) {
    const endpoint = wake[name].__endpoint;
    expect(endpoint.minInstances).toBe(0);
    expect(endpoint.maxInstances).toBe(2);
    expect(endpoint.secretEnvironmentVariables.map((secret: { key: string }) => secret.key)).toContain("CMS_PUBLICATION_WAKE_TOKEN");
  }
});
