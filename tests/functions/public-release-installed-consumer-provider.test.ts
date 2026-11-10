import { expect, it, vi } from "vitest";
import { createInstalledConsumerProvider } from "../../site/scripts/public-release-installed-consumer-provider";
import consumers from "../../functions/lib/public-release-installed-consumers.js";
import protocol from "../../functions/lib/public-release-pair.js";
const project = "njpbs-site-dev", nonce = "a".repeat(64);
const files = consumers.INSTALLED_CONSUMER_FILES.map(path => ({ path, sha256: "c".repeat(64) }));
const probe = { schemaVersion: 2, kind: "public-release-installed-consumers", nonce, revision: "cmsgetpublicpage-00001-abc",
  files, sourceDigest: protocol.publicReleaseDigest(files), flags: { PUBLIC_RELEASE_READERS_ENABLED: true, PUBLIC_RELEASE_COMPOSED_READERS_ENABLED: true } };
function row() {
  return { name: `projects/${project}/locations/us-central1/functions/cmsGetPublicPage`, state: "ACTIVE", environment: "GEN_2",
    updateTime: "2026-10-29T00:00:00Z", buildConfig: { runtime: "nodejs22", entryPoint: "cmsGetPublicPage",
      source: { storageSource: { bucket: "fixture-sources", object: "source.tar.gz", generation: "7", sourceUploadUrl: "fixture-upload-url-canary" } } },
    serviceConfig: { uri: "https://fixture.run.app", revision: "cmsgetpublicpage-00001-abc", service: "fixture-service",
      allTrafficOnLatestRevision: true, environmentVariables: { PRIVATE_FIXTURE_VALUE: "fixture-private-value-canary" },
      secretEnvironmentVariables: [{ key: "CMS_EDGE_ORIGIN_SECRET", secret: "CMS_EDGE_ORIGIN_SECRET", version: "7", projectId: project }] } };
}
it("uses only closed read paths, reads credentials at use, and discards environment values and signed URLs", async () => {
  const credentials = vi.fn(async () => "fixture-google-token"), calls: { url: string; init?: RequestInit }[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push({ url: url.href, init });
    expect(init?.redirect).toBe("error"); expect(init?.cache).toBe("no-store");
    if (url.hostname === "cloudfunctions.googleapis.com") return Response.json({ functions: [row()] });
    if (url.hostname === "secretmanager.googleapis.com") {
      expect(url.pathname).toBe(`/v1/projects/${project}/secrets/CMS_EDGE_ORIGIN_SECRET/versions/7:access`);
      return Response.json({ payload: { data: Buffer.from("fixture-edge-only").toString("base64") } });
    }
    expect(url.href).toBe(`https://us-central1-${project}.cloudfunctions.net/cmsGetPublicPage`);
    const headers = new Headers(init?.headers);
    expect(headers.get("x-njpbs-cms-edge")).toBe("fixture-edge-only"); expect(headers.has("authorization")).toBe(false);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ mode: "release-installed-consumers-v2", nonce });
    return Response.json(probe);
  };
  const provider = createInstalledConsumerProvider({ environment: "development", request, readGoogleToken: credentials });
  expect(credentials).not.toHaveBeenCalled(); expect(calls).toHaveLength(0);
  const inventory = await provider.readInventory();
  expect(credentials).toHaveBeenCalledTimes(1);
  expect(inventory[0].serviceConfig.environmentVariables).toEqual({ PRIVATE_FIXTURE_VALUE: null });
  expect(JSON.stringify(inventory)).not.toContain("fixture-private-value-canary");
  expect(JSON.stringify(inventory)).not.toContain("fixture-upload-url-canary");
  expect(await provider.readProbe(inventory, nonce)).toEqual(probe);
  expect(credentials).toHaveBeenCalledTimes(2); expect(calls).toHaveLength(3);
  expect(calls.every(call => call.init?.method === undefined || call.init.method === "POST")).toBe(true);
});
it.each(["duplicate", "foreign", "unreachable", "repeated-token", "unknown-page"])("refuses incomplete inventory: %s", async fault => {
  const request: typeof fetch = vi.fn(async () => {
    if (fault === "duplicate") return Response.json({ functions: [row(), row()] });
    if (fault === "foreign") return Response.json({ functions: [{ ...row(), name: "projects/foreign/locations/us-central1/functions/cmsGetPublicPage" }] });
    if (fault === "unreachable") return Response.json({ functions: [row()], unreachable: ["us-central1"] });
    if (fault === "unknown-page") return Response.json({ error: "fixture provider error" });
    return Response.json({ functions: [], nextPageToken: "same-token" });
  });
  await expect(createInstalledConsumerProvider({ environment: "development", request, readGoogleToken: async () => "fixture-only" }).readInventory())
    .rejects.toThrow("provider evidence is unavailable");
});
it.each(["nonce", "secret-name", "secret-version"])("refuses probe %s before accessing a credential", async fault => {
  const request: typeof fetch = vi.fn(async () => Response.json({ functions: [row()] }));
  const credentials = vi.fn(async () => "fixture-only");
  const provider = createInstalledConsumerProvider({ environment: "development", request, readGoogleToken: credentials });
  const inventory = await provider.readInventory();
  if (fault === "secret-name") inventory[0].serviceConfig.secretEnvironmentVariables[0].secret = "OTHER_SECRET";
  if (fault === "secret-version") inventory[0].serviceConfig.secretEnvironmentVariables[0].version = "../latest";
  await expect(provider.readProbe(inventory, fault === "nonce" ? "bad" : nonce)).rejects.toThrow("provider evidence is unavailable");
  expect(credentials).toHaveBeenCalledTimes(1); expect(request).toHaveBeenCalledTimes(1);
});
it("returns only a fixed error when a credential owner fails", async () => {
  const provider = createInstalledConsumerProvider({ environment: "development",
    readGoogleToken: async () => { throw new Error("fixture-credential-error-canary"); }, request: vi.fn() });
  await expect(provider.readInventory()).rejects.toThrow("Installed consumer provider evidence is unavailable");
});
it("bounds pending credential discovery by the provider abort and never issues a later request", async () => {
  const controller = new AbortController(), request = vi.fn();
  let started!: () => void, finish!: (value: string) => void;
  const acquiring = new Promise<void>(resolve => { started = resolve; });
  const credential = new Promise<string>(resolve => { finish = resolve; });
  const provider = createInstalledConsumerProvider({ environment: "development", request, signal: controller.signal,
    readGoogleToken: async () => { started(); return credential; } });
  const result = provider.readInventory();
  await acquiring; controller.abort();
  await expect(result).rejects.toThrow("Installed consumer provider evidence is unavailable");
  expect(request).not.toHaveBeenCalled();
  finish("fixture-only-late-token"); await credential; await Promise.resolve();
  expect(request).not.toHaveBeenCalled();
});
