/** Private development experiment only. Never imported by a public entrypoint. */
import { timingSafeEqual } from "node:crypto";
import { createPublicReleaseRouter, type RoutingEvent, type SlotReply } from "./public-release-router";
import { parseSelectorReceipt, bytesDigest, type SelectorReceipt } from "../../packages/content-core/src/public-release-routing";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import { parsePublicReleasePair } from "../../functions/lib/public-release-pair.js";

type Slot = { serve(request: Request, selection: SelectorReceipt, pair: PublicReleasePair): Promise<SlotReply> };
type Env = {
  PUBLIC_RELEASE_ROUTING_EXPERIMENT_ENABLED?: string;
  FBASE_PROJECT?: string;
  MEASUREMENT_ID?: string;
  MEASUREMENT_SECRET?: string;
  MEASUREMENT_CASES_JSON?: string;
  PUBLIC_PAIR_IDENTITIES_JSON?: string;
  CF_VERSION_METADATA?: { id?: string };
  CMS_API?: { getRoutingMeasurementSelector(id: string, budgetMs: number): Promise<SelectorReceipt> };
  PAIR_SLOT_OLD?: Slot;
  PAIR_SLOT_NEW?: Slot;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const unavailable = () => new Error("Development experiment unavailable");
function authorized(request: Request, secret: string | undefined) {
  if (!secret || secret.length < 32 || secret.length > 512 || /\s/.test(secret)) return false;
  const supplied = request.headers.get("authorization");
  if (!supplied || supplied.length > 2048) return false;
  const encoder = new TextEncoder(), expectedBytes = encoder.encode(`Bearer ${secret}`), suppliedBytes = encoder.encode(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}
function configurationKey(env: Env) {
  if (env.FBASE_PROJECT !== "njpbs-site-dev" || !uuid.test(env.MEASUREMENT_ID ?? "") ||
      !uuid.test(env.CF_VERSION_METADATA?.id ?? "") || !env.CMS_API || !env.PAIR_SLOT_OLD || !env.PAIR_SLOT_NEW) throw unavailable();
  return JSON.stringify([env.FBASE_PROJECT, env.MEASUREMENT_ID, env.CF_VERSION_METADATA!.id,
    env.PUBLIC_PAIR_IDENTITIES_JSON, env.MEASUREMENT_CASES_JSON]);
}

function openExperiment(env: Env) {
  configurationKey(env);
  const pairs = JSON.parse(env.PUBLIC_PAIR_IDENTITIES_JSON ?? "null");
  if (!Array.isArray(pairs) || pairs.length !== 2) throw unavailable();
  const identities = pairs.map(value => parsePublicReleasePair(value)) as PublicReleasePair[];
  if (identities.some(value => value.environment !== "development")) throw unavailable();
  const cases = JSON.parse(env.MEASUREMENT_CASES_JSON ?? "null");
  if (!Array.isArray(cases) || cases.length < 1 || cases.length > 20) throw unavailable();
  const paths = new Map<string, { path: string; status: number; bytes: number; bodyDigest: string }>();
  for (const item of cases) {
    if (!item || Object.keys(item).sort().join(",") !== "bodyDigest,bytes,id,path,status" || !/^[a-z][a-z0-9-]{0,39}$/.test(item.id) ||
        typeof item.path !== "string" || item.path.length > 1024 || !/^\/[a-zA-Z0-9/_\-.]*$/.test(item.path) || item.path.includes("..") ||
        item.path.startsWith("//") || item.path === "/_publication-v2.json" || paths.has(item.id) ||
        ![200, 302, 308, 410].includes(item.status) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > 4 * 1024 * 1024 ||
        item.status !== 200 && item.bytes !== 0 || !/^[a-f0-9]{64}$/.test(item.bodyDigest)) throw unavailable();
    paths.set(item.id, { path: item.path, status: item.status, bytes: item.bytes, bodyDigest: item.bodyDigest });
  }
  const isolateId = crypto.randomUUID(), started = performance.now();
  const counts: Partial<Record<RoutingEvent, number>> = {};
  const refreshes: { sequence: number; durationMs: number; ok: boolean }[] = [];
  let refreshSequence = 0, selection: SelectorReceipt | undefined;
  const observe = (event: RoutingEvent, durationMs = 0) => {
    counts[event] = (counts[event] ?? 0) + 1;
    if (event === "refresh-complete" || event === "refresh-failed") {
      refreshes.push({ sequence: ++refreshSequence, durationMs, ok: event === "refresh-complete" });
      if (refreshes.length > 256) refreshes.shift();
    }
  };
  const slots = [env.PAIR_SLOT_OLD, env.PAIR_SLOT_NEW].map((binding, index) => ({
    identity: identities[index], serve: (request: Request, receipt: SelectorReceipt) => binding!.serve(request, receipt, identities[index]),
  }));
  const readActualSelector = async (signal: AbortSignal) => {
    if (signal.aborted) throw unavailable();
    const receipt = parseSelectorReceipt(await env.CMS_API!.getRoutingMeasurementSelector(env.MEASUREMENT_ID!, 3000), "development");
    if (signal.aborted) throw unavailable();
    return receipt;
  };
  const router = createPublicReleaseRouter({ environment: "development", slots, observe,
    readSelector: async signal => { selection = await readActualSelector(signal); return selection; },
  });
  return {
    get primed() { return Boolean(selection); },
    snapshot() { return { ageMs: performance.now() - started, counts: { ...counts }, refreshSequence }; },
    async sample(caseId: string, lane: string, colo: string) {
      const expected = paths.get(caseId);
      if (!expected || !["router", "slot-direct"].includes(lane)) throw unavailable();
      // Construct a local Request for the actual router/slot. No origin fetch,
      // viewer authentication, proof method, invalidation or recovery write.
      let start = performance.now(), controlSelectorReadMs = 0;
      const response = await underDeadline(async signal => {
        const request = new Request(`https://dev-public.example.org${expected.path}`, { redirect: "manual", signal });
        if (lane === "router") return router.fetch(request);
        if (!selection) throw unavailable(); // Prime through the real reader first.
        // Native slot decisions refuse a selector read >=5 seconds old. Obtain
        // an actual current receipt independently of the router cache. Count
        // this control-only read separately and exclude it from slot timing;
        // preparation plus slot headers still share the same 3-second bound.
        const readStart = performance.now(), retained = await readActualSelector(signal);
        controlSelectorReadMs = performance.now() - readStart;
        const slot = slots.find(value => value.identity.pairId === retained.selector.selectedPair.pairId);
        if (!slot) throw unavailable();
        start = performance.now();
        const reply = await slot.serve(request, retained);
        if (reply.kind !== "response") throw unavailable();
        return reply.response;
      }, 3000);
      const headersMs = performance.now() - start;
      const bytes = await readBoundedBody(response.body, 4 * 1024 * 1024, 5000);
      const bodyMs = performance.now() - start;
      const bodyDigest = await bytesDigest(bytes);
      if (response.status !== expected.status || bytes.length !== expected.bytes || bodyDigest !== expected.bodyDigest) throw unavailable();
      return { schemaVersion: 2, environment: "development", publicationAuthority: false, sampleRate: 1,
        measurementId: env.MEASUREMENT_ID, versionId: env.CF_VERSION_METADATA!.id, isolateId, colo,
        ageMs: performance.now() - started, caseId, lane, headersMs, bodyMs, controlSelectorReadMs,
        status: response.status, bytes: bytes.length, bodyDigest,
        source: { project: "njpbs-site-dev", reader: "CMS_API.getRoutingMeasurementSelector",
          document: `system/publicReleaseRoutingMeasurements/selectors/${env.MEASUREMENT_ID}` },
        counts: { ...counts }, refreshSequence, refreshes: refreshes.map(value => ({ ...value })) };
    },
  };
}

async function underDeadline<T>(run: (signal: AbortSignal) => Promise<T>, milliseconds: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([run(controller.signal), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
async function readBoundedBody(body: ReadableStream<Uint8Array> | null, limit: number, milliseconds: number): Promise<Uint8Array> {
  const reader = body?.getReader(), parts: Uint8Array[] = [];
  let size = 0, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([(async () => {
      if (reader) for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) throw unavailable();
        parts.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.length; }
      return bytes;
    })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(unavailable()), milliseconds); })]);
  } finally {
    if (timer) clearTimeout(timer);
    void reader?.cancel().catch(() => {});
  }
}

/** One state per instrumented module instance, independent of request Env
 * object identity. Configuration drift within that instance refuses. */
export function createRoutingMeasurementWorker() {
  let state: { key: string; experiment: ReturnType<typeof openExperiment> } | undefined;
  return {
  async fetch(request: Request, env: Env): Promise<Response> {
    const reject = () => new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
    if (env.PUBLIC_RELEASE_ROUTING_EXPERIMENT_ENABLED !== "true") return reject();
    if (!authorized(request, env.MEASUREMENT_SECRET)) return reject();
    try {
      const url = new URL(request.url), cf = (request as Request & { cf?: { colo?: unknown } }).cf;
      if (request.method !== "POST" || url.pathname !== "/sample" || url.search ||
          !/^njpbs-dev-routing-measurement\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname) ||
          typeof cf?.colo !== "string" || !/^[A-Z]{3}$/.test(cf.colo) ||
          Number(request.headers.get("content-length")) > 256) return reject();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedBody(request.body, 256, 1000));
      const body = JSON.parse(text);
      if (!body || Object.keys(body).sort().join(",") !== "caseId,routerFirst" || typeof body.routerFirst !== "boolean") return reject();
      const key = configurationKey(env), newInstance = !state;
      if (state && state.key !== key) throw unavailable();
      if (!state) state = { key, experiment: openExperiment(env) };
      const experiment = state.experiment, before = experiment.snapshot();
      // Keep each matched control/router observation in the same real isolate.
      // A cold isolate must prime through the actual reader before its control.
      const cold = !experiment.primed;
      const lanes = cold || body.routerFirst ? ["router", "slot-direct"] : ["slot-direct", "router"];
      const observations = [];
      for (const lane of lanes) observations.push(await experiment.sample(body.caseId, lane, cf.colo));
      return Response.json({ schemaVersion: 2, cold, newInstance, before, observations }, { headers: { "cache-control": "no-store" } });
    } catch { return new Response(null, { status: 503, headers: { "cache-control": "no-store" } }); }
  },
  };
}
export default createRoutingMeasurementWorker();
