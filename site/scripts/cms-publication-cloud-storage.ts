import { cloudflareR2Endpoint } from "./cloudflare-account.mjs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { publicationTarget, assertPublicationTarget, type PublicationTarget } from "../../functions/lib/publication-target.js";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";

const require = createRequire(
  new URL("../../functions/package.json", import.meta.url),
);
const {
  isConditionalConflict,
  normalizeMetadata,
  r2ClientConfig,
} = require("./lib/r2-media.js");
const MAX_OBJECT_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_FILES = 100_000;
const CACHE_CONTROL = "private, no-store, max-age=0";
const CONTENT_TYPE = "application/octet-stream";
const DIGEST = /^[a-f0-9]{64}$/;
const TOP_FILES = [
  "artifact-inventory.json",
  "prepared-worker.json",
  "public-context.json",
];
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

export interface CloudPublicationIdentity {
  queueId: string;
  commitSha: string;
  buildBatchId: string;
  inputSha256: string;
}
interface ArtifactFile {
  path: string;
  byteLength: number;
  sha256: string;
}
interface ArtifactManifest extends CloudPublicationIdentity {
  schemaVersion: 1;
  files: ArtifactFile[];
}

async function transferFiles(
  files: ArtifactFile[],
  transfer: (file: ArtifactFile) => Promise<void>,
) {
  // Bound memory and requests, and wait for every active transfer before an
  // error lets the caller remove its private staging directory.
  for (let offset = 0; offset < files.length; offset += 4) {
    const results = await Promise.allSettled(
      files.slice(offset, offset + 4).map(transfer),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}

function prefix(queueId: string) {
  if (!/^[A-Za-z0-9]{20}$/.test(queueId))
    throw new Error("Invalid cloud publication queue identity");
  return `publication/${queueId}`;
}
function assertIdentity(identity: CloudPublicationIdentity) {
  prefix(identity.queueId);
  if (
    !/^[a-f0-9]{40}$/.test(identity.commitSha) ||
    identity.buildBatchId !== `cms-${identity.queueId}` ||
    !DIGEST.test(identity.inputSha256)
  )
    throw new Error("Invalid cloud publication identity");
}
function assertFilePath(file: string) {
  const parts = file.split("/");
  if (
    file.includes("\\") ||
    file.includes("\0") ||
    parts.some((part) => !part || part === "." || part === "..") ||
    !(TOP_FILES.includes(file) || (["dist", "renderer"].includes(parts[0]) && parts.length > 1))
  ) {
    throw new Error("Invalid cloud publication artifact path");
  }
}
function parseManifest(
  bytes: Buffer,
  identity: CloudPublicationIdentity,
  includeRenderer = false,
): ArtifactManifest {
  assertIdentity(identity);
  const manifest = JSON.parse(bytes.toString("utf8")) as ArtifactManifest;
  if (
    !manifest ||
    manifest.schemaVersion !== 1 ||
    Object.entries(identity).some(
      ([key, value]) => manifest[key as keyof ArtifactManifest] !== value,
    ) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length < TOP_FILES.length + 1 ||
    manifest.files.length > MAX_FILES
  ) {
    throw new Error("Cloud publication artifact identity differs");
  }
  const paths = new Set<string>();
  let total = 0;
  for (const file of manifest.files) {
    if (!file || typeof file.path !== "string")
      throw new Error("Invalid cloud publication artifact file");
    assertFilePath(file.path);
    if (
      paths.has(file.path) ||
      !Number.isSafeInteger(file.byteLength) ||
      file.byteLength < 0 ||
      file.byteLength > MAX_OBJECT_BYTES ||
      typeof file.sha256 !== "string" ||
      !DIGEST.test(file.sha256)
    ) {
      throw new Error("Invalid cloud publication artifact file");
    }
    paths.add(file.path);
    total += file.byteLength;
  }
  if (
    total > MAX_ARTIFACT_BYTES ||
    TOP_FILES.some((file) => !paths.has(file)) ||
    (includeRenderer && (!paths.has("renderer/renderer-release.json") || !paths.has("renderer/server/entry.mjs")))
  ) {
    throw new Error(
      "Cloud publication artifact is incomplete or exceeds its size limit",
    );
  }
  for (const file of paths) {
    const parts = file.split("/");
    while (parts.length > 1) {
      parts.pop();
      if (paths.has(parts.join("/")))
        throw new Error("Conflicting cloud publication artifact paths");
    }
  }
  return manifest;
}
async function privateDirectory(directory: string) {
  const stat = await lstat(directory);
  if (
    !path.isAbsolute(directory) ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (await realpath(directory)) !== directory
  ) {
    throw new Error(
      "Cloud publication job directory must be private and canonical",
    );
  }
}
async function artifactFiles(directory: string, includeRenderer = false): Promise<ArtifactFile[]> {
  const files: ArtifactFile[] = [];
  let total = 0;
  async function visit(relative: string): Promise<void> {
    const absolute = path.join(directory, relative);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink())
      throw new Error("Cloud publication artifact contains a symbolic link");
    if (stat.isDirectory()) {
      if (!["dist", "renderer"].some(root => relative === root || relative.startsWith(`${root}/`)))
        throw new Error("Invalid artifact directory");
      for (const entry of (await readdir(absolute)).sort())
        await visit(`${relative}/${entry}`);
      return;
    }
    assertFilePath(relative);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_OBJECT_BYTES)
      throw new Error("Invalid cloud publication artifact file");
    total += stat.size;
    if (total > MAX_ARTIFACT_BYTES || files.length >= MAX_FILES)
      throw new Error("Cloud publication artifact exceeds its size limit");
    const bytes = await readFile(absolute);
    if (bytes.length !== stat.size)
      throw new Error("Cloud publication artifact changed during checkpoint");
    files.push({
      path: relative,
      byteLength: bytes.length,
      sha256: digest(bytes),
    });
  }
  for (const file of [...TOP_FILES, "dist", ...(includeRenderer ? ["renderer"] : [])]) await visit(file);
  return files;
}

/** Private immutable input and build checkpoints. The manifest is committed
 * last; an interrupted upload cannot become a recoverable artifact. */
export function createCmsPublicationCloudStorage({
  accessKeyId,
  secretAccessKey,
  client,
  includeRenderer = false,
  target: configuredTarget = publicationTarget(),
}: {
  accessKeyId?: string;
  secretAccessKey?: string;
  client?: S3Client;
  includeRenderer?: boolean;
  target?: PublicationTarget;
}) {
  const target = assertPublicationTarget(configuredTarget);
  const BUCKET = target.publicationBucket;
  if (!client && (!accessKeyId || !secretAccessKey))
    throw new Error("Cloud publication storage credentials are required");
  const storage =
    client ??
    new S3Client({
      ...r2ClientConfig({
        endpoint:
          cloudflareR2Endpoint(),
        accessKeyId,
        secretAccessKey,
      }),
      maxAttempts: 3,
    });
  // A caller's deadline also cancels the request, not only the per-request timeout.
  const options = (signal?: AbortSignal) => ({
    abortSignal: signal ? AbortSignal.any([AbortSignal.timeout(60_000), signal]) : AbortSignal.timeout(60_000),
  });
  async function read(key: string, signal?: AbortSignal): Promise<Buffer | null> {
    let object;
    try {
      object = await storage.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: key }),
        options(signal),
      );
    } catch (error) {
      if (
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode === 404
      )
        return null;
      throw error;
    }
    if (
      !object.Body ||
      !Number.isSafeInteger(object.ContentLength) ||
      object.ContentLength! < 0 ||
      object.ContentLength! > MAX_OBJECT_BYTES ||
      object.ContentType !== CONTENT_TYPE ||
      object.CacheControl !== CACHE_CONTROL
    ) {
      await object.Body?.transformToWebStream().cancel();
      throw new Error("Invalid cloud publication storage object");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of object.Body.transformToWebStream()) {
      size += chunk.length;
      if (size > MAX_OBJECT_BYTES)
        throw new Error(
          "Cloud publication storage object exceeds its size limit",
        );
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks, size);
    const metadata = normalizeMetadata(object.Metadata);
    if (
      size !== object.ContentLength ||
      metadata.schema !== "njpbs-publication-v1" ||
      metadata.sha256 !== digest(bytes)
    ) {
      throw new Error("Cloud publication storage bytes differ");
    }
    return bytes;
  }
  async function put(key: string, bytes: Buffer): Promise<Buffer> {
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_OBJECT_BYTES)
      throw new Error("Cloud publication object exceeds its size limit");
    try {
      await storage.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: bytes,
          ContentLength: bytes.length,
          ContentType: CONTENT_TYPE,
          CacheControl: CACHE_CONTROL,
          Metadata: { schema: "njpbs-publication-v1", sha256: digest(bytes) },
          IfNoneMatch: "*",
        }),
        options(),
      );
    } catch (error) {
      if (!isConditionalConflict(error)) throw error;
    }
    const stored = await read(key);
    if (!stored) throw new Error("Cloud publication upload was not retained");
    return stored;
  }
  async function restoreArtifact(
    identity: CloudPublicationIdentity,
    directory: string,
    expectedDigest?: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    assertIdentity(identity);
    await privateDirectory(directory);
    const bytes = await read(`${prefix(identity.queueId)}/manifest.json`, signal);
    if (!bytes) return false;
    if (expectedDigest !== undefined && (!DIGEST.test(expectedDigest) || digest(bytes) !== expectedDigest)) throw new Error("Cloud release manifest digest differs");
    const manifest = parseManifest(bytes, identity, includeRenderer);
    const staging = await mkdtemp(path.join(directory, ".restore-"));
    try {
      await transferFiles(manifest.files, async (file) => {
        const payload = await read(
          `${prefix(identity.queueId)}/files/${file.sha256}`,
          signal,
        );
        if (
          !payload ||
          payload.length !== file.byteLength ||
          digest(payload) !== file.sha256
        ) {
          throw new Error("Cloud publication artifact bytes differ");
        }
        const target = path.join(staging, file.path);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, payload, { flag: "wx", mode: 0o600 });
      });
      // Only complete, verified files replace disposable job output. If stopped
      // during promotion, the next start restores the same committed manifest.
      for (const name of [...TOP_FILES, "dist", ...(includeRenderer ? ["renderer"] : [])]) {
        await rm(path.join(directory, name), { recursive: true, force: true });
        await rename(path.join(staging, name), path.join(directory, name));
      }
      return true;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  return {
    target,
    includesRenderer: includeRenderer,
    assertReady: async () => {
      await storage.send(new HeadBucketCommand({ Bucket: BUCKET }), options());
    },
    readInput: (queueId: string) => read(`${prefix(queueId)}/input.json`),
    freezeInput: (queueId: string, bytes: Buffer) =>
      put(`${prefix(queueId)}/input.json`, bytes),
    restoreArtifact,
    checkpointArtifact: async (
      identity: CloudPublicationIdentity,
      directory: string,
    ) => {
      assertIdentity(identity);
      await privateDirectory(directory);
      const manifest: ArtifactManifest = {
        schemaVersion: 1,
        ...identity,
        files: await artifactFiles(directory, includeRenderer),
      };
      const encoded = Buffer.from(`${JSON.stringify(manifest)}\n`);
      parseManifest(encoded, identity, includeRenderer);
      await transferFiles(manifest.files, async (file) => {
        const payload = await readFile(path.join(directory, file.path));
        if (
          payload.length !== file.byteLength ||
          digest(payload) !== file.sha256
        )
          throw new Error("Artifact changed during checkpoint");
        const stored = await put(
          `${prefix(identity.queueId)}/files/${file.sha256}`,
          payload,
        );
        if (!stored.equals(payload))
          throw new Error("Cloud publication artifact digest conflict");
      });
      const committed = await put(
        `${prefix(identity.queueId)}/manifest.json`,
        encoded,
      );
      parseManifest(committed, identity, includeRenderer);
      // A retry can finish a different build from the same frozen input. The
      // first complete checkpoint wins and must be used before inclusion.
      if (!committed.equals(encoded))
        await restoreArtifact(identity, directory);
      return digest(committed);
    },
    close: () => {
      if (!client) storage.destroy();
    },
  };
}
