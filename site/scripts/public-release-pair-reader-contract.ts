import { createHash } from "node:crypto";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairTaskIdentity } from "../../functions/lib/public-release-pair-work";
import protocol from "../../functions/lib/public-release-pair.js";
import view from "../../functions/lib/public-release-pair-view.js";
import { isPublicReleasePairContentFeedPagePath } from "./public-release-pair-content-feed-namespace";

import { PAIR_READER_PATHS_LIMIT, PAIR_READER_BYTES_LIMIT, PAIR_READER_CONTRACT } from "../../packages/content-core/src/private-pair-http.mjs";
export { PAIR_READER_PATH, PAIR_READER_PATHS_LIMIT, PAIR_READER_DEADLINE_MS, PAIR_READER_BYTES_LIMIT,
  PAIR_READER_REQUEST_LIMIT, PAIR_READER_REPLY_LIMIT, PAIR_READER_CONTRACT } from "../../packages/content-core/src/private-pair-http.mjs";
export type ReaderDeployment = Readonly<{ schemaVersion: 1; environment: "production" | "development";
  service: string; versionId: string; commitSha: string; contractDigest: string; origin: string }>;
export type ReaderCapabilities = Readonly<{ schemaVersion: 1; rendererSha: string;
  post: Readonly<{ dataFigureVersion: 1; electionResultsVersion: 1 | 2; liveBlogVersion: 1 }>;
  page: Readonly<{ dataFigureVersion: 1; electionResultsVersion: 1 | 2; dataHubReportingVersion: 1; dataHubCompositionVersion: 1 }>;
  record: Readonly<{ families: readonly ("programs" | "events")[];
    terminalOwner: Readonly<{ schemaVersion: 1; transport: "public-context-no-build-v1"; rendererSha: string }> }> }>;
export type ReaderSeals = Readonly<{ schemaVersion: 1; status: "verified";
  deployment: ReaderDeployment; capabilities: ReaderCapabilities }>;
export type ReaderNamespaceAbsence = Readonly<{ namespace: "/pagefind/" | "/api/v1/content/"; namespaceRootDigest: string; namespaceManifestDigest: string;
  cursor: Readonly<{ baselineDigest: string; sequence: number; lastDigest: string }>; paths: readonly string[] }>;
export type ReaderRequest = Readonly<{ schemaVersion: 2; pairDigest: string; identity: PairTaskIdentity;
  claimDigest: string; manifestDigest: string; manifestBytes: number; nonce: string; paths: readonly string[];
  absence: ReaderNamespaceAbsence | null }>;
export type ReaderOutput = Readonly<{ path: string; status: 200 | 302 | 308 | 410; headers: Readonly<Record<string, string>>;
  bodyDigest: string; bytes: number; bodyBase64: string }>;
export type ReaderNamespaceAbsenceReply = Readonly<Omit<ReaderNamespaceAbsence, "paths"> & {
  outputs: readonly Readonly<{ path: string; status: 404; kind: "namespace-absent" }>[] }>;
export type ReaderReply = Readonly<{ schemaVersion: 2; kind: "private-pair-read"; requestDigest: string;
  seals: ReaderSeals; stagedReadbackDigest: string; outputs: readonly ReaderOutput[];
  namespaceAbsence: ReaderNamespaceAbsenceReply | null }>;

export function readerRefused(): never { throw new Error("Private pair reader refused"); }
export function exact(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) readerRefused();
  return value as Record<string, unknown>;
}
export const bytesDigest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const same = (a: unknown, b: unknown) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
export const compareReaderPaths = view.comparePrivatePairArtifactPaths;
export function canonicalPath(path: unknown): path is string {
  return view.isPrivatePairArtifactPath(path) || typeof path === "string" && path.length <= 1024 &&
    /^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*$/.test(path) &&
    path.split("/").every(part => part !== "." && part !== "..");
}
export function parseReaderSeals(raw: unknown, pair: PublicReleasePair): ReaderSeals {
  const seals = exact(raw, ["schemaVersion", "status", "deployment", "capabilities"]);
  const deployment = exact(seals.deployment, ["schemaVersion", "environment", "service", "versionId", "commitSha", "contractDigest", "origin"]);
  const capabilities = exact(seals.capabilities, ["schemaVersion", "rendererSha", "post", "page", "record"]);
  const post = exact(capabilities.post, ["dataFigureVersion", "electionResultsVersion", "liveBlogVersion"]);
  const page = exact(capabilities.page, ["dataFigureVersion", "electionResultsVersion", "dataHubReportingVersion", "dataHubCompositionVersion"]);
  const record = exact(capabilities.record, ["families", "terminalOwner"]);
  const terminal = exact(record.terminalOwner, ["schemaVersion", "transport", "rendererSha"]);
  if (seals.schemaVersion !== 1 || seals.status !== "verified" || deployment.schemaVersion !== 1 ||
      deployment.environment !== pair.environment || deployment.service !== pair.publicWorker.service ||
      deployment.versionId !== pair.publicWorker.versionId || deployment.commitSha !== pair.commitSha ||
      deployment.contractDigest !== protocol.publicReleaseDigest(PAIR_READER_CONTRACT) ||
      pair.readerContractDigest !== deployment.contractDigest || pair.readerReceiptDigest !== protocol.publicReleaseDigest(deployment) ||
      capabilities.schemaVersion !== 1 || capabilities.rendererSha !== pair.commitSha ||
      [post, page].some(cap => Object.entries(cap).some(([key, value]) => key === "electionResultsVersion" ? ![1, 2].includes(value as number) : value !== 1)) ||
      !Array.isArray(record.families) || !same(record.families, ["programs", "events"]) ||
      terminal.schemaVersion !== 1 || terminal.transport !== "public-context-no-build-v1" || terminal.rendererSha !== pair.commitSha ||
      pair.capabilityDigest !== protocol.publicReleaseDigest(capabilities) || typeof deployment.origin !== "string") readerRefused();
  const origin = new URL(deployment.origin);
  // HTTP exists solely for real loopback demo-emulator tests; never for a live pair.
  const demo = pair.environment === "development" && /^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "");
  if (origin.origin !== deployment.origin || origin.username || origin.password ||
      (origin.protocol !== "https:" && !(demo && origin.protocol === "http:" && origin.hostname === "127.0.0.1"))) readerRefused();
  return Object.freeze({ schemaVersion: 1, status: "verified", deployment: Object.freeze({ ...deployment }) as ReaderDeployment,
    capabilities: Object.freeze({ schemaVersion: 1, rendererSha: pair.commitSha,
      post: Object.freeze({ ...post }), page: Object.freeze({ ...page }),
      record: Object.freeze({ families: Object.freeze([...record.families]), terminalOwner: Object.freeze({ ...terminal }) }) }) as ReaderCapabilities });
}
/** Version 2 readers retain every version 1 election snapshot. */
export function supportedReaderFeatures(seals: ReaderSeals): Set<string> {
  return new Set([...Object.entries(seals.capabilities.post), ...Object.entries(seals.capabilities.page)]
    .flatMap(([name, version]) => name === "electionResultsVersion" && version === 2
      ? [`${name}:1`, `${name}:2`] : version === 1 ? [`${name}:1`] : []));
}
export function isReaderNamespacePath(namespace: unknown, path: unknown): path is string {
  return namespace === "/pagefind/" ? canonicalPath(path) && path.startsWith(namespace) && path !== namespace
    : namespace === "/api/v1/content/" && isPublicReleasePairContentFeedPagePath(path);
}
export function parseReaderRequest(raw: unknown, pair: PublicReleasePair): ReaderRequest {
  const value = exact(raw, ["schemaVersion", "pairDigest", "identity", "claimDigest", "manifestDigest", "manifestBytes", "nonce", "paths", "absence"]);
  const identity = view.parseViewIdentity(value.identity, pair);
  const paths = value.paths;
  if (value.schemaVersion !== 2 || value.pairDigest !== protocol.publicReleaseDigest(pair) ||
      ![value.claimDigest, value.manifestDigest, value.nonce].every(item => typeof item === "string" && /^[a-f0-9]{64}$/.test(item)) ||
      !Number.isSafeInteger(value.manifestBytes) || (value.manifestBytes as number) < 1 ||
      (value.manifestBytes as number) > view.VIEW_ROOT_BYTES_LIMIT || !Array.isArray(paths) ||
      paths.length > PAIR_READER_PATHS_LIMIT ||
      paths.some((path, index) => !canonicalPath(path) || index > 0 && compareReaderPaths(paths[index - 1], path) >= 0)) readerRefused();
  let absence: ReaderNamespaceAbsence | null = null;
  if (value.absence !== null) {
    const rawAbsence = exact(value.absence, ["namespace", "namespaceRootDigest", "namespaceManifestDigest", "cursor", "paths"]);
    const missing = rawAbsence.paths;
    const cursor = view.parsePublicReleasePairViewCursor(rawAbsence.cursor, identity);
    if (!["/pagefind/", "/api/v1/content/"].includes(rawAbsence.namespace as string) || ![rawAbsence.namespaceRootDigest, rawAbsence.namespaceManifestDigest]
        .every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) || !Array.isArray(missing) || !missing.length ||
        missing.length + paths.length > PAIR_READER_PATHS_LIMIT || missing.some((path, index) => !isReaderNamespacePath(rawAbsence.namespace, path) || paths.includes(path) || index > 0 && compareReaderPaths(missing[index - 1], path) >= 0)) readerRefused();
    absence = Object.freeze({ namespace: rawAbsence.namespace as ReaderNamespaceAbsence["namespace"], namespaceRootDigest: rawAbsence.namespaceRootDigest as string,
      namespaceManifestDigest: rawAbsence.namespaceManifestDigest as string,
      cursor, paths: Object.freeze([...missing]) });
  }
  if (!paths.length && !absence) readerRefused();
  return Object.freeze({ ...value, identity, paths: Object.freeze([...paths]), absence }) as ReaderRequest;
}
export function parseReaderReply(raw: unknown, pair: PublicReleasePair, request: ReaderRequest): ReaderReply {
  const value = exact(raw, ["schemaVersion", "kind", "requestDigest", "seals", "stagedReadbackDigest", "outputs", "namespaceAbsence"]);
  const seals = parseReaderSeals(value.seals, pair);
  if (value.schemaVersion !== 2 || value.kind !== "private-pair-read" || value.requestDigest !== protocol.publicReleaseDigest(request) ||
      typeof value.stagedReadbackDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.stagedReadbackDigest) ||
      !Array.isArray(value.outputs) || value.outputs.length !== request.paths.length) readerRefused();
  let total = 0;
  const outputs = value.outputs.map((rawOutput, index) => {
    const output = exact(rawOutput, ["path", "status", "headers", "bodyDigest", "bytes", "bodyBase64"]);
    if (output.path !== request.paths[index] || typeof output.bodyBase64 !== "string" ||
        output.bodyBase64.length > Math.ceil(PAIR_READER_BYTES_LIMIT / 3) * 4) readerRefused();
    const body = Buffer.from(output.bodyBase64, "base64");
    if (body.toString("base64") !== output.bodyBase64 || body.byteLength !== output.bytes || bytesDigest(body) !== output.bodyDigest) readerRefused();
    total += body.byteLength;
    if (total > PAIR_READER_BYTES_LIMIT) readerRefused();
    const descriptor = view.parsePublicReleasePairViewOutput({ path: output.path, status: output.status, headers: output.headers,
      bodyDigest: output.bodyDigest, bytes: output.bytes,
      objectKey: view.publicReleasePairViewObjectKey(pair, request.identity, request.claimDigest, output.bodyDigest as string) },
      pair, request.identity, request.claimDigest);
    return Object.freeze({ path: descriptor.path, status: descriptor.status, headers: descriptor.headers,
      bodyDigest: descriptor.bodyDigest, bytes: descriptor.bytes, bodyBase64: output.bodyBase64 });
  });
  let namespaceAbsence: ReaderNamespaceAbsenceReply | null = null;
  if (request.absence) {
    const claimed = exact(value.namespaceAbsence, ["namespace", "namespaceRootDigest", "namespaceManifestDigest", "cursor", "outputs"]);
    const missing = claimed.outputs;
    if (claimed.namespace !== request.absence.namespace || claimed.namespaceRootDigest !== request.absence.namespaceRootDigest ||
        claimed.namespaceManifestDigest !== request.absence.namespaceManifestDigest ||
        !same(claimed.cursor, request.absence.cursor) || !Array.isArray(missing) || missing.length !== request.absence.paths.length) readerRefused();
    const absentOutputs = missing.map((raw, index) => {
      const row = exact(raw, ["path", "status", "kind"]);
      if (row.path !== request.absence!.paths[index] || row.status !== 404 || row.kind !== "namespace-absent") readerRefused();
      return Object.freeze({ path: row.path as string, status: 404 as const, kind: "namespace-absent" as const });
    });
    namespaceAbsence = Object.freeze({ namespace: request.absence.namespace, namespaceRootDigest: request.absence.namespaceRootDigest,
      namespaceManifestDigest: request.absence.namespaceManifestDigest,
      cursor: request.absence.cursor, outputs: Object.freeze(absentOutputs) });
  } else if (value.namespaceAbsence !== null) readerRefused();
  return Object.freeze({ schemaVersion: 2, kind: "private-pair-read", requestDigest: value.requestDigest,
    seals, stagedReadbackDigest: value.stagedReadbackDigest, outputs: Object.freeze(outputs), namespaceAbsence });
}

/** A bound applies to decoded bytes too. Cancellation and the caller's fixed
 * deadline cover a slow or never-ending response, not just receipt headers. */
export async function readBoundedBody(body: ReadableStream<Uint8Array> | null, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!body) readerRefused();
  const reader = body.getReader(), chunks: Uint8Array[] = [];
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  let size = 0;
  try {
    signal.throwIfAborted();
    while (true) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) readerRefused();
      chunks.push(next.value);
    }
    return Buffer.concat(chunks, size);
  } finally { signal.removeEventListener("abort", cancel); cancel(); }
}

export async function withinReaderDeadline<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([operation(), new Promise<never>((_, reject) => {
      abort = () => reject(new Error("Private pair read deadline"));
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally { if (abort) signal.removeEventListener("abort", abort); }
}
