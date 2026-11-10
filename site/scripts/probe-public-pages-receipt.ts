import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPreparedPublicWorkerArtifact,
  MAX_PUBLICATION_RECEIPT_BYTES,
  publicPublicationReceiptMatchesPreparedArtifact,
  type PreparedPublicWorkerArtifact,
} from "../src/lib/public-publication-receipt";

const PUBLIC_ORIGIN = "https://njpbs.org";
const PROBE_PATH = "/_publication.json";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const REQUEST_TIMEOUT_MS = 5_000;

type Fetch = typeof fetch;

export interface PublicPagesReceiptProbeResult {
  buildBatchId: string;
  generation: number;
  commitSha: string;
  publicationReceiptDigest: string;
  publicUrl: string;
  visibleAtMs: number;
  attempts: number;
  cfRay: string | null;
  cfCacheStatus: string | null;
  age: string | null;
  etag: string | null;
  lastModified: string | null;
}

interface ProbeOptions {
  publicUrl: string;
  preparedArtifact: unknown;
  fetchImpl?: Fetch;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export class PublicPagesReceiptProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicPagesReceiptProbeError";
  }
}

function fail(message: string): never {
  throw new PublicPagesReceiptProbeError(message);
}

function publicationUrl(publicUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(publicUrl);
  } catch {
    fail("The public Pages URL is invalid");
  }
  if (
    parsed.origin !== PUBLIC_ORIGIN ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    fail("The public Pages URL is not the NJ PBS apex");
  }
  return new URL(PROBE_PATH, PUBLIC_ORIGIN);
}

function boundedHeader(response: Response, name: string): string | null {
  const value = response.headers.get(name)?.trim() ?? "";
  return value.length > 0 && value.length <= 256 && !/[\r\n]/.test(value)
    ? value
    : null;
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function responseBody(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PUBLICATION_RECEIPT_BYTES) {
    return null;
  }
  let body: string;
  try {
    body = await response.text();
  } catch {
    return null;
  }
  return Buffer.byteLength(body, "utf8") <= MAX_PUBLICATION_RECEIPT_BYTES
    ? body
    : null;
}

export async function probePublicPagesReceipt({
  publicUrl,
  preparedArtifact,
  fetchImpl = fetch,
  now = Date.now,
  wait = defaultWait,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: ProbeOptions): Promise<PublicPagesReceiptProbeResult> {
  const prepared = assertPreparedPublicWorkerArtifact(preparedArtifact);
  const baseProbe = publicationUrl(publicUrl);
  if (
    typeof fetchImpl !== "function" ||
    typeof now !== "function" ||
    typeof wait !== "function" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < 0
  ) {
    fail("The public Pages receipt probe input is invalid");
  }

  const deadline = now() + timeoutMs;
  let attempts = 0;
  while (now() <= deadline) {
    attempts += 1;
    const url = new URL(baseProbe);
    url.searchParams.set("cms-context", "code");
    url.searchParams.set("candidate", prepared.buildBatchId);
    url.searchParams.set("attempt", String(attempts));
    url.searchParams.set("at", String(now()));
    let response: Response | null = null;
    try {
      response = await fetchImpl(url, {
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-cache",
        },
        redirect: "error",
        signal: AbortSignal.timeout(
          Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadline - now())),
        ),
      });
    } catch {
      response = null;
    }
    const body = response?.ok ? await responseBody(response) : null;
    if (
      response &&
      body !== null &&
      response.headers.get("content-type")?.toLowerCase().startsWith(
        "application/json",
      ) &&
      publicPublicationReceiptMatchesPreparedArtifact(body, prepared)
    ) {
      return {
        buildBatchId: prepared.buildBatchId,
        generation: prepared.generation,
        commitSha: prepared.commitSha,
        publicationReceiptDigest: prepared.publicationReceiptDigest,
        publicUrl: new URL(PROBE_PATH, PUBLIC_ORIGIN).toString(),
        visibleAtMs: now(),
        attempts,
        cfRay: boundedHeader(response, "cf-ray"),
        cfCacheStatus: boundedHeader(response, "cf-cache-status"),
        age: boundedHeader(response, "age"),
        etag: boundedHeader(response, "etag"),
        lastModified: boundedHeader(response, "last-modified"),
      };
    }
    if (now() >= deadline) break;
    await wait(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
  }
  fail("The exact CMS artifact did not become visible at the NJ PBS apex");
}

async function main(args = process.argv.slice(2)): Promise<void> {
  const [publicUrl, preparedArtifactPath, deploymentReceiptPath, ...extra] = args;
  if (
    !publicUrl ||
    !preparedArtifactPath ||
    !deploymentReceiptPath ||
    extra.length > 0 ||
    !path.isAbsolute(preparedArtifactPath) ||
    !path.isAbsolute(deploymentReceiptPath)
  ) {
    fail(
      "Usage: probe-public-pages-receipt <public-url> <absolute-prepared-artifact-path> <absolute-deployment-receipt-path>",
    );
  }
  const [preparedBody, deploymentBody] = await Promise.all([
    readFile(preparedArtifactPath, "utf8"),
    readFile(deploymentReceiptPath, "utf8"),
  ]);
  const prepared = JSON.parse(preparedBody) as PreparedPublicWorkerArtifact;
  const deployment = JSON.parse(deploymentBody) as Record<string, unknown>;
  if (!deployment || typeof deployment !== "object" || Array.isArray(deployment)) {
    fail("The CMS deployment receipt is invalid");
  }
  const result = await probePublicPagesReceipt({
    publicUrl,
    preparedArtifact: prepared,
  });
  deployment.visibleAtMs = result.visibleAtMs;
  await writeFile(deploymentReceiptPath, JSON.stringify(deployment), "utf8");
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  void main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "The public Pages receipt probe failed"}\n`,
    );
    process.exitCode = 1;
  });
}
