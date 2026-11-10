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

// The admitted editor can establish the same private-site cookie while a preview
// is prepared. Failure leaves the serving Worker's normal sign-in redirect intact.
export async function preparePrivatePreviewSession(token: Promise<string>): Promise<void> {
  const controller = new AbortController();
  pendingPreviewSessions.add(controller);
  try {
    const idToken = await token;
    if (controller.signal.aborted) return;
    await fetch(`${privatePreviewOrigin}/__cms-session`, {
      method: "POST", credentials: "include", redirect: "error",
      headers: { Authorization: `Bearer ${idToken}` },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
    });
  } catch { /* Navigation retains the existing authenticated handoff fallback. */ }
  finally { pendingPreviewSessions.delete(controller); }
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
