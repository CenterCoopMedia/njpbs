import { isDeepStrictEqual } from "node:util";
import { accessToken, jsonResponse } from "./pending-work";
import { previewOutputTarget } from "../site/scripts/preview-output-target.mjs";
import candidate from "../functions/lib/cms-preview-pair-candidate.js";

function decode(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid private preview authority");
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== 1) throw new Error("Invalid private preview authority");
  if (typeof value.stringValue === "string") return value.stringValue;
  if (typeof value.booleanValue === "boolean") return value.booleanValue;
  if (Object.hasOwn(value, "nullValue")) return null;
  if (typeof value.integerValue === "string" && /^-?(0|[1-9][0-9]*)$/.test(value.integerValue) && Number.isSafeInteger(Number(value.integerValue))) return Number(value.integerValue);
  if (value.mapValue && typeof value.mapValue === "object") {
    const fields = (value.mapValue as { fields?: unknown }).fields ?? {};
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("Invalid private preview authority");
    return Object.fromEntries(Object.entries(fields).map(([key, part]) => [key, decode(part)]));
  }
  throw new Error("Invalid private preview authority");
}
/** Full bounded documents, no masked projection standing in for registration.
 * This is read-only; candidate authority can never return queue admission. */
export async function readPrivatePreviewPairAuthority(env: Env, request = fetch, { work = false } = {}) {
  const target = previewOutputTarget(env.CMS_DEPLOYMENT_ENVIRONMENT ?? "production", env.FIREBASE_PROJECT_ID ?? "njpbs-site");
  const token = await accessToken(env.FIREBASE_SERVICE_ACCOUNT, target.projectId, request);
  const read = async (path: string) => {
    if (!/^(cmsPreviewPairs|cmsPreviewPairCandidatePointers|cmsDeploymentCandidates)\/[A-Za-z0-9-]+$/.test(path) && !["system/cmsPreviewRuntime", "system/billing"].includes(path)) throw new Error("Invalid private preview authority path");
    const response = await request(`https://firestore.googleapis.com/v1/projects/${target.projectId}/databases/(default)/documents/${path}${path === "system/billing" ? "?mask.fieldPaths=disabled" : ""}`, {
      headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    if (path === "system/billing" && response.status === 404) { await response.body?.cancel(); return undefined; }
    const row = await jsonResponse(response) as { fields?: unknown };
    return decode({ mapValue: { fields: row.fields } });
  };
  const input = { read, pairId: env.PREVIEW_SERIALIZER_ID, rendererSha: env.PREVIEW_RENDERER_SHA,
    workerVersion: env.PREVIEW_WORKER_VERSION?.id };
  // REST reads have no shared transaction. Re-read the authority cohort and
  // compare it before permitting Container startup; the Node runtime also
  // checks a transactional snapshot before health or work.
  const observe = work ? candidate.readPreviewPairWorkAuthority : candidate.readPreviewPairRuntimeAuthority;
  const first = await observe(input);
  const second = await observe(input);
  if (!isDeepStrictEqual(first, second)) throw new Error("Private preview authority changed");
  return second as { mode: "candidate" | "retained" | "unretained" | "disabled"; pair?: { workerVersion: string } };
}
