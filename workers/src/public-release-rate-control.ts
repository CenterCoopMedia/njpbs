import { releaseViewerIp, ReleaseRateRefusal, withinReleaseDeadline, reportReleaseRateRefusal } from "../../cms-api/src/public-release-rate-control";

export type ReleaseAdmissionReply = { status: 200 } | { status: 429 | 503; retryAfterSeconds: number };
export type IngressRateBinding = {
  consumeReleaseViewer?(ip: string, budgetMs: number): Promise<ReleaseAdmissionReply>;
  consumeReleaseAuthority?(budgetMs: number): Promise<ReleaseAdmissionReply>;
  consumeReleaseProof?(budgetMs: number): Promise<ReleaseAdmissionReply>;
};

export function ingressRateRefusal(error: unknown): Response {
  const limited = error instanceof ReleaseRateRefusal && error.status === 429;
  return new Response(null, { status: limited ? 429 : 503, headers: { "cache-control": "no-store",
    ...(limited ? { "retry-after": String(error.retryAfterSeconds) } : {}) } });
}

/** No caller-provided header or success bit can skip the installed CMS owner. */
export async function admitReleaseIngress(request: Request, binding: IngressRateBinding, deadline: number, proof = false): Promise<void> {
  try {
    if (typeof proof !== "boolean") throw new ReleaseRateRefusal(503);
    return await admit(binding, deadline, proof ? "proof" : "viewer", proof ? undefined : releaseViewerIp(request));
  }
  catch (error) { reportReleaseRateRefusal("ingress", error); throw error; }
}
/** Aggregate admission protects live authority; verified assets/recovery bypass it. */
export async function admitReleaseAuthority(binding: IngressRateBinding, deadline: number): Promise<void> {
  try { return await admit(binding, deadline, "authority"); }
  catch (error) { reportReleaseRateRefusal("ingress", error); throw error; }
}
async function admit(binding: IngressRateBinding, deadline: number, role: "viewer" | "authority" | "proof", ip?: string): Promise<void> {
  const budget = Math.floor(deadline - performance.now());
  if (budget < 1 || budget > 3_000) throw new ReleaseRateRefusal(503);
  const reply = await withinReleaseDeadline(deadline, () => {
    if (role === "proof" && binding.consumeReleaseProof) return binding.consumeReleaseProof(budget);
    if (role === "viewer" && binding.consumeReleaseViewer) return binding.consumeReleaseViewer(ip!, budget);
    if (role === "authority" && binding.consumeReleaseAuthority) return binding.consumeReleaseAuthority(budget);
    throw new ReleaseRateRefusal(503);
  }).catch(error => { throw error instanceof ReleaseRateRefusal ? error : new ReleaseRateRefusal(503); });
  if (reply?.status === 200 && Object.keys(reply).length === 1) return;
  if (reply?.status === 429 && Object.keys(reply).sort().join() === "retryAfterSeconds,status" &&
      Number.isSafeInteger(reply.retryAfterSeconds) && reply.retryAfterSeconds >= 1 && reply.retryAfterSeconds <= 60) {
    throw new ReleaseRateRefusal(429, reply.retryAfterSeconds);
  }
  if (reply?.status === 503 && Object.keys(reply).sort().join() === "retryAfterSeconds,status" &&
      Number.isSafeInteger(reply.retryAfterSeconds) && reply.retryAfterSeconds >= 1 && reply.retryAfterSeconds <= 60) {
    throw new ReleaseRateRefusal(503);
  }
  throw new ReleaseRateRefusal(503, 1, "malformed");
}
