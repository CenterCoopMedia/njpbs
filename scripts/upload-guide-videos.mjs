#!/usr/bin/env node
// Upload Boardwalk guide videos into the private admin guide bucket.
// Credentials come from a JSON object on stdin or from the environment.
// They are never accepted as arguments and are never printed.
//
// GUIDE_VIDEOS_UPLOAD=apply writes objects. Any other value prints the plan.
// The coordinator runs the apply step after review. Do not point it at a public bucket.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  containedGuideFile,
  guideTranscriptFiles,
  planGuideVideoUpload,
  publishGuideVideoRelease,
  tarExtractArgs,
} from "./lib/guide-video-upload.mjs";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function archivePath(argv) {
  let archive = process.env.GUIDE_VIDEOS_ARCHIVE?.trim() ?? "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== "--archive") throw new Error("The only argument is --archive.");
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) throw new Error("Use --archive with a file path.");
    archive = value;
    index += 1;
  }
  if (!archive) throw new Error("Set GUIDE_VIDEOS_ARCHIVE or pass --archive.");
  return archive;
}

function credentialText(value) {
  return typeof value === "string" ? value.trim() : "";
}

async function readCredentials() {
  const fromEnv = {
    accountId: credentialText(process.env.GUIDE_VIDEOS_R2_ACCOUNT_ID),
    accessKeyId: credentialText(process.env.GUIDE_VIDEOS_R2_ACCESS_KEY_ID),
    secretAccessKey: credentialText(process.env.GUIDE_VIDEOS_R2_SECRET_ACCESS_KEY),
    bucket: credentialText(process.env.GUIDE_VIDEOS_R2_BUCKET),
    apiToken: credentialText(process.env.CLOUDFLARE_API_TOKEN),
  };
  if (process.stdin.isTTY) return fromEnv;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return fromEnv;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Credential input must be JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Credential input must be a JSON object.");
  }
  return {
    accountId: credentialText(parsed.GUIDE_VIDEOS_R2_ACCOUNT_ID) || fromEnv.accountId,
    accessKeyId: credentialText(parsed.GUIDE_VIDEOS_R2_ACCESS_KEY_ID) || fromEnv.accessKeyId,
    secretAccessKey: credentialText(parsed.GUIDE_VIDEOS_R2_SECRET_ACCESS_KEY) || fromEnv.secretAccessKey,
    bucket: credentialText(parsed.GUIDE_VIDEOS_R2_BUCKET) || fromEnv.bucket,
    apiToken: credentialText(parsed.CLOUDFLARE_API_TOKEN) || fromEnv.apiToken,
  };
}

export async function assertPrivateGuideBucket(credentials) {
  if (credentials.bucket !== "njpbs-admin-guide") {
    throw new Error("Guide videos can only be uploaded to njpbs-admin-guide.");
  }
  if (!credentials.apiToken) throw new Error("CLOUDFLARE_API_TOKEN is required before upload.");
  const headers = { authorization: `Bearer ${credentials.apiToken}` };
  const base = `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/r2/buckets/${credentials.bucket}/domains`;
  const [managedResponse, customResponse] = await Promise.all([
    fetch(`${base}/managed`, { headers }),
    fetch(`${base}/custom`, { headers }),
  ]);
  const managed = await managedResponse.json().catch(() => null);
  const custom = await customResponse.json().catch(() => null);
  if (!managedResponse.ok || managed?.success !== true || !customResponse.ok || custom?.success !== true) {
    throw new Error("The guide video bucket privacy check failed.");
  }
  if (typeof managed.result?.enabled !== "boolean" || !Array.isArray(custom.result?.domains)) {
    throw new Error("The guide video bucket privacy response is invalid.");
  }
  if (managed.result?.enabled === true) {
    throw new Error("njpbs-admin-guide must not enable its r2.dev domain.");
  }
  const domains = custom.result.domains;
  if (domains.some((domain) => !domain || domain.enabled !== false)) {
    throw new Error("njpbs-admin-guide must not have a public custom domain.");
  }
}

function requireCredentials(credentials) {
  if (!credentials.accountId || !credentials.accessKeyId || !credentials.secretAccessKey || !credentials.bucket) {
    throw new Error("R2 account, bucket, and access keys are required.");
  }
  return credentials;
}

function safeMessage(error, secrets) {
  let message = error instanceof Error ? error.message : "Guide video upload failed.";
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join("[redacted]");
  }
  return message;
}

async function fileSha256(file) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export function storageClient(credentials, client = new S3Client({
    region: "auto",
    endpoint: `https://${credentials.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
  })) {
  return {
    head: async (key) => {
      try {
        const result = await client.send(new GetObjectCommand({
          Bucket: credentials.bucket,
          Key: key,
        }));
        // Hash stored bytes, never caller-supplied metadata. Stream large MP4s.
        if (!result.Body) throw new Error("Stored guide video has no readable body.");
        const hash = createHash("sha256");
        let size = 0;
        for await (const chunk of result.Body) {
          hash.update(chunk);
          size += chunk.length;
        }
        return { size, sha256: hash.digest("hex") };
      } catch (error) {
        const status = error?.$metadata?.httpStatusCode;
        if (status === 404 || error?.name === "NotFound" || error?.name === "NoSuchKey") return null;
        throw error;
      }
    },
    put: async (file) => {
      await client.send(new PutObjectCommand({
        Bucket: credentials.bucket,
        Key: file.key,
        Body: file.body ?? createReadStream(file.file),
        ContentLength: file.size,
        ContentType: file.contentType,
        CacheControl: "private, no-store",
        Metadata: { sha256: file.sha256 },
      }));
    },
  };
}

async function main() {
  const archive = archivePath(process.argv.slice(2));
  const catalog = JSON.parse(await readFile(path.join(root, "admin/src/lib/guide-videos.json"), "utf8"));
  const listing = await exec("tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const names = listing.stdout.split("\n").filter(Boolean);
  const plan = planGuideVideoUpload(names, catalog);
  const transcripts = guideTranscriptFiles(await readFile(
    path.join(root, "site/src/pages/_admin-docs/video-tutorials/index.md"), "utf8",
  ), catalog);
  const apply = process.env.GUIDE_VIDEOS_UPLOAD === "apply";
  if (!apply) {
    for (const item of [...plan, ...transcripts]) console.log(`plan ${item.key}`);
    console.log(`Guide video upload plan: ${plan.length + transcripts.length} objects. Set GUIDE_VIDEOS_UPLOAD=apply to write them.`);
    return;
  }
  const credentials = requireCredentials(await readCredentials());
  const temp = await mkdtemp(path.join(tmpdir(), "guide-videos-"));
  try {
    await exec("tar", tarExtractArgs(archive, temp, plan.map((item) => item.member)), {
      maxBuffer: 16 * 1024 * 1024,
    });
    const files = [...transcripts];
    for (const item of plan) {
      const file = await containedGuideFile(temp, item.member);
      const info = await stat(file);
      files.push({
        ...item,
        file,
        size: info.size,
        sha256: await fileSha256(file),
      });
    }
    await assertPrivateGuideBucket(credentials);
    const release = await publishGuideVideoRelease(files, storageClient(credentials));
    console.log(`Guide video upload: release ${release} is current.`);
  } catch (error) {
    throw new Error(safeMessage(error, [
      credentials.secretAccessKey,
      credentials.accessKeyId,
      credentials.accountId,
      credentials.apiToken,
    ]));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Guide video upload failed.");
    process.exitCode = 1;
  });
}
