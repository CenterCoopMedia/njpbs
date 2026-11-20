import { privatePreviewOrigin, publicSiteOrigin } from "./dev-origins";

const previewHost = new URL(privatePreviewOrigin).hostname;
const staffHosts = import.meta.env.VITE_CMS_DEPLOYMENT_ENVIRONMENT === "development"
  ? [new URL(publicSiteOrigin).hostname, previewHost] : [previewHost];
const adminOrigins = ["https://admin.njpbs.org", "https://dev-admin.example.org"];

export function staffSiteDestination(value: string, inheritedFragment = ""): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !staffHosts.includes(url.hostname) ||
      url.pathname === "/__cms-session") return null;
    // Browsers carry the original fragment across an HTTP redirect whose
    // Location has no fragment. Recover it from the Admin URL after the hop.
    if (!url.hash && inheritedFragment) url.hash = inheritedFragment;
    return url;
  } catch {
    return null;
  }
}

const pendingPreviewSessions = new Set<AbortController>();

export async function clearStaffSiteSessions({ signedOutStartup = false } = {}): Promise<void> {
  for (const controller of pendingPreviewSessions) controller.abort();
  // A local signed-out start has no accepted remote cookie cleanup path. Real
  // session endings still delete cookies, and cancellation always happens above.
  if (signedOutStartup && (typeof window === "undefined" || !adminOrigins.includes(window.location.origin))) return;
  await Promise.allSettled(staffHosts.map((host) =>
    fetch(`https://${host}/__cms-session`, { method: "DELETE", credentials: "include", signal: AbortSignal.timeout(5000) }),
  ));
}

export type PreviewSessionResult = "ready" | "refused" | "slow" | "unavailable" | "cancelled";

// Bound token retrieval and the gateway request with the same deadline.
export async function preparePrivatePreviewSession(token: Promise<string>, signal?: AbortSignal): Promise<PreviewSessionResult> {
  const controller = new AbortController();
  const sessionSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  const timeout = setTimeout(() => controller.abort(new DOMException("Preview session timed out", "TimeoutError")), 30_000);
  pendingPreviewSessions.add(controller);
  try {
    const interrupted = new Promise<never>((_, reject) => {
      if (sessionSignal.aborted) reject(sessionSignal.reason);
      else sessionSignal.addEventListener("abort", () => reject(sessionSignal.reason), { once: true });
    });
    const request = async () => {
      const idToken = await token;
      sessionSignal.throwIfAborted();
      return fetch(`${privatePreviewOrigin}/__cms-session`, {
        method: "POST", credentials: "include", redirect: "error",
        headers: { Authorization: `Bearer ${idToken}` }, signal: sessionSignal,
      });
    };
    const { status } = await Promise.race([interrupted, request()]);
    sessionSignal.throwIfAborted();
    if (status === 204) return "ready";
    if (status === 401 || status === 403) return "refused";
    return "unavailable";
  } catch {
    if (!sessionSignal.aborted) return "unavailable";
    return sessionSignal.reason?.name === "TimeoutError" ? "slow" : "cancelled";
  } finally {
    clearTimeout(timeout);
    pendingPreviewSessions.delete(controller);
  }
}

// Receipt renewal shares logout cancellation with preview session preparation.
export async function openStaffSiteSession(origin: string, token: Promise<string>): Promise<Response> {
  const target = staffSiteDestination(origin);
  if (!target || target.origin !== origin) throw new Error("This site address is not supported.");
  const controller = new AbortController();
  pendingPreviewSessions.add(controller);
  try {
    const idToken = await token;
    controller.signal.throwIfAborted();
    return await fetch(`${origin}/__cms-session`, {
      method: "POST", credentials: "include", redirect: "error",
      headers: { Authorization: `Bearer ${idToken}` },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
    });
  } finally { pendingPreviewSessions.delete(controller); }
}
