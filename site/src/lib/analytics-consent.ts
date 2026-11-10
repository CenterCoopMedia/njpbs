import { donateUrl } from "../data/launch-fallback";
import { loadActiveCampaign, stopActiveCampaign } from "./activecampaign-consent";

export const ANALYTICS_CONSENT_COOKIE = "njpbs-consent";
export const ANALYTICS_CONSENT_GRANTED =
  "v4:analytics=granted,mailchimp=granted,activecampaign=granted,wisepops=granted,ads=denied";
export const ANALYTICS_CONSENT_DENIED =
  "v4:analytics=denied,mailchimp=denied,activecampaign=denied,wisepops=denied,ads=denied";

const CONSENT_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
const MEASUREMENT_ID = /^G-[A-Z0-9]+$/;
const CONSENT_CHANNEL = "njpbs-analytics-consent";

type ConsentDecision = "granted" | "denied" | null;
type Gtag = (...args: unknown[]) => void;
type AnalyticsWindow = Window & {
  BroadcastChannel?: new (name: string) => BroadcastChannel;
  dataLayer?: IArguments[];
  gtag?: Gtag;
  njpbsLoadMailchimp?: () => void;
  njpbsLoadWisepops?: () => void;
  njpbsStopWisepops?: () => void;
  $mcSite?: {
    createCookie(name: string, value: boolean, expirationDays: number): void;
    enableOptIn(): void;
  };
};

type EventParams = {
  search: { search_term: string; results_count: number };
  donate_cta_click: {
    placement: "header" | "content" | "footer";
    currency: "USD";
  };
  donate_form_redirect: {
    placement: "header" | "content" | "footer";
    currency: "USD";
  };
};

export function isGa4MeasurementId(value: string | undefined): value is string {
  return MEASUREMENT_ID.test(value ?? "");
}

export function readAnalyticsConsent(cookieHeader: string): ConsentDecision {
  const values = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${ANALYTICS_CONSENT_COOKIE}=`))
    .map((part) => {
      const value = part.slice(ANALYTICS_CONSENT_COOKIE.length + 1);
      try {
        return decodeURIComponent(value);
      } catch {
        return "";
      }
    });

  if (values.length !== 1) return null;
  if (values[0] === ANALYTICS_CONSENT_GRANTED) return "granted";
  if (values[0] === ANALYTICS_CONSENT_DENIED) return "denied";
  return null;
}

function writeAnalyticsConsent(documentRef: Document, decision: ConsentDecision): void {
  const value = decision === "granted"
    ? ANALYTICS_CONSENT_GRANTED
    : ANALYTICS_CONSENT_DENIED;
  documentRef.cookie =
    `${ANALYTICS_CONSENT_COOKIE}=${encodeURIComponent(value)}` +
    `; Path=/; Max-Age=${CONSENT_MAX_AGE_SECONDS}; SameSite=Lax; Secure`;
}

function deleteAnalyticsCookies(documentRef: Document, hostname: string): void {
  const cookieNames = documentRef.cookie
    .split(";")
    .map((part) => part.trim().split("=", 1)[0])
    .filter((name) => name === "_ga" || name.startsWith("_ga_"));

  for (const name of cookieNames) {
    const expires = "Expires=Thu, 01 Jan 1970 00:00:00 GMT";
    documentRef.cookie = `${name}=; Path=/; ${expires}; SameSite=Lax`;
    if (hostname === "njpbs.org" || hostname.endsWith(".njpbs.org")) {
      documentRef.cookie =
        `${name}=; Domain=.njpbs.org; Path=/; ${expires}; SameSite=Lax`;
    }
  }
}

function isGlobalPrivacyControlEnabled(navigatorRef: Navigator): boolean {
  return (navigatorRef as Navigator & { globalPrivacyControl?: boolean })
    .globalPrivacyControl === true;
}

export function trackEvent<Name extends keyof EventParams>(
  name: Name,
  params: EventParams[Name],
  windowRef: AnalyticsWindow = window,
): void {
  const consentRoot = windowRef.document.querySelector<HTMLElement>(
    "[data-analytics-consent]",
  );
  const measurementId = consentRoot?.dataset.measurementId;
  if (!isGa4MeasurementId(measurementId)) return;
  if (readAnalyticsConsent(windowRef.document.cookie) !== "granted") return;
  if (isGlobalPrivacyControlEnabled(windowRef.navigator)) return;
  if (
    (windowRef as unknown as Record<string, unknown>)[
      `ga-disable-${measurementId}`
    ] !== false
  ) return;
  windowRef.gtag?.("event", name, params);
}

export function recordSiteSearch(
  term: string,
  resultsCount: number,
  windowRef: AnalyticsWindow = window,
): void {
  if (!term.trim() || !Number.isSafeInteger(resultsCount) || resultsCount < 0) return;
  trackEvent("search", { search_term: term, results_count: resultsCount }, windowRef);
}

export function recordDonateClick(
  event: MouseEvent,
  windowRef: AnalyticsWindow = window,
): void {
  const anchor = (event.target as Element | null)?.closest?.(
    "a[href]",
  ) as HTMLAnchorElement | null;
  if (anchor?.href !== donateUrl) return;

  const placement = anchor.closest("header")
    ? "header"
    : anchor.closest("footer")
      ? "footer"
      : "content";
  const params = { placement, currency: "USD" } as const;
  trackEvent("donate_cta_click", params, windowRef);
  trackEvent("donate_form_redirect", params, windowRef);
}

function getGtag(windowRef: AnalyticsWindow): Gtag {
  if (windowRef.gtag) return windowRef.gtag;

  windowRef.dataLayer = windowRef.dataLayer ?? [];
  windowRef.gtag = function gtag() {
    windowRef.dataLayer?.push(arguments);
  };
  return windowRef.gtag;
}

function loadGoogleTag(documentRef: Document, measurementId: string): void {
  if (documentRef.querySelector("script[data-njpbs-google-tag]")) return;

  const script = documentRef.createElement("script");
  script.async = true;
  script.dataset.njpbsGoogleTag = "";
  script.src =
    `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
  documentRef.head.append(script);
}

function setGoogleTagDisabled(
  windowRef: AnalyticsWindow,
  measurementId: string,
  disabled: boolean,
): void {
  (windowRef as unknown as Record<string, unknown>)[
    `ga-disable-${measurementId}`
  ] = disabled;
}

function clearMailchimpOptOut(documentRef: Document): void {
  documentRef.cookie =
    "mc_user_optin=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; SameSite=Lax; Secure";
}

function grantMailchimp(
  documentRef: Document,
  windowRef: AnalyticsWindow,
): void {
  if (windowRef.$mcSite) {
    windowRef.$mcSite.enableOptIn();
    return;
  }

  clearMailchimpOptOut(documentRef);
  windowRef.njpbsLoadMailchimp?.();
}

function denyMailchimp(
  documentRef: Document,
  windowRef: AnalyticsWindow,
): void {
  documentRef.cookie =
    `mc_user_optin=false; Path=/; Max-Age=${CONSENT_MAX_AGE_SECONDS}; ` +
    "SameSite=Lax; Secure";
  windowRef.$mcSite?.createCookie("mc_user_optin", false, 365);
}

function grantAnalytics(
  documentRef: Document,
  windowRef: AnalyticsWindow,
  measurementId: string,
): void {
  writeAnalyticsConsent(documentRef, "granted");
  setGoogleTagDisabled(windowRef, measurementId, false);
  const gtag = getGtag(windowRef);
  gtag("consent", "update", {
    analytics_storage: "granted",
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
  });
  grantMailchimp(documentRef, windowRef);
  windowRef.njpbsLoadWisepops?.();
  loadActiveCampaign(windowRef, () =>
    readAnalyticsConsent(documentRef.cookie) === "granted" &&
    !isGlobalPrivacyControlEnabled(windowRef.navigator));
  if (documentRef.querySelector("script[data-njpbs-google-tag]")) return;

  gtag("js", new Date());
  gtag("config", measurementId, {
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
    send_page_view: true,
  });
  loadGoogleTag(documentRef, measurementId);
}

function denyAnalytics(
  documentRef: Document,
  windowRef: AnalyticsWindow,
  hostname: string,
  measurementId: string,
): void {
  writeAnalyticsConsent(documentRef, "denied");
  stopAnalytics(documentRef, windowRef, hostname, measurementId);
}

function stopAnalytics(
  documentRef: Document,
  windowRef: AnalyticsWindow,
  hostname: string,
  measurementId: string,
): void {
  deleteAnalyticsCookies(documentRef, hostname);
  denyMailchimp(documentRef, windowRef);
  // Consent Mode prevents storage. This GA switch also stops event transport if
  // a visitor revokes consent after the Google tag loaded in the current tab.
  setGoogleTagDisabled(windowRef, measurementId, true);
  getGtag(windowRef)("consent", "update", {
    analytics_storage: "denied",
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
  });
  stopActiveCampaign(windowRef);
  windowRef.njpbsStopWisepops?.();
}

function setBannerState(root: HTMLElement, gpcEnabled: boolean): void {
  root.hidden = false;
  for (const element of root.querySelectorAll<HTMLElement>("[data-consent-choice]")) {
    element.hidden = gpcEnabled;
  }
  for (const element of root.querySelectorAll<HTMLElement>("[data-consent-gpc]")) {
    element.hidden = !gpcEnabled;
  }
  root.querySelector<HTMLButtonElement>("[data-consent-close]")!.hidden = !gpcEnabled;
}

export function initAnalyticsConsent(
  root: HTMLElement,
  windowRef: AnalyticsWindow = window,
): void {
  const measurementId = root.dataset.measurementId;
  if (!isGa4MeasurementId(measurementId)) return;

  const documentRef = windowRef.document;
  const navigatorRef = windowRef.navigator;
  const gpcEnabled = isGlobalPrivacyControlEnabled(navigatorRef);
  let gpcNoticeShown = gpcEnabled;
  const storedDecision = readAnalyticsConsent(documentRef.cookie);
  const grantButton = root.querySelector<HTMLButtonElement>("[data-consent-grant]")!;
  const denyButton = root.querySelector<HTMLButtonElement>("[data-consent-deny]")!;
  const closeButton = root.querySelector<HTMLButtonElement>("[data-consent-close]")!;

  const enforceSharedDenial = (): boolean => {
    const gpcNow = isGlobalPrivacyControlEnabled(navigatorRef);
    const decision = readAnalyticsConsent(documentRef.cookie);
    if (!gpcNow && decision === "granted") return false;
    if (gpcNow || decision === "denied") {
      denyAnalytics(documentRef, windowRef, windowRef.location.hostname, measurementId);
      if (gpcNow && (!gpcNoticeShown || !root.hidden)) {
        setBannerState(root, true);
        gpcNoticeShown = true;
      } else if (!gpcNow) {
        root.hidden = true;
      }
    } else {
      stopAnalytics(documentRef, windowRef, windowRef.location.hostname, measurementId);
      setBannerState(root, false);
    }
    return true;
  };

  let consentChannel: BroadcastChannel | null = null;
  const openConsentChannel = (): void => {
    if (consentChannel || typeof windowRef.BroadcastChannel !== "function") return;
    consentChannel = new windowRef.BroadcastChannel(CONSENT_CHANNEL);
    consentChannel.addEventListener("message", (event: MessageEvent) => {
      if (event.data === "denied") enforceSharedDenial();
    });
  };
  openConsentChannel();
  const postDenial = (): void => {
    consentChannel?.postMessage("denied");
  };

  const recheckConsent = (): void => {
    if (enforceSharedDenial() && isGlobalPrivacyControlEnabled(navigatorRef)) {
      postDenial();
    }
  };
  windowRef.addEventListener("focus", recheckConsent);
  windowRef.addEventListener("pagehide", () => {
    consentChannel?.close();
    consentChannel = null;
  });
  windowRef.addEventListener("pageshow", () => {
    openConsentChannel();
    recheckConsent();
  });
  documentRef.addEventListener("visibilitychange", () => {
    if (documentRef.visibilityState === "visible") recheckConsent();
  });

  if (gpcEnabled) {
    denyAnalytics(
      documentRef,
      windowRef,
      windowRef.location.hostname,
      measurementId,
    );
    postDenial();
    if (storedDecision !== "denied") setBannerState(root, true);
  } else if (storedDecision === "granted") {
    grantAnalytics(documentRef, windowRef, measurementId);
  } else if (storedDecision === "denied") {
    denyAnalytics(
      documentRef,
      windowRef,
      windowRef.location.hostname,
      measurementId,
    );
    postDenial();
  } else if (storedDecision === null) {
    setBannerState(root, false);
  }

  grantButton.addEventListener("click", () => {
    if (isGlobalPrivacyControlEnabled(navigatorRef)) {
      denyAnalytics(
        documentRef,
        windowRef,
        windowRef.location.hostname,
        measurementId,
      );
      postDenial();
      setBannerState(root, true);
      return;
    }
    grantAnalytics(documentRef, windowRef, measurementId);
    root.hidden = true;
  });

  denyButton.addEventListener("click", () => {
    denyAnalytics(
      documentRef,
      windowRef,
      windowRef.location.hostname,
      measurementId,
    );
    postDenial();
    root.hidden = true;
  });

  closeButton.addEventListener("click", () => {
    root.hidden = true;
  });

  for (const button of documentRef.querySelectorAll<HTMLElement>("[data-consent-open]")) {
    button.addEventListener("click", () => {
      setBannerState(root, isGlobalPrivacyControlEnabled(navigatorRef));
      const firstAction = root.querySelector<HTMLButtonElement>(
        isGlobalPrivacyControlEnabled(navigatorRef)
          ? "[data-consent-close]"
          : "[data-consent-grant]",
      );
      firstAction?.focus();
    });
  }
}
