import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import backup from "../../functions/lib/video-backup.js";
import sourceAdapter from "../../functions/lib/video-backup-source.js";
import r2Adapter from "../../functions/lib/video-backup-r2.js";
import { createFileBackupDestination, createFileBackupState, createFileBackupSource } from "../../scripts/lib/video-backup-files.mjs";
import { createVideoBackupRunner } from "../../scripts/lib/video-backup-runner.mjs";
import { assetFixture, sourceBucket, sourceIdentity, identityKey, fakeDatabase } from "../fixtures/video-backup.mjs";
import { inventoryRecords, assertPrivateBackupBucket, backupExitCode } from "../../scripts/backup-video-viewing-copies.mjs";
import { spawnSync } from "node:child_process";

const bytes = Buffer.from("viewing-copy");
let root, state, destination, source, records, db;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "backup-unit-"));
  state = createFileBackupState(join(root, "state"));
  destination = createFileBackupDestination(join(root, "backup"));
  source = createFileBackupSource(join(root, "source"), identityKey);
  records = { a: assetFixture("a", bytes.length) };
  db = fakeDatabase(records);
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source", `${identityKey(sourceIdentity(records.a))}.mp4`), bytes);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const runner = extra => createVideoBackupRunner({ db, source, sourceBucket, destination, state, pageSize: 2, ...extra });
const entry = async () => (await backup.inventoryPage({ db, source, sourceBucket })).entries[0];
const copy = async (candidate, extra) => backup.copyViewingCopy({ entry: candidate, source, destination, state, ...extra });

describe("viewing-copy inventory and durable worker", () => {
  it("estimates all recorded unpublished viewing copies without AWS access or source verification", async () => {
    for (let index = 0; index < 22; index++) records[`ready-${index}`] = assetFixture(`ready-${index}`, bytes.length);
    records.pending = assetFixture("pending"); delete records.pending.rendition;
    records.invalid = assetFixture("invalid"); records.invalid.rendition.web.objectKey = "wrong.mp4";
    const result = await inventoryRecords({ db, sourceBucket });
    expect(result).toMatchObject({ complete: true, sourceVerified: false, scanned: 25,
      eligibleFiles: 23, eligibleBytes: 23 * bytes.length, gapCount: 2,
      gapReasons: { missing_viewing_copy: 1, invalid_rendition: 1 } });
    expect(db.reads.length).toBe(2);
    expect(db.reads.every(read => read.limit === 20)).toBe(true);
    // The production inventory path must still refuse an unreadable S3 object.
    const page = await backup.inventoryPage({ db, source: { head: async () => { throw Error("offline"); } }, sourceBucket });
    expect(page.sourceVerified).toBe(true);
    expect(page.eligibleFiles).toBe(0);
  });

  it("counts unpublished files and all gap categories without transfers", async () => {
    records.b = assetFixture("b"); delete records.b.rendition;
    records.c = assetFixture("c"); records.c.rendition.web.objectKey = "wrong.mp4";
    for (const [id, status] of [["d", "processing"], ["e", "failed"], ["f", "not_prepared"]]) {
      records[id] = assetFixture(id); records[id].rendition.state = status;
      delete records[id].rendition.web; delete records[id].rendition.poster;
    }
    records.g = assetFixture("g"); records.g.lifecycle = "deleted";
    records.h = assetFixture("h");
    records.z = { sourceId: "different-library" };
    const reader = vi.spyOn(source, "read");
    let receipt;
    do { receipt = await runner().inventoryStep("first"); } while (!receipt.complete);
    expect(receipt).toMatchObject({ scanned: 8, eligibleFiles: 1, eligibleBytes: bytes.length, gapCount: 7 });
    expect(Object.keys(receipt.gapReasons)).toHaveLength(7);
    expect(reader).not.toHaveBeenCalled();
    expect(await state.read("jobs/x")).toBeNull();
    expect(db.reads.every(read => read.limit === 2)).toBe(true);
  });

  it("resumes a failed checkpoint write without counting the page twice", async () => {
    const write = state.write.bind(state);
    let fail = true;
    state.write = async (key, value) => {
      if (key.endsWith("/inventory") && fail) { fail = false; throw Error("crash"); }
      return write(key, value);
    };
    await expect(runner().inventoryStep("resume")).rejects.toThrow("crash");
    expect(await runner().inventoryStep("resume")).toMatchObject({ scanned: 1, eligibleFiles: 1, complete: true });
    expect(await runner().inventoryStep("resume")).toMatchObject({ scanned: 1, pages: 1 });
  });

  it("refuses copying an incomplete inventory and overlapping workers", async () => {
    await expect(runner().copyStep("absent")).rejects.toThrow("Complete and report");
    await state.withLock(async () => {
      await expect(runner().inventoryStep("overlap")).rejects.toMatchObject({ code: "BACKUP_LOCK_HELD" });
    });
    const candidate = await entry();
    const mismatched = { ...source, head: async () => ({ sizeBytes: bytes.length, versionId: "latest" }) };
    const page = await backup.inventoryPage({ db, source: mismatched, sourceBucket });
    expect(page.gaps[0].reason).toBe("source_identity_mismatch");
    expect(candidate.source.versionId).toBe("web-v1");
  });

  it("recovers its kernel lock and owned staging after process death without deleting unrelated files", async () => {
    const directory = join(root, "state");
    const staging = join(directory, "staging");
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, "keep"), "unrelated");
    const child = spawnSync(process.execPath, ["--input-type=module", "-e",
      'const {createFileBackupState}=await import(process.argv[2]); const {mkdir,writeFile}=await import("node:fs/promises"); await createFileBackupState(process.argv[1]).withLock(async()=>{const path=process.argv[1]+"/staging/viewing-copy-backup-crashed";await mkdir(path);await writeFile(path+"/copy.mp4","staged");process.kill(process.pid,"SIGKILL");});',
      directory, new URL("../../scripts/lib/video-backup-files.mjs", import.meta.url).href], { encoding: "utf8" });
    expect(child.signal).toBe("SIGKILL");
    expect((await stat(join(directory, "worker.lock"))).isFile()).toBe(true);
    expect((await stat(join(staging, "viewing-copy-backup-crashed", "copy.mp4"))).isFile()).toBe(true);
    const { readdir } = await import("node:fs/promises");
    await expect(state.withLock(() => readdir(staging))).resolves.toEqual(["keep"]);
  });

  it("reports each sweep before transfer and reconciles newly ready files behind the cursor", async () => {
    records.b = assetFixture("b"); delete records.b.rendition;
    const worker = runner();
    expect((await worker.tick({ allowCopy: true })).phase).toBe("inventory");
    expect((await worker.tick({ allowCopy: true })).inventory.complete).toBe(true);
    expect((await worker.tick()).phase).toBe("awaiting_copy");
    expect((await worker.tick({ allowCopy: true })).copy.verified).toBe(1);
    expect((await worker.tick({ allowCopy: true })).copy.complete).toBe(true);
    records.b = assetFixture("b", bytes.length);
    await writeFile(join(root, "source", `${identityKey(sourceIdentity(records.b))}.mp4`), bytes);
    await worker.tick({ allowCopy: true });
    expect((await worker.tick({ allowCopy: true })).inventory.eligibleFiles).toBe(2);
    expect((await worker.tick({ allowCopy: true })).copy).toMatchObject({ verified: 2, reused: 1 });
  });
});

describe("verified independent archives", () => {
  it("stages on the selected private disk and cleans that staging directory", async () => {
    const stagingDirectory = join(root, "private-staging");
    await mkdir(stagingDirectory, { mode: 0o700 });
    const read = source.read.bind(source);
    source.read = async identity => {
      const { readdir } = await import("node:fs/promises");
      expect(await readdir(stagingDirectory)).toHaveLength(1);
      return read(identity);
    };
    expect((await copy(await entry(), { stagingDirectory })).status).toBe("verified");
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(stagingDirectory)).toEqual([]);
  });

  it("writes a complete sidecar, verifies readback and retries without source reads or new writes", async () => {
    const candidate = await entry();
    expect((await copy(candidate)).status).toBe("verified");
    const { mp4, sidecar } = backup.archiveKeys(candidate.archiveId);
    const catalog = JSON.parse(await readFile(join(root, "backup", sidecar), "utf8"));
    expect(catalog).toMatchObject({ ...candidate, schemaVersion: 1, sourceId: "video-library", sha256: expect.any(String) });
    expect(await backup.digest(await destination.read(mp4), bytes.length)).toBe(catalog.sha256);
    expect((await stat(join(root, "backup", mp4))).mode & 0o777).toBe(0o600);
    await rm(join(root, "source"), { recursive: true }); delete records.a;
    const writes = vi.spyOn(destination, "putIfAbsent");
    expect(await copy(candidate)).toMatchObject({ status: "verified", reused: true });
    expect(writes).not.toHaveBeenCalled();
    expect(await readFile(join(root, "backup", mp4))).toEqual(bytes);
  });

  it("keeps changed versions distinct", async () => {
    const first = await entry();
    await copy(first);
    records.a = assetFixture("a", bytes.length, "web-v2");
    await writeFile(join(root, "source", `${identityKey(sourceIdentity(records.a))}.mp4`), bytes);
    const second = await entry();
    expect(second.archiveId).not.toBe(first.archiveId);
    expect((await copy(second)).status).toBe("verified");
    for (const item of [first, second]) {
      const stream = await destination.read(backup.archiveKeys(item.archiveId).sidecar);
      expect(stream).not.toBeNull();
      stream.destroy();
    }
  });

  it("keeps failure explicit on an interrupted stream and retries successfully", async () => {
    const candidate = await entry();
    const broken = { ...source, read: async () => ({ sizeBytes: bytes.length, versionId: "web-v1",
      body: Readable.from((async function* () { yield bytes.subarray(0, 2); throw Error("private provider diagnostic"); })()) }) };
    expect(await copy(candidate, { source: broken })).toMatchObject({ status: "failed", errorCode: "copy_failed" });
    expect(await destination.read(backup.archiveKeys(candidate.archiveId).sidecar)).toBeNull();
    expect(await copy(candidate)).toMatchObject({ status: "verified", attempts: 2 });
  });

  it("leaves a pending record when the process dies before completion and resumes", async () => {
    const candidate = await entry();
    await state.write(`jobs/${candidate.archiveId}`, { entry: candidate, status: "pending", attempts: 1 });
    expect(await copy(candidate)).toMatchObject({ status: "verified", attempts: 2 });
  });

  it.each(["wrong-version", "short-body", "long-body"])("refuses source %s without a completion sidecar", async mode => {
    const candidate = await entry();
    const bad = { ...source, read: async () => ({ sizeBytes: bytes.length,
      versionId: mode === "wrong-version" ? "latest" : "web-v1",
      body: Readable.from([mode === "short-body" ? bytes.subarray(0, 2) : mode === "long-body" ? Buffer.concat([bytes, bytes]) : bytes]) }) };
    expect((await copy(candidate, { source: bad })).status).toBe("failed");
    expect(await destination.read(backup.archiveKeys(candidate.archiveId).sidecar)).toBeNull();
  });

  it("recovers an orphan MP4 after sidecar failure without another stored MP4", async () => {
    const candidate = await entry();
    const original = destination.putIfAbsent.bind(destination);
    destination.putIfAbsent = async (key, ...args) => {
      if (key.endsWith(".json")) throw Error("provider unavailable");
      return original(key, ...args);
    };
    expect((await copy(candidate)).status).toBe("failed");
    const path = join(root, "backup", backup.archiveKeys(candidate.archiveId).mp4);
    const originalInode = (await stat(path)).ino;
    destination.putIfAbsent = original;
    expect((await copy(candidate)).status).toBe("verified");
    expect((await stat(path)).ino).toBe(originalInode);
  });

  it("never records verification for same-size corrupt destination bytes or replaces them", async () => {
    const candidate = await entry();
    const keys = backup.archiveKeys(candidate.archiveId);
    await destination.putIfAbsent(keys.mp4, Buffer.alloc(bytes.length, 42), { sizeBytes: bytes.length });
    expect(await copy(candidate)).toMatchObject({ status: "failed", errorCode: "digest_mismatch" });
    expect(await destination.read(keys.sidecar)).toBeNull();
    expect(await readFile(join(root, "backup", keys.mp4))).toEqual(Buffer.alloc(bytes.length, 42));
  });

  it("detects post-verification corruption and refuses an oversized transfer", async () => {
    const candidate = await entry();
    await copy(candidate);
    await writeFile(join(root, "backup", backup.archiveKeys(candidate.archiveId).mp4), Buffer.alloc(bytes.length));
    expect(await copy(candidate)).toMatchObject({ status: "failed", errorCode: "digest_mismatch" });
    expect(await copy(candidate, { maxFileBytes: 1 })).toMatchObject({ status: "failed", errorCode: "copy_limit_exceeded" });
  });

  it("replays a failed retained inventory even when its source document disappears", async () => {
    await runner().inventoryStep("retained");
    const broken = { read: async () => { throw Error("offline"); } };
    expect(await runner({ destination: broken }).copyStep("retained")).toMatchObject({ complete: true, failed: 1 });
    delete records.a;
    expect(await runner().copyStep("retained")).toMatchObject({ complete: true, verified: 1, pass: 2 });
  });

  it("skips verified MP4 downloads in routine passes and offers explicit full verification", async () => {
    await runner().inventoryStep("efficient");
    expect(await runner().copyStep("efficient")).toMatchObject({ verified: 1, checkedFiles: 1, checkedBytes: bytes.length });
    const candidate = await entry();
    const keys = backup.archiveKeys(candidate.archiveId);
    const before = await state.read(`jobs/${candidate.archiveId}`);
    const read = vi.spyOn(destination, "read");
    expect(await runner().copyStep("efficient")).toMatchObject({ verified: 1, reused: 1, checkedFiles: 0, checkedBytes: 0 });
    expect(read.mock.calls.map(([key]) => key)).toEqual([keys.sidecar]);
    expect((await state.read(`jobs/${candidate.archiveId}`)).verifiedAt).toBe(before.verifiedAt);
    await writeFile(join(root, "backup", keys.mp4), Buffer.alloc(bytes.length));
    expect(await runner().copyStep("efficient", { verifyExisting: true })).toMatchObject({ verified: 0, failed: 1 });
    expect(read.mock.calls.some(([key]) => key === keys.mp4)).toBe(true);
  });
});

describe("S3 API boundaries", () => {
  it("pins every source request to the rendition version and expected owner; exposes no writes", async () => {
    const calls = [];
    const client = { send: async command => { calls.push(command); return { VersionId: "v1", ContentLength: 1, Body: Readable.from(["x"]) }; } };
    const reader = sourceAdapter.createVideoBackupSource({ client, bucket: sourceBucket, expectedBucketOwner: "synthetic-owner" });
    const identity = { bucket: sourceBucket, key: "outputs/fixture/preview.mp4", versionId: "v1" };
    await reader.head(identity);
    (await reader.read(identity)).body.destroy();
    expect(calls.map(call => call.constructor.name)).toEqual(["HeadObjectCommand", "GetObjectCommand"]);
    expect(calls[1].input).toEqual({ Bucket: sourceBucket, Key: identity.key, VersionId: "v1", ExpectedBucketOwner: "synthetic-owner" });
    expect(Object.keys(reader)).toEqual(["head", "read"]);
    await expect(reader.read({ ...identity, bucket: "wrong" })).rejects.toThrow();
  });

  function fakeR2({ publicBucket = false, failPart = false } = {}) {
    const objects = new Map(), calls = [], parts = [];
    const client = { async send(command) {
      const name = command.constructor.name, value = command.input;
      calls.push(name);
      expect(value).not.toHaveProperty("ACL");
      if (name === "HeadObjectCommand" || name === "GetObjectCommand") {
        if (!objects.has(value.Key)) throw Object.assign(Error("missing"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
        return { ContentLength: objects.get(value.Key).length, Body: Readable.from([objects.get(value.Key)]) };
      }
      if (name === "PutObjectCommand") {
        expect(value.IfNoneMatch).toBe("*");
        objects.set(value.Key, Buffer.from(value.Body)); return {};
      }
      if (name === "CreateMultipartUploadCommand") return { UploadId: "upload-1" };
      if (name === "UploadPartCommand") {
        if (failPart) throw Error("offline");
        parts.push(Buffer.from(value.Body)); return { ETag: `part-${value.PartNumber}` };
      }
      if (name === "CompleteMultipartUploadCommand") { objects.set(value.Key, Buffer.concat(parts)); return {}; }
      if (name === "AbortMultipartUploadCommand") return {};
      throw Error("Unexpected S3 operation");
    } };
    return { objects, calls, destination: r2Adapter.createR2BackupDestination({ client, bucket: "test-backup", singleWriter: true,
      assertPrivate: async () => { if (publicBucket) throw Error("Bucket must be private"); } }) };
  }

  it("uses R2 multipart writes without ACLs and preserves an existing object", async () => {
    const fake = fakeR2();
    const key = backup.archiveKeys("a".repeat(64)).mp4;
    expect(await fake.destination.putIfAbsent(key, Readable.from([bytes]), { sizeBytes: bytes.length, contentType: "video/mp4" })).toBe(true);
    expect(fake.objects.get(key)).toEqual(bytes);
    expect(await fake.destination.putIfAbsent(key, Buffer.from("different"), { sizeBytes: 9 })).toBe(false);
    expect(fake.calls.filter(name => name === "CreateMultipartUploadCommand")).toHaveLength(1);
    expect(await fake.destination.putIfAbsent(backup.archiveKeys("a".repeat(64)).sidecar, bytes, { sizeBytes: bytes.length })).toBe(true);
  });

  it("splits multipart bytes at the part boundary and completes the exact content", async () => {
    const fake = fakeR2();
    const key = backup.archiveKeys("b".repeat(64)).mp4;
    const first = Buffer.alloc(8 * 1024 ** 2 - 1, 1);
    const final = Buffer.from([2, 3]);
    await fake.destination.putIfAbsent(key, Readable.from([first, final]), { sizeBytes: first.length + final.length });
    expect(fake.calls.filter(name => name === "UploadPartCommand")).toHaveLength(2);
    expect(fake.objects.get(key).equals(Buffer.concat([first, final]))).toBe(true);
  });

  it("refuses public access and aborts only an unfinished upload on failure", async () => {
    const key = backup.archiveKeys("a".repeat(64)).mp4;
    const publicFake = fakeR2({ publicBucket: true });
    await expect(publicFake.destination.putIfAbsent(key, bytes, { sizeBytes: bytes.length })).rejects.toThrow("private");
    expect(publicFake.calls).toEqual([]);
    const failed = fakeR2({ failPart: true });
    await expect(failed.destination.putIfAbsent(key, Readable.from([bytes]), { sizeBytes: bytes.length })).rejects.toThrow("offline");
    expect(failed.calls.at(-1)).toBe("AbortMultipartUploadCommand");
    expect(failed.objects.size).toBe(0);
  });

  it.each(["read", "putIfAbsent"])("does not treat object access denied as missing during %s", async operation => {
    const calls = [];
    const destination = r2Adapter.createR2BackupDestination({ bucket: "test", singleWriter: true, assertPrivate: async () => {},
      client: { send: async command => {
        calls.push(command.constructor.name);
        throw Object.assign(Error("denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
      } } });
    await expect(destination[operation](backup.archiveKeys("a".repeat(64)).mp4, bytes, { sizeBytes: bytes.length })).rejects.toThrow("denied");
    expect(calls).toEqual([operation === "read" ? "GetObjectCommand" : "HeadObjectCommand"]);
  });
});

describe("production backup admission", () => {
  it("fails the scheduler for unreadable or mismatched source versions and failed copies", () => {
    expect(backupExitCode({ inventory: { gapReasons: { source_unreadable: 1 } } })).toBe(1);
    expect(backupExitCode({ inventory: { gapReasons: { source_identity_mismatch: 1 } } })).toBe(1);
    expect(backupExitCode({ copy: { failed: 1 } })).toBe(1);
    expect(backupExitCode({ inventory: { gapReasons: { missing_viewing_copy: 1 } } })).toBe(0);
    expect(backupExitCode({ copy: { failed: 0 } })).toBe(0);
  });

  it("keeps the CLI and scheduled caller disabled before reading credentials", () => {
    const env = { PATH: process.env.PATH };
    const cli = spawnSync(process.execPath, ["scripts/backup-video-viewing-copies.mjs", "--tick"], { env, encoding: "utf8" });
    expect(cli.status).toBe(0);
    expect(JSON.parse(cli.stdout)).toEqual({ phase: "disabled" });
    const scheduled = spawnSync("/bin/bash", ["infrastructure/video-backup/run.sh"], { env, encoding: "utf8" });
    expect(scheduled.status).toBe(0);
    expect(scheduled.stdout).toBe("");
  });

  it("suppresses malformed credential and provider details at the command boundary", () => {
    const result = spawnSync(process.execPath, ["scripts/backup-video-viewing-copies.mjs", "--inventory"], {
      env: { PATH: process.env.PATH, CMS_MEDIA_AWS_RENDITION_BUCKET: sourceBucket },
      input: "invalid-synthetic-credential", encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Video backup failed; details suppressed\n");
  });

  const privatePolicies = {
    "domains/managed": { enabled: false }, "domains/custom": { domains: [] },
    lock: { rules: [{ enabled: true, prefix: "viewing-copies-v1/", condition: { type: "Indefinite" } }] },
  };
  const privacy = (policies = privatePolicies, ok = true) => assertPrivateBackupBucket({
    accountId: "a".repeat(32), bucket: "test-backup", apiToken: "synthetic-token",
    fetchImpl: async url => ({ ok, json: async () => ({ success: ok,
      result: policies[url.split("test-backup/")[1]] }) }),
  });
  it("requires private domains and locked recovery objects, failing closed on unknown policy", async () => {
    await expect(privacy()).resolves.toBeUndefined();
    for (const [key, value] of [
      ["domains/managed", { enabled: true }], ["domains/custom", { domains: [{ enabled: true }] }],
      ["domains/custom", {}], ["lock", { rules: [] }],
      ["lock", { rules: [{ enabled: true, prefix: "other/", condition: { type: "Indefinite" } }] }],
    ]) await expect(privacy({ ...privatePolicies, [key]: value })).rejects.toThrow();
    await expect(privacy(privatePolicies, false)).rejects.toThrow("unreadable");
  });
});
