import { isKidsPath } from "./analytics-page-policy";

const ACCOUNT_ID = "255654599";
const SCRIPT_URL = "https://diffuser-cdn.app-us1.com/diffuser/diffuser.js";
const SELECTOR = "script[data-njpbs-activecampaign]";
type Vgo = ((...args: unknown[]) => void) & { q?: unknown[][]; l?: number };
type TrackingWindow = Window & { vgo?: Vgo; visitorGlobalObjectAlias?: string };

/** The callback rechecks consent and GPC immediately before processing a visit.
 * No identification, email, custom event or form data is supplied by this code.
 */
export function loadActiveCampaign(
  windowRef: TrackingWindow,
  allowed: () => boolean,
): void {
  const documentRef = windowRef.document;
  if (!allowed() || isKidsPath(windowRef.location.pathname) ||
      documentRef.querySelector("[data-child-directed]") ||
      !documentRef.querySelector("[data-activecampaign-enabled]") ||
      documentRef.querySelector(SELECTOR)) return;

  // Own a fresh queue; never inherit identification commands from another script.
  const vgo: Vgo = (...args) => { vgo.q!.push(args); };
  vgo.q = [];
  vgo.l = Date.now();
  windowRef.visitorGlobalObjectAlias = "vgo";
  windowRef.vgo = vgo;
  vgo("setAccount", ACCOUNT_ID);
  vgo("setTrackByDefault", false);
  const script = documentRef.createElement("script");
  script.async = true;
  script.dataset.njpbsActivecampaign = "";
  script.src = SCRIPT_URL;
  script.referrerPolicy = "no-referrer";
  script.onload = () => {
    if (script.isConnected && allowed() && !isKidsPath(windowRef.location.pathname) &&
        !documentRef.querySelector("[data-child-directed]")) {
      script.onload = null;
      windowRef.vgo?.("process", "allowTracking");
    }
  };
  documentRef.head.append(script);
}

/** Removing a script cannot undo executed vendor code. End that document on
 * revocation rather than treating removal or an undocumented API as an opt-out.
 * Already-issued requests and vendor-held data cannot be recalled here.
 */
export function stopActiveCampaign(windowRef: TrackingWindow): void {
  // Best-effort removal of the vendor's first-party prism cookies at the root.
  // HttpOnly cookies, other paths and vendor-held records need separate review.
  for (const part of windowRef.document.cookie.split(";")) {
    const name = part.trim().split("=", 1)[0];
    if (!name.startsWith("prism_")) continue;
    for (const domain of ["", "; Domain=.njpbs.org"]) {
      windowRef.document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax; Secure${domain}`;
    }
  }
  const script = windowRef.document.querySelector<HTMLScriptElement>(SELECTOR);
  if (!script) return;
  script.onload = null;
  script.remove();
  if (windowRef.vgo?.q) windowRef.vgo.q.length = 0;
  windowRef.vgo = () => {};
  windowRef.location.reload();
}
