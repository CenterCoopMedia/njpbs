import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { App } from "firebase-admin/app";
import { assertRetainedImageCheckpoint, retainedImageManifestFile, MAX_RETAINED_IMAGE_BYTES } from "./retained-public-images";

const require = createRequire(import.meta.url);
const { createPostBackgroundStorage } = require("../../functions/lib/post-background-storage");
const { CHECKPOINT_FILES_MAX, CHECKPOINT_BYTES_MAX, CHECKPOINT_MANIFEST_BYTES_MAX } = require("../../functions/lib/no-build-record-namespace");
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const MAX_BYTES = 16 * 1024 * 1024;
export interface PreparationIdentity {
  operationId: string; contextDigest: string; commitSha: string;
  owner: "node-compute" | "cloudflare"; cutoffMillis: number; admissionRevision: number | null;
  inputDigest?: string;
}
interface FileReceipt { path: string; digest: string; size: number }
interface Checkpoint { schemaVersion: 1; identity: PreparationIdentity; files: FileReceipt[] }
export type PreparationStage = "input" | "prepared" | "preview";
export class PreparationIntegrityError extends Error {}
const inputFiles = ["input.json", "routes.json", "launch-media-manager.json", "spotlight-news.json", "schedule.json"];
const outputFiles = ["receipt.json", "artifact-inventory.json", "public-context.json"];
async function transferFiles<T>(files: T[], stage: PreparationStage, transfer: (file: T) => Promise<void>) {
  // Prepared search/catalog checkpoints contain many independent small files.
  // Bound concurrency and drain failures before publishing or removing staging.
  const width = stage === "prepared" ? 8 : 1;
  for (let offset = 0; offset < files.length; offset += width) {
    const results = await Promise.allSettled(files.slice(offset, offset + width).map(transfer));
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}
function safePath(value: string) {
  if (typeof value !== "string" || value.includes("\\") || value.includes("\0") ||
      value.split("/").some(part => !part || part === "." || part === "..")) {
    throw new PreparationIntegrityError("Invalid preparation checkpoint path");
  }
}
function parseCheckpoint(bytes: Buffer, identity: PreparationIdentity, stage: PreparationStage): Checkpoint {
  if (stage === "preview" && !/^[a-f0-9]{64}$/.test(identity.inputDigest ?? "")) throw new PreparationIntegrityError("Preview input digest is missing");
  if (bytes.length > (stage === "input" ? 2 * 1024 * 1024 : CHECKPOINT_MANIFEST_BYTES_MAX)) throw new PreparationIntegrityError("Preparation checkpoint exceeds its bound");
  let value: Checkpoint;
  try { value = JSON.parse(bytes.toString("utf8")) as Checkpoint; }
  catch { throw new PreparationIntegrityError("Preparation checkpoint is invalid JSON"); }
  if (value?.schemaVersion !== 1 || !value.identity ||
      Object.entries(identity).some(([key, expected]) => value.identity[key as keyof PreparationIdentity] !== expected) ||
      !Array.isArray(value.files) || value.files.length > (stage === "input" ? 7 * 256 + 8 : CHECKPOINT_FILES_MAX)) throw new PreparationIntegrityError("Preparation checkpoint identity differs");
  const paths = new Set<string>();
  let size = 0;
  for (const file of value.files) {
    if (!file) throw new PreparationIntegrityError("Invalid preparation checkpoint file");
    safePath(file.path);
    if (paths.has(file.path) || !/^[a-f0-9]{64}$/.test(file.digest) || !Number.isSafeInteger(file.size) ||
        file.size < 0 || file.size > (stage === "input" && file.path.startsWith("images/") ? MAX_RETAINED_IMAGE_BYTES : MAX_BYTES) ||
        (stage === "input" ? !inputFiles.includes(file.path) && file.path !== retainedImageManifestFile && !/^images\/[a-f0-9]{64}$/.test(file.path)
          : stage === "preview" ? file.path !== "public-context.json"
          : !outputFiles.includes(file.path) && !file.path.startsWith("files/"))) {
      throw new PreparationIntegrityError("Invalid preparation checkpoint file");
    }
    paths.add(file.path); size += file.size;
  }
  if (size > (stage === "input" ? 112 * 1024 * 1024 : CHECKPOINT_BYTES_MAX) ||
      (stage === "input" ? inputFiles : stage === "preview" ? ["public-context.json"] : outputFiles).some(file => !paths.has(file))) {
    throw new PreparationIntegrityError("Preparation checkpoint is incomplete");
  }
  if (stage === "input" && [...paths].some(file => file.startsWith("images/")) && !paths.has(retainedImageManifestFile)) {
    throw new PreparationIntegrityError("Preparation image manifest is missing");
  }
  for (const file of paths) {
    const parts = file.split("/");
    while (parts.length > 1) { parts.pop(); if (paths.has(parts.join("/"))) throw new PreparationIntegrityError("Conflicting checkpoint paths"); }
  }
  return value;
}

async function privateDirectory(directory: string) {
  const stat = await lstat(directory);
  if (!path.isAbsolute(directory) || !stat.isDirectory() || stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 || await realpath(directory) !== directory) {
    throw new Error("Preparation directory must be private and canonical");
  }
}

/** Private create-only checkpoints. Commit the manifest only after every byte
 * has been read back; disk is a disposable cache of those verified objects. */
export function createNoBuildPreparationStorage(bucket: string, app: App, identity: PreparationIdentity,
  { signal }: { signal?: AbortSignal } = {}) {
  if (!app || !/^[A-Za-z0-9]{20}$/.test(identity.operationId) || !/^[a-f0-9]{64}$/.test(identity.contextDigest) ||
      !/^[a-f0-9]{40}$/.test(identity.commitSha) || !["node-compute", "cloudflare"].includes(identity.owner) ||
      !Number.isSafeInteger(identity.cutoffMillis) || identity.cutoffMillis <= 0 ||
      (identity.inputDigest !== undefined && !/^[a-f0-9]{64}$/.test(identity.inputDigest)) ||
      (identity.admissionRevision !== null && (!Number.isSafeInteger(identity.admissionRevision) || identity.admissionRevision < 1))) {
    throw new Error("Invalid durable preparation identity");
  }
  const storage = createPostBackgroundStorage(bucket, app);
  const imageIdentity = { buildBatchId: `post-background-${identity.operationId}-${identity.contextDigest}`, commitSha: identity.commitSha };
  async function verifyImages(stage: string, directory: string, files: FileReceipt[]) {
    if (stage !== "input") return;
    try { await assertRetainedImageCheckpoint(directory, imageIdentity, files); }
    catch { throw new PreparationIntegrityError("Preparation image checkpoint differs"); }
  }
  const prefix = `post-background-v1/preparation/${identity.operationId}/${identity.contextDigest}`;
  const options = () => ({ signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000), contentType: "application/octet-stream" });
  async function read(key: string, maxBytes = MAX_BYTES): Promise<Buffer | null> {
    try { return await storage.get(key, { ...options(), maxBytes }); }
    catch (error) { if ((error as { code?: number }).code === 404) return null; throw error; }
  }
  async function put(key: string, bytes: Buffer, maxBytes = MAX_BYTES) {
    if (bytes.length > maxBytes) throw new Error("Preparation object exceeds its bound");
    await storage.put(key, bytes, options());
    const retained = await read(key, maxBytes);
    if (!retained) throw new Error("Preparation object was not retained");
    return retained;
  }
  async function validLocalCache(stage: PreparationStage, directory: string, expectedDigest: string): Promise<boolean> {
    try {
      await privateDirectory(directory);
      const manifestFile = path.join(directory, `.checkpoint-${stage}.json`);
      const stat = await lstat(manifestFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > (stage === "input" ? 2 * 1024 * 1024 : CHECKPOINT_MANIFEST_BYTES_MAX)) return false;
      const bytes = await readFile(manifestFile);
      if (digest(bytes) !== expectedDigest) return false;
      const manifest = parseCheckpoint(bytes, identity, stage);
      for (const file of manifest.files) {
        const target = path.join(directory, file.path);
        const stat = await lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== file.size || await realpath(target) !== target) return false;
        const content = await readFile(target);
        if (content.length !== file.size || digest(content) !== file.digest) return false;
      }
      await verifyImages(stage, directory, manifest.files);
      return true;
    } catch { return false; }
  }
  async function restore(stage: PreparationStage, directory: string, expectedDigest?: string): Promise<string | null> {
    signal?.throwIfAborted();
    if (expectedDigest !== undefined && !/^[a-f0-9]{64}$/.test(expectedDigest)) throw new PreparationIntegrityError("Invalid checkpoint digest");
    if (expectedDigest && await validLocalCache(stage, directory, expectedDigest)) return expectedDigest;
    const bytes = await read(`${prefix}/${stage}.json`);
    if (!bytes) return null;
    if (expectedDigest && digest(bytes) !== expectedDigest) throw new PreparationIntegrityError("Preparation manifest digest changed");
    const manifest = parseCheckpoint(bytes, identity, stage);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await privateDirectory(directory);
    const staging = await mkdtemp(path.join(directory, ".restore-"));
    try {
      await transferFiles(manifest.files, stage, async file => {
        signal?.throwIfAborted();
        const content = await read(`${prefix}/bytes/${file.digest}`, stage === "input" && file.path.startsWith("images/") ? MAX_RETAINED_IMAGE_BYTES : MAX_BYTES);
        if (!content) throw new PreparationIntegrityError("Preparation checkpoint object is missing");
        if (content.length !== file.size || digest(content) !== file.digest) throw new PreparationIntegrityError("Preparation checkpoint bytes differ");
        const target = path.join(staging, file.path);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, content, { mode: 0o600, flag: "wx" });
      });
      await verifyImages(stage, staging, manifest.files);
      for (const name of new Set(manifest.files.map(file => file.path.split("/")[0]))) {
        await rm(path.join(directory, name), { recursive: true, force: true });
        await rename(path.join(staging, name), path.join(directory, name));
      }
      // The local manifest is only a cache. Its hash must match the durable
      // Firestore receipt before subsequent passes may trust it without GCS.
      const cachedManifest = path.join(staging, "manifest.json");
      await writeFile(cachedManifest, bytes, { mode: 0o600, flag: "wx" });
      await rename(cachedManifest, path.join(directory, `.checkpoint-${stage}.json`));
    } finally { await rm(staging, { recursive: true, force: true }); }
    return digest(bytes);
  }
  return {
    restore,
    async checkpoint(stage: PreparationStage, directory: string, names: string[]): Promise<string> {
      await privateDirectory(directory);
      const files: FileReceipt[] = [];
      for (const name of names.slice().sort()) {
        safePath(name);
        const file = path.join(directory, name);
        const stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || await realpath(file) !== file ||
            stat.size > (stage === "input" && name.startsWith("images/") ? MAX_RETAINED_IMAGE_BYTES : MAX_BYTES)) throw new Error("Invalid preparation file");
        const bytes = await readFile(file);
        const sha = digest(bytes);
        if (bytes.length !== stat.size) throw new Error("Preparation file changed");
        files.push({ path: name, digest: sha, size: bytes.length });
      }
      const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, identity, files }));
      parseCheckpoint(manifest, identity, stage);
      await verifyImages(stage, directory, files);
      await transferFiles(files, stage, async file => {
        const bytes = await readFile(path.join(directory, file.path));
        if (bytes.length !== file.size || digest(bytes) !== file.digest) throw new Error("Preparation file changed");
        const retained = await put(`${prefix}/bytes/${file.digest}`, bytes, stage === "input" && file.path.startsWith("images/") ? MAX_RETAINED_IMAGE_BYTES : MAX_BYTES);
        if (!retained.equals(bytes)) throw new Error("Preparation object digest conflict");
      });
      const retained = await put(`${prefix}/${stage}.json`, manifest);
      parseCheckpoint(retained, identity, stage);
      // An interrupted builder may retry the same input. The first committed
      // checkpoint wins; consumers always restore those exact bytes.
      await restore(stage, directory);
      return digest(retained);
    },
  };
}
export const backgroundInputFiles = inputFiles;
export const backgroundOutputFiles = outputFiles;
