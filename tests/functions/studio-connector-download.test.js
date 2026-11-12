import { describe, expect, it, vi } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import api from "../../functions/live-production.js";
import contract from "../../functions/lib/studio-connector-package.js";
import downloads from "../../functions/lib/studio-connector-download.js";

const sourceSha = "7786c6693887b2d9ecb14c57ce78042d34150a4e";
// Package identity fields are fixed fixtures; runtime metadata follows the November 2026 Node release.
const manifest = { schemaVersion: 1, sourceSha,
  sha256: "792be25d72a7c376b702839c48df32e08bbd42a29310a267818fb56ac68c4444",
  bundleSha256: "9db6897273ae4a8dc6019aa1ef77f4442312488b33109f9eddc710662d75b843",
  sizeBytes: 37357523, filename: "NJPBS-Studio-connector-7786c669.zip", nodeVersion: "22.23.5",
  nodeArchiveSha256: "4a191082e9706866830379d577d2cc8a50c776fcd9436a8d061b063ed0d9a0e3" };
const staff = { approvedActive: true, principal: { id: "producer", grants: [{ role: "editor" }] } };
function storage({ record = manifest, metadata = { source: sourceSha, sha256: manifest.sha256 }, missing = false } = {}) {
  return { bucket: "private-test-bucket", client: new S3Client({ region: "auto", endpoint: "https://account.r2.cloudflarestorage.com",
    forcePathStyle: true,
    credentials: { accessKeyId: "synthetic", secretAccessKey: "synthetic-test-only" } }),
  headIfExists: async key => missing ? null : key.endsWith("manifest.json")
    ? { contentLength: Buffer.byteLength(JSON.stringify(record)) } : { contentLength: manifest.sizeBytes, metadata },
  get: async () => Buffer.from(JSON.stringify(record)) };
}
async function invoke(body, { identity = staff, agent = false, useDefaultConnector = false, connectorDownload = async () => ({ available: true, ...manifest }) } = {}) {
  const response = { statusCode: 0, body: null, headers: {} };
  response.status = code => { response.statusCode = code; return response; };
  response.set = (key, value) => { response.headers[key] = value; return response; };
  response.json = value => { response.body = value; return response; };
  const handler = api.createLiveProductionHandler({ firestore: {}, agent, ...(useDefaultConnector ? {} : { connectorDownload }),
    requirePrincipalFn: async () => { if (!identity) throw Object.assign(new Error("Sign in required"), { status: 401 }); return identity; },
    requireDeviceFn: async () => ({ uid: "fixture-device", deviceId: "fixture-device" }) });
  await handler({ method: "POST", body, headers: { "content-type": "application/json" } }, response);
  return response;
}

describe("Studio connector artifact contract", () => {
  it("accepts the source and hash receipt and keeps objects under its exact revision", () => {
    expect(contract.parseConnectorManifest(manifest, sourceSha)).toEqual(manifest);
    expect(contract.packageKey(sourceSha, manifest.sha256)).toBe(`studio-connectors/${sourceSha}/${manifest.sha256}.zip`);
  });
  it.each([
    { sourceSha: "a".repeat(40) }, { sha256: [manifest.sha256] }, { sha256: "bad" }, { sizeBytes: 0 },
    { sizeBytes: 65 * 1024 * 1024 }, { filename: "../connector.zip" }, { nodeVersion: "24.0.0" }, { nodeVersion: "22.23.4" }, { token: "not-allowed" },
  ])("rejects a mismatched or unsafe manifest %j", fields => {
    expect(() => contract.parseConnectorManifest({ ...manifest, ...fields }, sourceSha)).toThrow();
  });
  it("keeps metadata free of signed links and signs only a checked immutable object for five minutes", async () => {
    const store = storage();
    const read = downloads.createConnectorDownload({ storage: () => store, sign: getSignedUrl, now: () => 1000 });
    const metadata = await read(sourceSha, false);
    expect(metadata).toEqual({ available: true, ...manifest });
    const result = await read(sourceSha, true);
    const url = new URL(result.url);
    expect(url.pathname).toBe(`/private-test-bucket/studio-connectors/${sourceSha}/${manifest.sha256}.zip`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("response-content-disposition")).toBe(`attachment; filename="${manifest.filename}"`);
    expect(result.expiresAtMs).toBe(301000);
    store.client.destroy();
  });
  it("returns unavailable for a missing deploy artifact and rejects changed object metadata", async () => {
    const missing = storage({ missing: true });
    expect(await downloads.createConnectorDownload({ storage: () => missing })(sourceSha, true)).toEqual({ available: false, sourceSha });
    const changed = storage({ metadata: { source: "a".repeat(40), sha256: manifest.sha256 } });
    await expect(downloads.createConnectorDownload({ storage: () => changed })(sourceSha, true)).rejects.toThrow(/unavailable/);
    missing.client.destroy(); changed.client.destroy();
  });
});

describe("Studio connector staff authorization", () => {
  it("requires a signed-in staff identity", async () => {
    const result = await invoke({ action: "get_connector_package", sourceSha }, { identity: null });
    expect(result.statusCode).toBe(401);
    expect(result.body).not.toHaveProperty("url");
  });
  it("serves metadata without a session for an active global editor", async () => {
    const result = await invoke({ action: "get_connector_package", sourceSha });
    expect(result.statusCode).toBe(200);
    expect(result.body.sourceSha).toBe(sourceSha);
    expect(result.headers["Cache-Control"]).toBe("private, no-store");
  });
  it.each([
    { approvedActive: false, principal: staff.principal },
    { approvedActive: true, principal: { id: "writer", grants: [{ role: "writer" }] } },
    { approvedActive: true, principal: { id: "scoped", grants: [{ role: "editor", sections: ["news"] }] } },
  ])("denies accounts without active global setup access", async identity => {
    const result = await invoke({ action: "create_connector_download", sourceSha }, { identity });
    expect(result.statusCode).toBe(403);
    expect(result.body).not.toHaveProperty("url");
  });
  it("refuses device-only callers and source paths", async () => {
    expect((await invoke({ action: "create_connector_download", sourceSha }, { agent: true })).statusCode).toBe(400);
    expect((await invoke({ action: "get_connector_package", sourceSha: "../private" })).statusCode).toBe(400);
    expect((await invoke({ action: "get_connector_package", sourceSha, key: "other.zip" })).statusCode).toBe(400);
  });
  it("reports an unconfigured optional private store as unavailable without reading credentials", async () => {
    vi.stubEnv("CMS_MEDIA_MASTER_R2_BUCKET", "");
    try {
      for (const action of ["get_connector_package", "create_connector_download"]) {
        const result = await invoke({ action, sourceSha }, { useDefaultConnector: true });
        expect(result.statusCode).toBe(200);
        expect(result.body).toEqual({ success: true, available: false, sourceSha });
      }
    } finally { vi.unstubAllEnvs(); }
  });
  it("keeps provider errors and signed data out of errors and logs", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await invoke({ action: "create_connector_download", sourceSha }, {
        connectorDownload: async () => { throw new Error("synthetic-private-provider-details"); },
      });
      expect(result.statusCode).toBe(503);
      expect(JSON.stringify(result.body)).not.toContain("synthetic-private");
      expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic-private");
    } finally { log.mockRestore(); }
  });
});
