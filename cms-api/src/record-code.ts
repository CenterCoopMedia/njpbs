import { timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { handlePairRecordCode } from "./record-code-v2";

export type RecordCodeBinding = { readCurrentCode?(rendererSha: string): Promise<{ reference: unknown; bytes: Uint8Array }>;
  readCurrentCodeReference?(rendererSha: string): Promise<unknown> };
type Env = { CMS_EDGE_ORIGIN_SECRET: string; PREVIEW_RENDERER?: RecordCodeBinding;
  CMS_DEPLOYMENT_ENVIRONMENT?: string; FIREBASE_PROJECT_ID: string; FUNCTIONS_ORIGIN: string; ADMIN_ORIGIN?: string };
const CURRENT_CODE_BYTES = 16 * 1024 * 1024;
const CURRENT_CODE_REPLY_BYTES = Math.ceil(CURRENT_CODE_BYTES / 3) * 4 + 8192;
function reply(status: number, body: string) {
  return new Response(body, { status, headers: { "cache-control": "private, no-store", "content-type": "application/json; charset=utf-8" } });
}

/** This route is for the existing server credential. Browser requests cannot
 * use the endpoint, and its request cannot name storage keys or publications. */
export async function handlePrivateRecordCode(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return reply(405, '{"error":"Method not allowed"}');
  const expected = Buffer.from(env.CMS_EDGE_ORIGIN_SECRET?.trim() ?? "");
  const supplied = Buffer.from(request.headers.get("x-njpbs-cms-edge") ?? "");
  if (request.headers.has("origin") || !expected.length || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return reply(403, '{"error":"Private channel is required"}');
  }
  const dev = env.CMS_DEPLOYMENT_ENVIRONMENT === "development";
  const project = dev ? "njpbs-site-dev" : "njpbs-site";
  if (env.CMS_DEPLOYMENT_ENVIRONMENT !== undefined && !["production", "development"].includes(env.CMS_DEPLOYMENT_ENVIRONMENT) ||
      env.FIREBASE_PROJECT_ID !== project || env.FUNCTIONS_ORIGIN !== `https://us-central1-${project}.cloudfunctions.net` ||
      dev && env.ADMIN_ORIGIN !== "https://dev-admin.example.org") return reply(503, '{"error":"Private source target is unavailable"}');
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json") ||
      request.headers.get("content-encoding") && request.headers.get("content-encoding") !== "identity") {
    return reply(415, '{"error":"JSON is required"}');
  }
  if (!request.body) return reply(400, '{"error":"Private source request is invalid"}');
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const row = await reader.read(); if (row.done) break;
      size += row.value.length; if (size > 1024) return reply(413, '{"error":"Private source request is too large"}');
      chunks.push(row.value);
    }
  } catch { return reply(400, '{"error":"Private source request is invalid"}'); }
  finally { await reader.cancel(); }
  let input: unknown;
  try { input = JSON.parse(Buffer.concat(chunks, size).toString("utf8")); }
  catch { return reply(400, '{"error":"Private source request is invalid"}'); }
  if (input && typeof input === "object" && ["current-code-v2", "current-code-reference-v2", "current-editorial-v2", "current-editorial-reference-v2"].includes(String((input as { mode?: unknown }).mode))) {
    return handlePairRecordCode(input, env);
  }
  if (input && typeof input === "object" && ["current-code", "current-code-reference"].includes(String((input as { mode?: unknown }).mode))) {
    const value = input as { mode: string; rendererSha?: unknown };
    if (Object.keys(value).sort().join(",") !== "mode,rendererSha" || typeof value.rendererSha !== "string" ||
        !/^[a-f0-9]{40}$/.test(value.rendererSha)) return reply(400, '{"error":"Private source request is invalid"}');
    try {
      if (value.mode === "current-code-reference") {
        if (typeof env.PREVIEW_RENDERER?.readCurrentCodeReference !== "function") return reply(503, '{"error":"Current CODE reference is unavailable"}');
        const reference = await env.PREVIEW_RENDERER.readCurrentCodeReference(value.rendererSha);
        const body = JSON.stringify({ schemaVersion: 1, kind: "current-code-reference", reference });
        if (Buffer.byteLength(body) > 8192) return reply(503, '{"error":"Current CODE reference exceeds its limit"}');
        return reply(200, body);
      }
      if (typeof env.PREVIEW_RENDERER?.readCurrentCode !== "function") return reply(503, '{"error":"Current CODE source is unavailable"}');
      const qualified = await env.PREVIEW_RENDERER.readCurrentCode(value.rendererSha);
      if (!(qualified.bytes instanceof Uint8Array) || qualified.bytes.length < 1 || qualified.bytes.length > CURRENT_CODE_BYTES ||
          Buffer.byteLength(JSON.stringify(qualified.reference)) > 8192) return reply(503, '{"error":"Current CODE exceeds its limit"}');
      const body = JSON.stringify({ schemaVersion: 1, kind: "current-code", reference: qualified.reference,
        bytes: Buffer.from(qualified.bytes).toString("base64") });
      if (Buffer.byteLength(body) > CURRENT_CODE_REPLY_BYTES) return reply(503, '{"error":"Current CODE exceeds its wire limit"}');
      return reply(200, body);
    } catch { return reply(503, '{"error":"Current CODE source is unavailable"}'); }
  }
  return reply(400, '{"error":"Private source request is invalid"}');
}
