import { WorkerEntrypoint } from "cloudflare:workers";
import protocol from "../../functions/lib/public-release-pair.js";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import { originFor, type SelectorReceipt } from "../../packages/content-core/src/public-release-routing";
import { AUTHORITY_BUDGET_MS } from "../../packages/content-core/src/public-release-routing";
import { admitReleaseAuthority, admitReleaseIngress, ingressRateRefusal, type IngressRateBinding } from "./public-release-rate-control";
import { withinReleaseDeadline } from "../../cms-api/src/public-release-rate-control";
import { createPublicReleaseRouter, type SlotReply } from "./public-release-router";
import { createRoutingObserver, type RoutingMeasurementEnvironment } from "./public-release-routing-observer";
import { serveRetainedPairCodeAsset } from "./public-release-code-assets";
import { readCommittedPairRecovery, recordCommittedPairRecovery, servePreviousVerifiedPairRecovery, type RoutingWriteStore } from "./public-release-recovery";

type SlotBinding = { serve(request: Request, selection: SelectorReceipt, pair: PublicReleasePair, proof?: boolean, budgetMs?: number): Promise<SlotReply> };
export type PublicReleaseIngressEnvironment = RoutingMeasurementEnvironment & {
  PUBLIC_PAIR_INGRESS_ENABLED?: string; PUBLIC_PAIR_IDENTITIES_JSON?: string; PUBLIC_PAIR_BOOTSTRAP_ID?: string;
  PUBLIC_PAIR_RECOVERY_CAPTURE_ENABLED?: string; PAIR_CONTENT: RoutingWriteStore;
  CMS_API: IngressRateBinding & { getReleaseSelector(budgetMs?: number, proof?: boolean): Promise<SelectorReceipt> };
  PAIR_SLOT_OLD: SlotBinding; PAIR_SLOT_NEW: SlotBinding;
};
const routers = new WeakMap<object, ReturnType<typeof createPublicReleaseRouter>>();
const reportedRefusals = new WeakMap<object, Set<string>>();
export function ingressPairs(env: PublicReleaseIngressEnvironment): PublicReleasePair[] {
  const raw = JSON.parse(env.PUBLIC_PAIR_IDENTITIES_JSON ?? "null");
  if (!Array.isArray(raw) || raw.length !== 2 || !env.PAIR_SLOT_OLD || !env.PAIR_SLOT_NEW) throw new Error("Both private slots are required");
  const pairs = raw.map(value => protocol.parsePublicReleasePair(value));
  if (pairs[0].environment !== pairs[1].environment || pairs[0].pairId === pairs[1].pairId) throw new Error("Mixed pair identity");
  return pairs;
}
export function publicReleaseIngress(env: PublicReleaseIngressEnvironment) {
  if (env.PUBLIC_PAIR_INGRESS_ENABLED !== "true") throw new Error("Pair ingress is disabled");
  let router = routers.get(env);
  if (!router) {
    const pairs = ingressPairs(env);
    const recovery = () => readCommittedPairRecovery({ store: env.PAIR_CONTENT, environment: pairs[0].environment, pairs });
    router = createPublicReleaseRouter({ environment: pairs[0].environment, bootstrapPairId: env.PUBLIC_PAIR_BOOTSTRAP_ID,
      slots: pairs.map((identity, index) => ({ identity, serve: (request, selection, proof = false, budgetMs = AUTHORITY_BUDGET_MS) =>
        (index === 0 ? env.PAIR_SLOT_OLD : env.PAIR_SLOT_NEW).serve(request, selection, identity, proof === true, budgetMs) })),
      readSelector: (signal, proof = false, budgetMs = AUTHORITY_BUDGET_MS) => { signal.throwIfAborted(); return env.CMS_API.getReleaseSelector(budgetMs, proof); },
      admitAuthority: (signal, budgetMs) => { signal.throwIfAborted();
        return admitReleaseAuthority(env.CMS_API, performance.now() + budgetMs); },
      readRecovery: recovery,
      serveRecovery: async (request, selection, signal) => {
        signal.throwIfAborted();
        // A fresh real selector is already committed authority. An advisory
        // capture lag must not turn an ordinary publication into a 503.
        let committed = selection;
        try {
          const recorded = await recovery(), retained = recorded.selector, latest = selection.selector;
          if (retained.epoch > latest.epoch || retained.epoch === latest.epoch &&
              retained.contentHead.contextSequence > latest.contentHead.contextSequence) committed = recorded;
        } catch { /* Warm reads may use their actual trusted selector. */ }
        if (env.PUBLIC_PAIR_BOOTSTRAP_ID && committed.selector.selectedPair.pairId !== env.PUBLIC_PAIR_BOOTSTRAP_ID) throw new Error("Bootstrap recovery pair was refused");
        return servePreviousVerifiedPairRecovery({ store: env.PAIR_CONTENT,
          pairs: env.PUBLIC_PAIR_BOOTSTRAP_ID ? pairs.filter(pair => pair.pairId === env.PUBLIC_PAIR_BOOTSTRAP_ID) : pairs,
          request, selection: committed });
      }, observe: createRoutingObserver(env) });
    routers.set(env, router);
  }
  return router;
}
export class PublicReleaseIngressProofEntrypoint extends WorkerEntrypoint<PublicReleaseIngressEnvironment> {
  async prove(request: Request, expectedBodyDigest: string, expected: { status?: 200 | 302 | 308 | 410 } = {}): Promise<Response> {
    if (this.env.PUBLIC_PAIR_INGRESS_ENABLED !== "true") return new Response(null, { status: 404 });
    const deadline = performance.now() + AUTHORITY_BUDGET_MS;
    try {
      await admitReleaseIngress(request, this.env.CMS_API, deadline, true);
      return await publicReleaseIngress(this.env).prove(request, expectedBodyDigest, expected, deadline);
    } catch (error) { return ingressRateRefusal(error); }
  }
  async invalidate(epoch: number): Promise<void> { publicReleaseIngress(this.env).invalidate(epoch); }
  async captureRecovery(): Promise<void> {
    if (this.env.PUBLIC_PAIR_RECOVERY_CAPTURE_ENABLED !== "true" || this.env.PUBLIC_PAIR_INGRESS_ENABLED !== "true") throw new Error("Recovery capture is disabled");
    const pairs = ingressPairs(this.env);
    return recordCommittedPairRecovery({ store: this.env.PAIR_CONTENT, environment: pairs[0].environment, pairs,
      readSelector: async () => {
        const value = await this.env.CMS_API.getReleaseSelector(3_000, true);
        if (this.env.PUBLIC_PAIR_BOOTSTRAP_ID && value.selector.selectedPair.pairId !== this.env.PUBLIC_PAIR_BOOTSTRAP_ID) throw new Error("Bootstrap recovery capture was refused");
        return value;
      } });
  }
}
export default { async fetch(request: Request, env: PublicReleaseIngressEnvironment): Promise<Response> {
  if (env.PUBLIC_PAIR_INGRESS_ENABLED !== "true") return new Response(null, { status: 404 });
  const deadline = performance.now() + AUTHORITY_BUDGET_MS;
  try {
    const pairs = ingressPairs(env);
    if (new URL(request.url).origin !== originFor(pairs[0].environment)) return new Response(null, { status: 404 });
    if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405, headers: { "cache-control": "no-store" } });
    await admitReleaseIngress(request, env.CMS_API, deadline);
    return await withinReleaseDeadline(deadline, async () => {
    if (/\.(?:js|mjs|css|wasm|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf)$/.test(new URL(request.url).pathname)) {
      try {
        const assetPairs = env.PUBLIC_PAIR_BOOTSTRAP_ID ? pairs.filter(pair => pair.pairId === env.PUBLIC_PAIR_BOOTSTRAP_ID) : pairs;
        const asset = await serveRetainedPairCodeAsset({ store: env.PAIR_CONTENT, pairs: assetPairs, request, onRefusal: (pairId, stage) => {
          let reported = reportedRefusals.get(env);
          if (!reported) { reported = new Set(); reportedRefusals.set(env, reported); }
          const key = `${pairId}:${stage}`;
          if (reported.has(key)) return;
          reported.add(key);
          // Bounded to three stages per configured pair/isolate; no raw error,
          // URL, request content, credential or response body enters the log.
          console.warn("Retained public asset refused", { pairId, stage });
        } });
        if (asset) return asset;
      } catch { /* Refused retained bytes still allow fresh selected serving. */ }
    }
    return await publicReleaseIngress(env).fetch(request, deadline);
    });
  }
  catch (error) { return ingressRateRefusal(error); }
} };
