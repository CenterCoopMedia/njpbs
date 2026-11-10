import { assertPublicationTarget, type PublicationTarget } from "../../functions/lib/publication-target";
import { createPublicContentLastGood, lastGoodObjectKey, readRetainedHtml, readVerifiedLastGoodBytes,
  reportLastGoodRetentionFailure, retainedHtmlDigest, type ContentStore, type PublicContentLastGood } from "./public-content-last-good";

/** #4125 byte boundary: the complete origin HTML carried in an authenticated
 * JSON representation at the canonical public route. Wrap the real owner; do
 * not render a separate proof page or accept an HTML digest header as evidence.
 *
 * The verifier independently pins provider version, source, artifact generation,
 * route, operation/source-version/snapshot (or Page context revision), and HTML
 * digest. A random single-use five-second challenge binds those identities to
 * the public request. Domain-separated HMACs authenticate request and response.
 * Only the real owner can grant retention eligibility; the adapter awaits that
 * exact owner write. Both origin and verifier read/hash the R2 object, including trailers.
 * The verifier also compares every decoded HTML byte with its own R2 readback.
 *
 * Ordinary HTML, including downstream analytics injection, is unchanged. There
 * is no beacon stripping, normalization or no-transform directive. Altering the
 * proof JSON or its decoded body refuses. This proves the named origin boundary;
 * it does not certify equality of the ordinary transformed HTML wire body.
 *
 * No entrypoint or release packet enables this adapter yet. Adoption must bind
 * a nonextractable HMAC CryptoKey from installation-owned credentials and the
 * provider's immutable version metadata to this exact deployed source/artifact.
 * The observer needs independent read-only R2 access and independently current
 * authority expectations; it must never learn expectations from this response.
 * Keep existing wire/header mismatch refusal until that reviewed integration
 * and new-generation canonical Page AND published Post receipts are accepted.
 */
export const RETAINED_PROOF_HEADER = "x-njpbs-retained-byte-proof";
export const RETAINED_PROOF_TYPE = "application/vnd.njpbs.retained-byte-proof+json";
const LIFETIME_MS = 5_000, MAX_PROOF_BYTES = 6 * 1024 * 1024;
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function fail(): never { throw new Error("Retained byte proof refused"); }
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const decimal = (value: string | null) => value !== null && /^[1-9]\d*$/.test(value) && positive(Number(value));
const digestPattern = /^[a-f0-9]{64}$/;
const authorityNames = ["x-njpbs-content-source", "x-njpbs-context-sha256", "x-njpbs-public-context-revision",
  "x-njpbs-publication-operation", "x-njpbs-source-version", "x-njpbs-snapshot-sha256", "x-njpbs-admission-revision"] as const;
export type RetainedProofOwnerContext = {
  /** The owner calls store only after its existing final authority gate. */
  lastGood: PublicContentLastGood;
  /** Nonce-scoped keys force fresh reads while preserving the real cache/purges. */
  cache: Pick<Cache, "match" | "put">;
  /** Unique per fetch, so owners cannot join another request's cache witness. */
  authorityScope: object;
};
export type RetainedDeployment = { rendererSha: string; versionId: string; codeGeneration: number };
export type RetainedByteExpectation = { path: string; bodyDigest: string; authority: Record<string, string | null> };
type Challenge = { nonce: string; issuedAt: number };
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function validDeployment(value: RetainedDeployment) {
  if (!exact(value, ["rendererSha", "versionId", "codeGeneration"]) || !/^[a-f0-9]{40}$/.test(value.rendererSha) ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(value.versionId) || !positive(value.codeGeneration)) fail();
}
function copyDeployment(value: RetainedDeployment): RetainedDeployment {
  validDeployment(value);
  return { rendererSha: value.rendererSha, versionId: value.versionId, codeGeneration: value.codeGeneration };
}
function canonicalPath(path: string) {
  return path === "/" || /^\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(path) ||
    /^\/posts\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(path);
}
function fresh(challenge: Challenge, now: number) {
  if (!exact(challenge, ["nonce", "issuedAt"]) || typeof challenge.nonce !== "string" || !digestPattern.test(challenge.nonce) ||
      !positive(challenge.issuedAt) || !Number.isSafeInteger(now) || now < challenge.issuedAt ||
      now - challenge.issuedAt >= LIFETIME_MS) fail();
}
async function withinLifetime<T>(challenge: Challenge, now: () => number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  fresh(challenge, now());
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(controller.signal), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("Retained byte proof refused")); },
        Math.max(1, challenge.issuedAt + LIFETIME_MS - now()));
    })]);
  } finally { clearTimeout(timer); }
}
function validateKey(key: CryptoKey) {
  const algorithm = key.algorithm as KeyAlgorithm & { hash: KeyAlgorithm; length: number };
  if (key.type !== "secret" || key.extractable || algorithm.name !== "HMAC" || algorithm.hash.name !== "SHA-256" ||
      algorithm.length < 256 || !key.usages.includes("sign") || !key.usages.includes("verify")) fail();
}
async function sign(key: CryptoKey, domain: string, value: unknown) {
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encode([domain, value]))));
}
async function verify(key: CryptoKey, domain: string, value: unknown, mac: unknown) {
  if (typeof mac !== "string" || !digestPattern.test(mac)) fail();
  const signature = Uint8Array.from(mac.match(/../g)!, part => parseInt(part, 16));
  if (!await crypto.subtle.verify("HMAC", key, signature, encode([domain, value]))) fail();
}
function authority(headers: Headers, path: string): Record<string, string | null> {
  const source = headers.get("x-njpbs-content-source");
  if (!(path.startsWith("/posts/") ? ["cms-no-build"] :
      ["cms-page-no-build", "cms-page-context"]).includes(source ?? "") ||
      !digestPattern.test(headers.get("x-njpbs-context-sha256") ?? "")) fail();
  if (source === "cms-page-context") {
    if (!decimal(headers.get("x-njpbs-public-context-revision")) ||
        headers.has("x-njpbs-source-version") && !decimal(headers.get("x-njpbs-source-version"))) fail();
  } else if (!/^[A-Za-z0-9]{20}$/.test(headers.get("x-njpbs-publication-operation") ?? "") ||
      !decimal(headers.get("x-njpbs-source-version")) || !digestPattern.test(headers.get("x-njpbs-snapshot-sha256") ?? "") ||
      !decimal(headers.get("x-njpbs-admission-revision"))) fail();
  return Object.fromEntries(authorityNames.map(name => [name, headers.get(name)]));
}
function originAuthority(origin: Response, path: string, deployment: RetainedDeployment) {
  if (origin.status !== 200 || !origin.body || origin.headers.has("set-cookie") || origin.headers.has("content-range") ||
      origin.headers.get("content-type") !== "text/html; charset=utf-8" ||
      origin.headers.get("x-njpbs-renderer-sha") !== deployment.rendererSha ||
      origin.headers.get("x-njpbs-code-generation") !== String(deployment.codeGeneration)) fail();
  return authority(origin.headers, path);
}
function bodyBase64(bytes: Uint8Array) {
  let value = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) value += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(value);
}
function decodeBody(value: unknown) {
  if (typeof value !== "string" || value.length > Math.ceil(4 * 1024 * 1024 / 3) * 4) fail();
  let binary: string;
  try { binary = atob(value); } catch { return fail(); }
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  if (bodyBase64(bytes) !== value) fail();
  return bytes;
}
async function readEnvelope(response: Response, signal: AbortSignal) {
  if (response.status !== 200 || response.headers.get("content-type") !== RETAINED_PROOF_TYPE || !response.body ||
      response.headers.has("set-cookie") || response.headers.has("content-range")) fail();
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal.aborted) { onAbort(); fail(); }
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) fail();
      if (done) break;
      size += value.length; if (size > MAX_PROOF_BYTES) fail(); chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes), value = JSON.parse(text);
    if (JSON.stringify(value) !== text) fail();
    return value;
  } catch { return fail(); }
}

/** Wrap the actual authority-checked owner. Deployment identity must come from
 * immutable provider-bound configuration, never request headers. Key provisioning
 * and entrypoint adoption are separate, reviewed installation steps. */
export function createRetainedByteProofHandler({ target: rawTarget, deployment: rawDeployment, key, store, cache, serve, now = Date.now }: {
  target: PublicationTarget; deployment: RetainedDeployment; key: CryptoKey; store: ContentStore; cache: Pick<Cache, "match" | "put">;
  serve(request: Request, proof?: RetainedProofOwnerContext): Promise<Response>; now?: () => number;
}) {
  const target = assertPublicationTarget(rawTarget), deployment = copyDeployment(rawDeployment);
  validDeployment(deployment); validateKey(key);
  const lastGood = createPublicContentLastGood({ target, rendererSha: deployment.rendererSha, store });
  return {
    async fetch(request: Request): Promise<Response> {
      const header = request.headers.get(RETAINED_PROOF_HEADER);
      if (header === null) return serve(request);
      let stage: "proof-request" | "proof-origin" | "proof-retention" | "proof-readback" = "proof-request";
      try {
        const url = new URL(request.url);
        if (header.length > 512 || request.method !== "GET" || url.origin !== target.origin || url.href !== `${target.origin}${url.pathname}` ||
            !canonicalPath(url.pathname) || ["authorization", "cookie", "range"].some(name => request.headers.has(name))) fail();
        const input = JSON.parse(header);
        if (!exact(input, ["nonce", "issuedAt", "mac"])) fail();
        const challenge = { nonce: input.nonce as string, issuedAt: input.issuedAt as number };
        fresh(challenge, now());
        return await withinLifetime(challenge, now, async signal => {
          const binding = { url: url.href, worker: target.workerName, deployment, challenge };
          await verify(key, "njpbs-retained-request-v1", binding, input.mac);
          // Fresh authority remains the route owner's job. No caller credentials,
          // proof marker, conditionals or range can alter its canonical GET.
          const originRequest = new Request(url.href, { signal, headers: { accept: "text/html", "cache-control": "no-cache" } });
          stage = "proof-origin";
          const writes: { response: Headers; promise: Promise<void> }[] = [];
          const ownerRetention: PublicContentLastGood = {
            read: (...args) => lastGood.read(...args),
            store(ownerRequest, response) {
              if (ownerRequest.url !== originRequest.url || ownerRequest.method !== "GET") fail();
              originAuthority(response, url.pathname, deployment);
              const headers = new Headers(response.headers);
              const promise = lastGood.store(ownerRequest, response);
              writes.push({ response: headers, promise });
              return promise;
            },
          };
          const scopedKey = (input: RequestInfo | URL) => {
            const request = new Request(input), url = new URL(request.url);
            url.searchParams.set("__njpbs_retained_proof", challenge.nonce);
            return new Request(url, request);
          };
          // Keep Cache-Tag purge witnesses on the actual cache. An always-miss
          // cache would make the Post owner's final purge check fail, while a
          // private in-memory cache would hide concurrent publication purges.
          const origin = await serve(originRequest, { lastGood: ownerRetention, authorityScope: {}, cache: {
            match: request => cache.match(scopedKey(request)),
            put: (request, response) => cache.put(scopedKey(request), response),
          } });
          const owner = originAuthority(origin, url.pathname, deployment);
          const bytes = await readRetainedHtml(origin.body!, signal);
          const bodyDigest = await retainedHtmlDigest(bytes);
          if (origin.headers.get("x-njpbs-html-sha256") !== bodyDigest) fail();
          // Serving bounded-churn bytes does not grant retention eligibility.
          // Only an actual owner store() call after its final gate can do that.
          stage = "proof-retention";
          if (writes.length !== 1 || writes[0].response.get("x-njpbs-html-sha256") !== bodyDigest ||
              writes[0].response.get("x-njpbs-renderer-sha") !== deployment.rendererSha ||
              writes[0].response.get("x-njpbs-code-generation") !== String(deployment.codeGeneration) ||
              JSON.stringify(authority(writes[0].response, url.pathname)) !== JSON.stringify(owner)) fail();
          await writes[0].promise;
          stage = "proof-readback";
          if (!await readVerifiedLastGoodBytes(store, target, deployment.rendererSha, deployment.codeGeneration, url.pathname, bodyDigest, signal)) fail();
          const proof = { schemaVersion: 1, ...binding, authority: owner, bodyDigest, body: bodyBase64(bytes) };
          fresh(challenge, now());
          const mac = await sign(key, "njpbs-retained-response-v1", proof);
          return new Response(JSON.stringify({ proof, mac }), { headers: { "content-type": RETAINED_PROOF_TYPE,
            "cache-control": "no-store", "x-content-type-options": "nosniff" } });
        });
      } catch (error) {
        reportLastGoodRetentionFailure(stage, error);
        return new Response(null, { status: 503, headers: { "cache-control": "no-store" } });
      }
    },
  };
}

/** One verifier per observation. Consumes its unpredictable challenge even on
 * failure. R2 access must be independently authenticated and read-only. */
export async function createRetainedByteObservation({ target: rawTarget, deployment: rawDeployment, expected: rawExpected, key, now = Date.now }: {
  target: PublicationTarget; deployment: RetainedDeployment; expected: RetainedByteExpectation; key: CryptoKey; now?: () => number;
}) {
  const target = assertPublicationTarget(rawTarget), deployment = copyDeployment(rawDeployment),
    expected = { ...rawExpected, authority: { ...rawExpected.authority } };
  validDeployment(deployment); validateKey(key);
  if (!canonicalPath(expected.path) || !digestPattern.test(expected.bodyDigest) ||
      !exact(expected.authority, [...authorityNames])) fail();
  const headers = new Headers(Object.entries(expected.authority).filter((entry): entry is [string, string] => entry[1] !== null));
  const orderedAuthority = authority(headers, expected.path);
  if (authorityNames.some(name => orderedAuthority[name] !== expected.authority[name])) fail();
  expected.authority = orderedAuthority;
  const challenge = { nonce: hex(crypto.getRandomValues(new Uint8Array(32))), issuedAt: now() };
  fresh(challenge, now());
  const url = `${target.origin}${expected.path}`;
  const binding = { url, worker: target.workerName, deployment, challenge };
  const mac = await sign(key, "njpbs-retained-request-v1", binding);
  const request = new Request(url, { redirect: "manual", headers: { [RETAINED_PROOF_HEADER]: JSON.stringify({ ...challenge, mac }),
    accept: RETAINED_PROOF_TYPE, "cache-control": "no-cache", "accept-encoding": "identity" } });
  let consumed = false;
  return { request,
    async verify(response: Response, r2: Pick<ContentStore, "get">) {
      if (consumed) fail(); consumed = true;
      return withinLifetime(challenge, now, async signal => {
        // A network redirect cannot substitute a different public route.
        if (response.redirected || response.url && response.url !== url) fail();
        const envelope = await readEnvelope(response, signal);
        if (!exact(envelope, ["proof", "mac"]) || !exact(envelope.proof,
          ["schemaVersion", "url", "worker", "deployment", "challenge", "authority", "bodyDigest", "body"])) fail();
        const proof = envelope.proof;
        await verify(key, "njpbs-retained-response-v1", proof, envelope.mac);
        if (proof.schemaVersion !== 1 || proof.url !== url || proof.worker !== target.workerName ||
            JSON.stringify(proof.deployment) !== JSON.stringify(deployment) || JSON.stringify(proof.challenge) !== JSON.stringify(challenge) ||
            JSON.stringify(proof.authority) !== JSON.stringify(expected.authority) || proof.bodyDigest !== expected.bodyDigest) fail();
        const bytes = decodeBody(proof.body);
        if (await retainedHtmlDigest(bytes) !== expected.bodyDigest) fail();
        const retained = await readVerifiedLastGoodBytes(r2, target, deployment.rendererSha, deployment.codeGeneration, expected.path, expected.bodyDigest, signal);
        if (!retained || retained.length !== bytes.length || !retained.every((byte, index) => byte === bytes[index])) fail();
        fresh(challenge, now());
        return { boundary: "origin-html" as const, url, deployment, bodyDigest: expected.bodyDigest, size: bytes.length,
          objectKey: lastGoodObjectKey(target, deployment.rendererSha, deployment.codeGeneration, expected.path) };
      });
    },
  };
}
