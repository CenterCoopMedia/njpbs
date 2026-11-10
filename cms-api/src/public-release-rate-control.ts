import policy from "../../packages/content-core/src/public-release-rate-policy.json";
import type { CmsRateLimiter, ConsumeResult } from "./rate-limiter";

export type ReleaseRateEnvironment = {
  PUBLIC_RELEASE_RATE_CONTROLS_ENABLED?: string;
  FIREBASE_PROJECT_ID: string;
  RATE_LIMITERS?: Pick<DurableObjectNamespace<CmsRateLimiter>, "getByName">;
};

export class ReleaseRateRefusal extends Error {
  constructor(readonly status: 429 | 503, readonly retryAfterSeconds = 1,
    readonly reason: "disabled" | "unavailable" | "malformed" | "limited" | "deadline" = status === 429 ? "limited" : "unavailable") {
    super("Public release admission was refused");
  }
}
const reports = new Map<string, { count: number; next: number }>();
/** At most one log per component/class per minute per isolate. No address,
 * path, error text, credential, request or response body enters telemetry. */
export function reportReleaseRateRefusal(component: "viewer" | "authority" | "rpc" | "proof" | "ingress", error: unknown): void {
  const refusal = error instanceof ReleaseRateRefusal ? error : new ReleaseRateRefusal(503);
  if (!["viewer", "authority", "rpc", "proof", "ingress"].includes(component)) component = "ingress";
  const reason = ["disabled", "unavailable", "malformed", "limited", "deadline"].includes(refusal.reason) ? refusal.reason : "unavailable";
  const key = `${component}:${reason}`, now = Date.now(), previous = reports.get(key);
  const count = (previous?.count ?? 0) + 1;
  if (!previous || now >= previous.next) {
    console.warn("Public release admission refused", { component, reason, status: refusal.status === 429 ? 429 : 503, count });
    reports.set(key, { count: 0, next: now + 60_000 });
  } else previous.count = count;
}

/** Share one monotonic deadline; a slow admission never starts fresh authority. */
export async function withinReleaseDeadline<T>(deadline: number, run: () => Promise<T>): Promise<T> {
  const remaining = deadline - performance.now();
  if (!Number.isFinite(deadline) || remaining <= 0) throw new ReleaseRateRefusal(503, 1, "deadline");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([Promise.resolve().then(run), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ReleaseRateRefusal(503, 1, "deadline")), remaining);
    })]);
    if (performance.now() >= deadline) throw new ReleaseRateRefusal(503, 1, "deadline");
    return result;
  } finally { if (timer) clearTimeout(timer); }
}

/** Only the public edge fetch handler supplies this identity. Forwarded headers
 * and private-proof assertions have no authority. Same-zone Worker code is a
 * trusted deployment boundary; the aggregate bucket also bounds distinct IPs. */
export function releaseViewerIp(request: Request): string {
  const ip = request.headers.get("cf-connecting-ip");
  if (!request.cf) throw new ReleaseRateRefusal(503, 1, "malformed");
  return normalizeReleaseViewerIp(ip);
}
export function normalizeReleaseViewerIp(ip: string | null): string {
  if (typeof ip !== "string" || !ip || ip.length > 45 || /[^0-9a-fA-F:.]/.test(ip)) throw new ReleaseRateRefusal(503, 1, "malformed");
  try {
    if (ip.includes(":")) {
      const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1), groups = ipv6Groups(canonical);
      if (groups.slice(0, 5).every(value => value === 0) && groups[5] === 0xffff) {
        return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join(".");
      }
      return canonical;
    }
    const parts = ip.split(".");
    if (parts.length !== 4 || parts.some(part => !/^(?:0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255)) throw new Error();
    return parts.join(".");
  } catch { throw new ReleaseRateRefusal(503, 1, "malformed"); }
}
function ipv6Groups(canonical: string): number[] {
  const [first, last] = canonical.split("::"), head = first ? first.split(":") : [], tail = last ? last.split(":") : [];
  return [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail].map(value => Number.parseInt(value, 16));
}
/** IPv6 privacy/address rotation within one customer network shares a /64.
 * The raw canonical IP crosses the private binding; only this identity hashes. */
export function releaseViewerRateIdentity(ip: string): string {
  const canonical = normalizeReleaseViewerIp(ip);
  return canonical.includes(":") ? `${ipv6Groups(canonical).slice(0, 4).map(value => value.toString(16)).join(":")}::/64` : canonical;
}

export async function consumeReleaseRate(env: ReleaseRateEnvironment, role: "viewer" | "authority" | "rpc" | "proof", deadline: number, ip?: string): Promise<void> {
  try { return await consumeRate(env, role, deadline, ip); }
  catch (error) { reportReleaseRateRefusal(role, error); throw error; }
}
async function consumeRate(env: ReleaseRateEnvironment, role: "viewer" | "authority" | "rpc" | "proof", deadline: number, ip?: string): Promise<void> {
  if (env.PUBLIC_RELEASE_RATE_CONTROLS_ENABLED !== "true") throw new ReleaseRateRefusal(503, 1, "disabled");
  if (!env.RATE_LIMITERS) throw new ReleaseRateRefusal(503);
  if (!["njpbs-site", "njpbs-site-dev"].includes(env.FIREBASE_PROJECT_ID) ||
      !["viewer", "authority", "rpc", "proof"].includes(role) || role === "viewer" && !ip) throw new ReleaseRateRefusal(503, 1, "malformed");
  if (role === "viewer") ip = normalizeReleaseViewerIp(ip!);
  const consume = async (key: keyof Omit<typeof policy, "schemaVersion">, subject: string) => {
    try {
      // Neither raw addresses, paths, pair IDs nor caller clocks are persisted.
      const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(subject)));
      const digest = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
      const result: ConsumeResult = await withinReleaseDeadline(deadline, () => env.RATE_LIMITERS!
        .getByName(`public-release-v1:${env.FIREBASE_PROJECT_ID}:${key}:${digest}`).consume(policy[key]));
      if (!result || Object.keys(result).sort().join() !== "allowed,remaining,retryAfterSeconds" ||
          typeof result.allowed !== "boolean" || !Number.isSafeInteger(result.remaining) || result.remaining < 0 ||
          result.remaining > policy[key].capacity || !Number.isSafeInteger(result.retryAfterSeconds) ||
          result.allowed && result.retryAfterSeconds !== 0 || !result.allowed &&
          (result.retryAfterSeconds < 1 || result.retryAfterSeconds > Math.ceil(1 / policy[key].refillPerSecond))) throw new ReleaseRateRefusal(503, 1, "malformed");
      if (!result.allowed) throw new ReleaseRateRefusal(429, result.retryAfterSeconds);
    } catch (error) {
      if (error instanceof ReleaseRateRefusal) throw error;
      throw new ReleaseRateRefusal(503);
    }
  };
  if (role === "viewer") await consume("viewerIp", releaseViewerRateIdentity(ip!));
  else await consume(role === "authority" ? "viewerAggregate" : role, "all");
}
