// POST /cmsContentOps (#4716). Compose an automated change with the editor's reducer, then
// forward it to the existing Functions with the caller's own token. Dry run returns the plan
// digest and a change list; apply and publish repeat the digest, hold the editing lease for
// the one save, and record the staff request and the digest on the audit row.
import { videosForPublication } from "../../admin/src/lib/publication-video-set";
import {
  ContentOpsError,
  composePageSave,
  composePostSave,
  pageRefusal,
  parseContentOpsRequest,
  planDigest,
  summarizeChanges,
  type ContentOpsRequest,
} from "./content-ops";
import { claimLease, LeaseUnavailable, newLeaseSessionId, releaseLease, renewLease, type LeaseTarget } from "./editor-lease";
import type { PublicPageId } from "../../packages/content-core/src/public-pages";
import type { EndpointPolicy } from "./config";

// A composing route, not a forwarded Function, so it stays out of ENDPOINTS.
export const CONTENT_OPS_ENDPOINT = "cmsContentOps";
export const CONTENT_OPS_POLICY: EndpointPolicy = { contentType: "json", maxBytes: 256 * 1024, rateClass: "mutation" };

// Staff see this name on the Boardwalk presence banner while a change runs.
export const AGENT_LEASE_NAME = "NJ PBS agent";

export interface ContentOpsContext {
  body: ArrayBuffer;
  token: string;
  uid: string;
  projectId: string;
  functionsOrigin: string;
  forwardHeaders: Headers;
  fetcher: typeof fetch;
  now: () => number;
  randomUUID: () => string;
  /** How often a held lease is renewed. Tests shorten it. */
  leaseRenewMs?: number;
  /**
   * Spends one lifecycle token for the actor and the IP, as a direct cmsPublishSourceVideo
   * request does. A Response refuses the copy (429 with its limit headers, or 503).
   */
  chargeVideoCopy: () => Promise<Response | null>;
}

const LEASE_RENEW_MS = 30_000;

/** Holds the lease for one request: renews it on a timer and confirms it before a save. */
interface HeldLease {
  /** True while this request still owns the lease. Renews it at once. */
  confirm(): Promise<boolean>;
}

function keepLease(target: LeaseTarget, intervalMs: number) {
  let lost = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  // Renewals run one at a time, so a timed renewal and a confirmation never race.
  let queue: Promise<boolean> = Promise.resolve(true);
  const renew = () => {
    queue = queue.then(async () => {
      if (lost) return false;
      try {
        if (!(await renewLease(target))) lost = true;
      } catch {
        lost = true;
      }
      return !lost;
    });
    return queue;
  };
  const loop = (async () => {
    while (!stopped && !lost) {
      await new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, intervalMs); });
      if (!stopped) await renew();
    }
  })();
  return {
    held: { confirm: async () => !lost && renew() } as HeldLease,
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      wake?.();
      await loop;
    },
  };
}

interface Upstream {
  status: number;
  body: Record<string, unknown>;
}

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

// The Function's own refusal text is staff-facing already. Pass only these fields through.
function refusal(upstream: Upstream): Response {
  const { error, versionConflict, lockRequired } = upstream.body;
  return json(upstream.status, {
    error: typeof error === "string" ? error : "The CMS refused this change.",
    ...(versionConflict === true ? { versionConflict: true } : {}),
    ...(lockRequired === true ? { lockRequired: true } : {}),
  });
}

async function callFunction(context: ContentOpsContext, endpoint: string, payload: unknown): Promise<Upstream> {
  let response: Response;
  try {
    response = await context.fetcher(`${context.functionsOrigin}/${endpoint}`, {
      method: "POST",
      headers: context.forwardHeaders,
      body: JSON.stringify(payload),
      redirect: "manual",
    });
  } catch {
    // A lost connection is an unknown result. Callers report it; a committed save stays reported.
    return { status: 503, body: { error: "The CMS could not be reached. Read the record before trying again." } };
  }
  let body: unknown = null;
  try { body = await response.json(); } catch { /* A non-JSON reply is an upstream failure. */ }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { status: response.ok ? 502 : response.status, body: { error: "The CMS returned an unreadable reply." } };
  }
  return { status: response.status, body: body as Record<string, unknown> };
}

function compose(request: ContentOpsRequest, stored: Record<string, unknown>) {
  return request.collection === "cmsPages"
    ? composePageSave(request.id as PublicPageId, stored, request)
    : composePostSave(stored, request);
}

async function withLease(context: ContentOpsContext, request: ContentOpsRequest,
  run: (lease: HeldLease) => Promise<Response>): Promise<Response> {
  const target = {
    projectId: context.projectId, token: context.token, uid: context.uid, ownerName: AGENT_LEASE_NAME,
    collection: request.collection, id: request.id, fetcher: context.fetcher, nowMs: context.now(),
    sessionId: newLeaseSessionId(context.randomUUID),
  };
  let claim;
  try {
    claim = await claimLease(target);
  } catch (error) {
    if (!(error instanceof LeaseUnavailable)) throw error;
    return json(503, { error: "The editing lock could not be checked. Try again later." });
  }
  if (claim.status === "held") {
    return json(423, { error: `${claim.holder.ownerName} has this record open in Boardwalk.`, lockHeld: true,
      holder: claim.holder });
  }
  // Video copies can outlast the 120 second lease, so it is renewed while the request runs.
  const kept = keepLease(target, context.leaseRenewMs ?? LEASE_RENEW_MS);
  try {
    return await run(kept.held);
  } finally {
    await kept.stop();
    // A failed release expires with the lease window. It never undoes the saved change.
    await releaseLease(target).catch(() => console.warn("Content API lease release failed"));
  }
}

const leaseLost = () =>
  json(423, { error: "The editing lock was lost while the publish ran. Nothing was saved.", lockHeld: true });

async function publish(context: ContentOpsContext, request: ContentOpsRequest, stored: Record<string, unknown>,
  automation: Record<string, string>): Promise<Response> {
  return withLease(context, request, async (lease) => {
    // The editor copies each visible video to the public site before the publish save. The
    // lease comes first, so a record open in Boardwalk gets no public side effect.
    for (const video of videosForPublication(stored.blocks, stored.leadMedia, stored.liveBlog)) {
      // Each copy is a public side effect, so each one starts only while the lease is held.
      if (!(await lease.confirm())) return leaseLost();
      const refused = await context.chargeVideoCopy();
      if (refused) return refused;
      const copied = await callFunction(context, "cmsPublishSourceVideo", {
        sourceId: "video-library", assetId: video.assetId, collection: request.collection, id: request.id,
      });
      if (copied.status !== 200) return refusal(copied);
    }
    if (!(await lease.confirm())) return leaseLost();
    const saved = await callFunction(context, "cmsSaveContent", {
      collection: request.collection, id: request.id, baseVersion: request.baseVersion,
      publish: true, document: {}, automation,
    });
    if (saved.status !== 200) return refusal(saved);
    const document = saved.body.document as Record<string, unknown> | undefined;
    if (saved.body.publication) {
      return json(200, { success: true, mode: "publish", version: document?.version, publication: saved.body.publication });
    }
    const sourceVersion = document?.version;
    const published = Number.isSafeInteger(sourceVersion)
      ? await callFunction(context, "cmsPublish", {
        changes: [{ collection: request.collection, id: request.id, sourceVersion }], runtimeFirst: true })
      : { status: 502, body: { error: "The published version receipt is missing." } };
    if (published.status !== 200) {
      // The same uncertain result the editor reports: the version is saved as published.
      return json(502, { error: "The version was saved as published, but its public update was not confirmed.",
        publicationCommitted: true, version: sourceVersion });
    }
    return json(200, { success: true, mode: "publish", version: sourceVersion,
      publication: { queueId: published.body.queueId ?? null, transport: published.body.transport ?? null } });
  });
}

/** True for a publish request, which the edge also charges to the publish budget. */
export function isContentOpsPublish(body: ArrayBuffer): boolean {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body));
    return typeof parsed === "object" && parsed !== null && parsed.mode === "publish";
  } catch {
    return false;
  }
}

export async function handleContentOps(context: ContentOpsContext): Promise<Response> {
  let request: ContentOpsRequest;
  try {
    request = parseContentOpsRequest(JSON.parse(new TextDecoder().decode(context.body)));
  } catch (error) {
    if (error instanceof ContentOpsError) return json(error.status, { error: error.message, ...error.details });
    return json(400, { error: "Send a JSON content operations request." });
  }
  const loaded = await callFunction(context, "cmsGetContent", { collection: request.collection, id: request.id });
  if (loaded.status !== 200) return refusal(loaded);
  const stored = loaded.body.document as Record<string, unknown> | undefined;
  if (loaded.body.found !== true || !stored) return json(404, { error: "This record is no longer available." });
  if (stored.version !== request.baseVersion) {
    return json(409, { error: "This document changed since you read it. Read it again before changing it.", versionConflict: true });
  }
  // Home, the data hub and composed Pages stay in Boardwalk for every mode, publish included.
  const refused = request.collection === "cmsPages" ? pageRefusal(request.id, stored) : null;
  if (refused) return json(409, { error: refused });
  const digest = await planDigest(request);
  if (request.mode === "publish-dry-run") {
    return json(200, { success: true, mode: "publish-dry-run", digest, baseVersion: request.baseVersion,
      status: typeof stored.status === "string" ? stored.status : null });
  }
  if (request.mode !== "dry-run" && request.expectDigest !== digest) {
    return json(409, { error: "This plan differs from the reviewed dry run. Run the dry run again.", digestMismatch: true, digest });
  }
  const automation = { requestReference: request.requestReference, planDigest: digest };
  if (request.mode === "publish") return publish(context, request, stored, automation);

  let composed;
  try {
    composed = compose(request, stored);
  } catch (error) {
    if (error instanceof ContentOpsError) return json(error.status, { error: error.message, ...error.details });
    if (error instanceof Error) return json(400, { error: error.message });
    throw error;
  }
  const changes = summarizeChanges(request.collection, stored, composed);
  if (request.mode === "dry-run") {
    const checked = await callFunction(context, "cmsSaveContent", { ...composed.body, dryRun: true, automation });
    if (checked.status !== 200) return refusal(checked);
    return json(200, { success: true, mode: "dry-run", digest, baseVersion: request.baseVersion, changes,
      warnings: Array.isArray(checked.body.warnings) ? checked.body.warnings : [], document: checked.body.document });
  }
  return withLease(context, request, async () => {
    const saved = await callFunction(context, "cmsSaveContent", { ...composed.body, automation });
    if (saved.status !== 200) return refusal(saved);
    const document = saved.body.document as Record<string, unknown> | undefined;
    return json(200, { success: true, mode: "apply", digest, version: document?.version, changes,
      warnings: Array.isArray(saved.body.warnings) ? saved.body.warnings : [] });
  });
}
