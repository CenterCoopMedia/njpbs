import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { uploadConnectorPackage, describeUploadFailure } from "../../scripts/upload-studio-connector.mjs";
import { verifyRuntime, describeBuildFailure } from "../../agents/vmix/build-windows.mjs";

const directories = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const sourceSha = "7786c6693887b2d9ecb14c57ce78042d34150a4e";
const zipBytes = Buffer.from("Synthetic artifact bytes; no executable");
const sha256 = createHash("sha256").update(zipBytes).digest("hex");
const manifest = { schemaVersion: 1, sourceSha, sha256, bundleSha256: "9db6897273ae4a8dc6019aa1ef77f4442312488b33109f9eddc710662d75b843",
  sizeBytes: zipBytes.length, filename: "NJPBS-Studio-connector-7786c669.zip", nodeVersion: "22.23.5",
  nodeArchiveSha256: "4a191082e9706866830379d577d2cc8a50c776fcd9436a8d061b063ed0d9a0e3" };
async function fixture(bytes = zipBytes) {
  const directory = await mkdtemp(join(tmpdir(), "connector-upload-test-"));
  directories.push(directory);
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(directory, manifest.filename), bytes);
  return join(directory, "manifest.json");
}
function remoteStore({ failZipReadback = false } = {}) {
  const objects = new Map();
  const storage = { bucket: "private-test-bucket", client: { send: async command => {
    const request = command.input;
    if (objects.has(request.Key)) throw Object.assign(new Error("Immutable object exists"), { $metadata: { httpStatusCode: 412 } });
    objects.set(request.Key, request);
  } }, head: async key => {
    const request = objects.get(key);
    return { contentLength: failZipReadback && key.endsWith(".zip") ? 0 : request.ContentLength, metadata: request.Metadata };
  } };
  return { storage, objects };
}

describe("exact-source connector deployment", () => {
  it("stores immutable private bytes and a matching manifest, and permits the identical receipt again", async () => {
    const path = await fixture();
    const { storage, objects } = remoteStore();
    expect(await uploadConnectorPackage({ path, sourceSha, storage })).toEqual(manifest);
    expect(objects.size).toBe(2);
    for (const object of objects.values()) {
      expect(object.IfNoneMatch).toBe("*");
      expect(object.CacheControl).toBe("private, no-store");
      expect(object.Metadata.source).toBe(sourceSha);
      expect(object.Metadata.sha256).toBe(createHash("sha256").update(object.Body).digest("hex"));
    }
    expect(await uploadConnectorPackage({ path, sourceSha, storage })).toEqual(manifest);
  });
  it("does not publish a manifest when stored ZIP readback differs", async () => {
    const path = await fixture();
    const { storage, objects } = remoteStore({ failZipReadback: true });
    await expect(uploadConnectorPackage({ path, sourceSha, storage })).rejects.toThrow(/does not match/);
    expect([...objects.keys()].some(key => key.endsWith("manifest.json"))).toBe(false);
  });
  it("rejects changed local bytes and a source mismatch before exposing a release", async () => {
    const path = await fixture(Buffer.from("Changed artifact"));
    const { storage, objects } = remoteStore();
    await expect(uploadConnectorPackage({ path, sourceSha, storage })).rejects.toThrow(/differ/);
    await expect(uploadConnectorPackage({ path, sourceSha: "b".repeat(40), storage })).rejects.toThrow(/manifest/);
    expect(objects.size).toBe(0);
  });
  it("skips an unconfigured optional private store without blocking deployment", () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../scripts/upload-studio-connector.mjs", import.meta.url)), "missing-manifest.json"],
      { env: { PATH: process.env.PATH, CMS_MEDIA_MASTER_R2_BUCKET: "" }, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/unavailable.*not configured/);
    expect(result.stderr).toBe("");
  });
  it("gives safe failure categories without provider request details", async () => {
    const provider = Object.assign(new Error("synthetic-private-request-and-credential"), { $metadata: { httpStatusCode: 403 } });
    expect(describeUploadFailure(provider)).toMatch(/HTTP 403/);
    expect(describeUploadFailure(provider)).not.toContain("synthetic-private");
    expect(describeBuildFailure(provider)).not.toContain("synthetic-private");
    expect(describeBuildFailure({ code: "ENOENT" })).toMatch(/not found/);
    const path = await fixture(Buffer.from("Changed artifact"));
    const uploadError = await uploadConnectorPackage({ path, sourceSha, storage: remoteStore().storage }).then(() => null, error => error);
    expect(uploadError).toBeInstanceOf(Error);
    expect(describeUploadFailure(uploadError)).toMatch(/bytes differ/);
    let buildError;
    try { verifyRuntime(Buffer.from("Altered runtime"), ""); } catch (error) { buildError = error; }
    expect(buildError).toBeInstanceOf(Error);
    expect(describeBuildFailure(buildError)).toMatch(/checksum/);
  });
  it("refuses an unverified runtime even when supplied checksum text claims the pinned release", () => {
    const sums = `${manifest.nodeArchiveSha256}  node-v22.23.5-win-x64.zip\n`;
    expect(() => verifyRuntime(Buffer.from("Altered runtime"), sums)).toThrow(/checksum/);
    expect(() => verifyRuntime(Buffer.from("Altered runtime"), "")).toThrow(/checksum/);
  });
});
