import { cloudflareR2Endpoint } from "./cloudflare-account.mjs";
import { fstatSync } from "node:fs";
import { Socket, type SocketConstructorOpts } from "node:net";
import { createRequire } from "node:module";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import targets from "../../functions/lib/publication-target.js";
import { parsePreviewStorageCredential, type PreviewStorageCredential } from "./cms-preview-storage-credential";
import type { PairViewStore } from "./public-release-pair-view-storage";
import { withinReaderDeadline } from "./public-release-pair-reader-contract";

const require = createRequire(import.meta.url);
const { r2ClientConfig, normalizeMetadata } = require("../../functions/lib/r2-media.js");
function refuse(): never { throw new Error("Bootstrap storage provider read was refused"); }

/** Existing operator convention: one R2 credential streamed through fd3.
 * A cancellable pipe avoids leaving a blocking fs thread after a timeout. */
function inheritedSource() {
  const stat = fstatSync(3);
  if (!stat.isFIFO() && !stat.isSocket()) refuse();
  // Supported by Node22's actual constructor; older @types/node omit it.
  const options: SocketConstructorOpts & { pauseOnCreate: true } = { fd: 3, readable: true, writable: false, pauseOnCreate: true };
  const source = new Socket(options);
  source.pause(); return source;
}
async function inheritedCredential(source: Socket): Promise<PreviewStorageCredential> {
  const chunks: Buffer[] = []; let size = 0;
  const timeout = setTimeout(() => source.destroy(new Error("Bootstrap credential read expired")), 10_000);
  try {
    for await (const chunk of source) {
      const bytes = Buffer.from(chunk); chunks.push(bytes); size += bytes.length;
      if (size > 4096) refuse();
    }
    const bytes = Buffer.concat(chunks);
    try { return parsePreviewStorageCredential(bytes.toString("utf8")); }
    finally { bytes.fill(0); }
  } catch { return refuse(); }
  finally { clearTimeout(timeout); chunks.forEach(chunk => chunk.fill(0)); source.destroy(); }
}

/** No credential read at construction. The guarded store invokes this GET
 * only after checking its key and closed authority. No write/list API exists. */
export function createBootstrapS3Reads({ environment, client: supplied, readCredential }: {
  environment: "production" | "development"; client?: Pick<S3Client, "send" | "destroy">;
  readCredential?: () => Promise<PreviewStorageCredential>;
}): Pick<PairViewStore, "get"> & { getWithSignal(key: string, signal: AbortSignal): ReturnType<PairViewStore["get"]>; close(): void } {
  const target = targets.publicationTarget(environment);
  const endpoint = supplied ? undefined : cloudflareR2Endpoint();
  // Reserve the inherited, paused fd before SDK initialization can reuse a
  // missing descriptor. No credential bytes flow until the first guarded GET.
  const source = !supplied && !readCredential ? inheritedSource() : undefined;
  const credential = readCredential ?? (() => inheritedCredential(source!));
  let client: Pick<S3Client, "send" | "destroy"> | undefined = supplied, closed = false;
  let opening: Promise<Pick<S3Client, "send" | "destroy">> | undefined;
  const reads = {
    async get(key: string, signal = AbortSignal.timeout(30_000)) {
      if (closed) refuse();
      try {
        signal.throwIfAborted();
        if (!client) {
          opening ??= credential().then(credential => {
            if (closed || signal.aborted) refuse();
            return new S3Client({ ...r2ClientConfig({ endpoint,
              accessKeyId: credential.accessKeyId, secretAccessKey: credential.secretAccessKey }), maxAttempts: 1 });
          });
          const cancelSource = () => source?.destroy(new Error("Bootstrap credential read expired"));
          signal.addEventListener("abort", cancelSource, { once: true });
          try { client = await withinReaderDeadline(signal, () => opening!); }
          finally { signal.removeEventListener("abort", cancelSource); }
        }
        if (closed) refuse();
        signal.throwIfAborted();
        const response = await client.send(new GetObjectCommand({ Bucket: target.publicationBucket, Key: key }), { abortSignal: signal });
        const body = response.Body?.transformToWebStream();
        if (!body || !Number.isSafeInteger(response.ContentLength) || response.ContentLength! < 0 || response.ContentLength! > 16 * 1024 * 1024) {
          await body?.cancel(); return refuse();
        }
        return { body, size: response.ContentLength!, customMetadata: normalizeMetadata(response.Metadata) };
      } catch (error) {
        if ((error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404) return null;
        return refuse();
      }
    },
    close() { closed = true; source?.destroy(); if (!supplied) client?.destroy(); },
  };
  return { ...reads, getWithSignal: reads.get };
}
