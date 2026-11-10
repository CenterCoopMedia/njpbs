import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockScriptRequests } from "./mock-script-requests";
import {
  ANALYTICS_CONSENT_DENIED,
  ANALYTICS_CONSENT_GRANTED,
  initAnalyticsConsent,
  isGa4MeasurementId,
  readAnalyticsConsent,
  recordDonateClick,
  recordSiteSearch,
} from "../src/lib/analytics-consent";
import { donateUrl } from "../src/data/launch-fallback";

type TestWindow = Window & {
  dataLayer?: IArguments[];
  gtag?: (...args: unknown[]) => void;
  njpbsLoadMailchimp?: () => void;
  njpbsLoadWisepops?: () => void;
  njpbsStopWisepops?: () => void;
  $mcSite?: {
    createCookie: ReturnType<typeof vi.fn>;
    enableOptIn: ReturnType<typeof vi.fn>;
  };
};

function banner(): HTMLElement {
  document.body.innerHTML = `
    <button data-consent-open>Open</button>
    <aside data-analytics-consent data-measurement-id="G-TEST123456" hidden>
      <p data-consent-choice>Choice</p>
      <p data-consent-gpc hidden>GPC</p>
      <div data-consent-choice>
        <button data-consent-deny>Deny</button>
        <button data-consent-grant>Grant</button>
      </div>
      <div data-consent-gpc hidden>
        <button data-consent-close hidden>Close</button>
      </div>
    </aside>`;
  return document.querySelector<HTMLElement>("[data-analytics-consent]")!;
}

function setGpc(enabled: boolean): void {
  Object.defineProperty(navigator, "globalPrivacyControl", {
    configurable: true,
    value: enabled,
  });
}

function clearCookies(): void {
  for (const name of ["njpbs-consent", "mc_user_optin", "_ga", "_ga_TEST"]) {
    document.cookie = `${name}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0`;
  }
}

beforeEach(() => {
  mockScriptRequests();
  vi.unstubAllGlobals();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  clearCookies();
  setGpc(false);
  delete (window as TestWindow).dataLayer;
  delete (window as TestWindow).gtag;
  delete (window as TestWindow).njpbsLoadMailchimp;
  delete (window as TestWindow).njpbsLoadWisepops;
  delete (window as TestWindow).njpbsStopWisepops;
  delete (window as TestWindow).$mcSite;
  delete (window as unknown as Record<string, unknown>)[
    "ga-disable-G-TEST123456"
  ];
});

describe("analytics consent", () => {
  it("accepts GA4 measurement IDs and rejects other tag shapes", () => {
    expect(isGa4MeasurementId("G-TEST123456")).toBe(true);
    expect(isGa4MeasurementId("UA-123-1")).toBe(false);
    expect(isGa4MeasurementId("GTM-TEST123")).toBe(false);
    expect(isGa4MeasurementId(undefined)).toBe(false);
  });

  it("reads only one exact, versioned consent decision", () => {
    const granted = encodeURIComponent(ANALYTICS_CONSENT_GRANTED);
    const denied = encodeURIComponent(ANALYTICS_CONSENT_DENIED);

    expect(readAnalyticsConsent(`njpbs-consent=${granted}`)).toBe("granted");
    expect(readAnalyticsConsent(`njpbs-consent=${denied}`)).toBe("denied");
    expect(readAnalyticsConsent("njpbs-consent=v2%3Aanalytics%3Dgranted")).toBeNull();
    expect(readAnalyticsConsent("njpbs-consent=v2:analytics=granted,mailchimp=granted,ads=denied")).toBeNull();
    expect(readAnalyticsConsent("njpbs-consent=v3:analytics=granted,mailchimp=granted,activecampaign=granted,ads=denied")).toBeNull();
    expect(
      readAnalyticsConsent(
        `njpbs-consent=${granted}; njpbs-consent=${denied}`,
      ),
    ).toBeNull();
  });

  it("does not load analytics or newsletter tools before a visitor grants consent", () => {
    const root = banner();
    const loadMailchimp = vi.fn();
    const loadWisepops = vi.fn();
    (window as TestWindow).njpbsLoadMailchimp = loadMailchimp;
    (window as TestWindow).njpbsLoadWisepops = loadWisepops;
    document.cookie = "mc_user_optin=false; Path=/";
    let googleTag: HTMLScriptElement | undefined;
    vi.spyOn(document.head, "append").mockImplementation((...nodes) => {
      googleTag = nodes[0] as HTMLScriptElement;
    });
    initAnalyticsConsent(root);

    expect(root.hidden).toBe(false);
    expect(document.querySelector("script[data-njpbs-google-tag]")).toBeNull();
    expect(loadMailchimp).not.toHaveBeenCalled();
    expect(loadWisepops).not.toHaveBeenCalled();

    root.querySelector<HTMLButtonElement>("[data-consent-grant]")!.click();

    expect(root.hidden).toBe(true);
    expect(readAnalyticsConsent(document.cookie)).toBe("granted");
    expect(googleTag?.src).toBe(
      "https://www.googletagmanager.com/gtag/js?id=G-TEST123456",
    );
    expect(loadMailchimp).toHaveBeenCalledOnce();
    expect(loadWisepops).toHaveBeenCalledOnce();
    expect(document.cookie).not.toMatch(/mc_user_optin=(false|true)/);
    expect((window as TestWindow).dataLayer?.map((entry) => entry[0])).toEqual([
      "consent",
      "js",
      "config",
    ]);
  });

  it("honors GPC, stores denial, and never loads Google", () => {
    setGpc(true);
    const root = banner();
    const loadMailchimp = vi.fn();
    const loadWisepops = vi.fn();
    (window as TestWindow).njpbsLoadMailchimp = loadMailchimp;
    (window as TestWindow).njpbsLoadWisepops = loadWisepops;
    initAnalyticsConsent(root);

    expect(root.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>("[data-consent-choice]")!.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>("[data-consent-gpc]")!.hidden).toBe(false);
    expect(readAnalyticsConsent(document.cookie)).toBe("denied");
    expect(document.querySelector("script[data-njpbs-google-tag]")).toBeNull();
    expect(loadMailchimp).not.toHaveBeenCalled();
    expect(loadWisepops).not.toHaveBeenCalled();
    expect(document.cookie).toContain("mc_user_optin=false");
  });

  it("removes GA cookies when a visitor denies analytics", () => {
    document.cookie = "_ga=GA1.1.123.456; Path=/";
    document.cookie = "_ga_TEST=GS1.1.123.1; Path=/";
    const root = banner();
    initAnalyticsConsent(root);
    root.querySelector<HTMLButtonElement>("[data-consent-deny]")!.click();

    expect(readAnalyticsConsent(document.cookie)).toBe("denied");
    expect(document.cookie).not.toContain("_ga=");
    expect(document.cookie).not.toContain("_ga_TEST=");
    expect(document.querySelector("script[data-njpbs-google-tag]")).toBeNull();
    expect(
      (window as unknown as Record<string, unknown>)[
        "ga-disable-G-TEST123456"
      ],
    ).toBe(true);
  });

  it("keeps stored denial enforced and removes stale GA cookies", () => {
    document.cookie =
      `njpbs-consent=${encodeURIComponent(ANALYTICS_CONSENT_DENIED)}; Path=/`;
    document.cookie = "_ga=GA1.1.123.456; Path=/";

    const root = banner();
    initAnalyticsConsent(root);

    expect(root.hidden).toBe(true);
    expect(document.cookie).not.toContain("_ga=");
    expect(
      (window as unknown as Record<string, unknown>)[
        "ga-disable-G-TEST123456"
      ],
    ).toBe(true);
  });

  it("disables Google transport when consent is revoked after a grant", () => {
    const root = banner();
    const createMailchimpCookie = vi.fn();
    const stopWisepops = vi.fn();
    (window as TestWindow).njpbsLoadMailchimp = vi.fn();
    (window as TestWindow).njpbsLoadWisepops = vi.fn();
    (window as TestWindow).njpbsStopWisepops = stopWisepops;
    (window as TestWindow).$mcSite = {
      createCookie: createMailchimpCookie,
      enableOptIn: vi.fn(),
    };
    vi.spyOn(document.head, "append").mockImplementation(() => undefined);
    initAnalyticsConsent(root);

    root.querySelector<HTMLButtonElement>("[data-consent-grant]")!.click();
    expect(
      (window as unknown as Record<string, unknown>)[
        "ga-disable-G-TEST123456"
      ],
    ).toBe(false);

    document.querySelector<HTMLButtonElement>("[data-consent-open]")!.click();
    root.querySelector<HTMLButtonElement>("[data-consent-deny]")!.click();

    expect(
      (window as unknown as Record<string, unknown>)[
        "ga-disable-G-TEST123456"
      ],
    ).toBe(true);
    expect(createMailchimpCookie).toHaveBeenCalledWith(
      "mc_user_optin",
      false,
      365,
    );
    expect(stopWisepops).toHaveBeenCalled();
  });

  it("records search only under an active analytics grant without GPC", () => {
    const root = banner();
    vi.spyOn(document.head, "append").mockImplementation(() => undefined);
    initAnalyticsConsent(root);
    recordSiteSearch("before grant", 0);
    expect((window as TestWindow).dataLayer).toBeUndefined();

    root.querySelector<HTMLButtonElement>("[data-consent-grant]")!.click();
    recordSiteSearch("local news", 0);
    expect(Array.from((window as TestWindow).dataLayer!.at(-1)!)).toEqual([
      "event", "search", { search_term: "local news", results_count: 0 },
    ]);

    setGpc(true);
    recordSiteSearch("private query", 2);
    expect((window as TestWindow).dataLayer).toHaveLength(4);
  });

  it("records the PBS donation handoff only with an active analytics grant", () => {
    const root = banner();
    vi.spyOn(document.head, "append").mockImplementation(() => undefined);
    initAnalyticsConsent(root);
    document.body.insertAdjacentHTML("beforeend", `
      <header><a href="${donateUrl}"><span>Donate</span></a></header>
      <main><a href="/give/">Learn about giving</a></main>
    `);
    const donateLink = document.querySelector<HTMLAnchorElement>("header a")!;
    document.addEventListener("click", recordDonateClick);

    donateLink.querySelector("span")!.click();
    expect((window as TestWindow).dataLayer).toBeUndefined();

    root.querySelector<HTMLButtonElement>("[data-consent-grant]")!.click();
    document.querySelector<HTMLAnchorElement>("main a")!.click();
    donateLink.querySelector("span")!.click();
    const events = (window as TestWindow).dataLayer!
      .slice(3)
      .map((entry) => Array.from(entry));
    expect(events).toEqual([
      ["event", "donate_cta_click", { placement: "header", currency: "USD" }],
      ["event", "donate_form_redirect", { placement: "header", currency: "USD" }],
    ]);

    setGpc(true);
    donateLink.click();
    expect((window as TestWindow).dataLayer).toHaveLength(5);
    document.removeEventListener("click", recordDonateClick);
  });

  it.each(["focus", "pageshow"])(
    "rechecks shared denial on %s",
    (eventName) => {
      const root = banner();
      vi.spyOn(document.head, "append").mockImplementation(() => undefined);
      initAnalyticsConsent(root);
      root.querySelector<HTMLButtonElement>("[data-consent-grant]")!.click();

      document.cookie =
        `njpbs-consent=${encodeURIComponent(ANALYTICS_CONSENT_DENIED)}; Path=/`;
      window.dispatchEvent(new Event(eventName));

      expect(
        (window as unknown as Record<string, unknown>)[
          "ga-disable-G-TEST123456"
        ],
      ).toBe(true);
      expect((window as TestWindow).dataLayer?.at(-1)?.[0]).toBe("consent");
      expect((window as TestWindow).dataLayer?.at(-1)?.[2]).toMatchObject({
        analytics_storage: "denied",
      });
    },
  );

  it("stops transport and restores the consent prompt when the cookie disappears", () => {
    const root = banner();
    vi.spyOn(document.head, "append").mockImplementation(() => undefined);
    initAnalyticsConsent(root);
    root.querySelector<HTMLButtonElement>("[data-consent-grant]")!.click();
    document.cookie = "njpbs-consent=; Path=/; Max-Age=0";

    window.dispatchEvent(new Event("focus"));

    expect(readAnalyticsConsent(document.cookie)).toBeNull();
    expect(root.hidden).toBe(false);
    expect((window as unknown as Record<string, unknown>)["ga-disable-G-TEST123456"])
      .toBe(true);
  });

  it("applies denial broadcasts from another page", () => {
    let receiveMessage: ((event: MessageEvent) => void) | undefined;
    const postMessage = vi.fn();
    class TestBroadcastChannel {
      constructor(name: string) {
        expect(name).toBe("njpbs-analytics-consent");
      }

      addEventListener(
        type: string,
        listener: (event: MessageEvent) => void,
      ): void {
        if (type === "message") receiveMessage = listener;
      }

      postMessage = postMessage;
      close(): void {}
    }
    vi.stubGlobal("BroadcastChannel", TestBroadcastChannel);
    const root = banner();
    vi.spyOn(document.head, "append").mockImplementation(() => undefined);
    initAnalyticsConsent(root);
    root.querySelector<HTMLButtonElement>("[data-consent-grant]")!.click();

    document.cookie =
      `njpbs-consent=${encodeURIComponent(ANALYTICS_CONSENT_DENIED)}; Path=/`;
    receiveMessage?.(new MessageEvent("message", { data: "denied" }));

    expect(
      (window as unknown as Record<string, unknown>)[
        "ga-disable-G-TEST123456"
      ],
    ).toBe(true);
    expect(root.hidden).toBe(true);

    document.querySelector<HTMLButtonElement>("[data-consent-open]")!.click();
    root.querySelector<HTMLButtonElement>("[data-consent-deny]")!.click();
    expect(postMessage).toHaveBeenCalledWith("denied");
  });

  it("broadcasts a GPC denial during initialization", () => {
    const postMessage = vi.fn();
    class TestBroadcastChannel {
      addEventListener(): void {}
      postMessage = postMessage;
      close(): void {}
    }
    vi.stubGlobal("BroadcastChannel", TestBroadcastChannel);
    setGpc(true);

    initAnalyticsConsent(banner());

    expect(postMessage).toHaveBeenCalledWith("denied");
  });

  it("closes and reopens the consent channel across page cache navigation", () => {
    const channels: Array<{ close: ReturnType<typeof vi.fn> }> = [];
    class TestBroadcastChannel {
      close = vi.fn();
      addEventListener(): void {}
      postMessage(): void {}
      constructor() { channels.push(this); }
    }
    vi.stubGlobal("BroadcastChannel", TestBroadcastChannel);
    initAnalyticsConsent(banner());
    const current = channels.at(-1)!;

    window.dispatchEvent(new Event("pagehide"));
    expect(current.close).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event("pageshow"));
    expect(channels.length).toBeGreaterThan(1);
  });

  it("rechecks GPC before a visible page becomes active", () => {
    const root = banner();
    vi.spyOn(document.head, "append").mockImplementation(() => undefined);
    initAnalyticsConsent(root);
    root.querySelector<HTMLButtonElement>("[data-consent-grant]")!.click();

    setGpc(true);
    window.dispatchEvent(new Event("focus"));

    expect(readAnalyticsConsent(document.cookie)).toBe("denied");
    expect(root.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>("[data-consent-gpc]")!.hidden).toBe(false);
    expect(
      (window as unknown as Record<string, unknown>)[
        "ga-disable-G-TEST123456"
      ],
    ).toBe(true);
  });

  it("restores Mailchimp opt-in when a visitor grants after a denial", () => {
    document.cookie =
      `njpbs-consent=${encodeURIComponent(ANALYTICS_CONSENT_DENIED)}; Path=/`;
    const enableMailchimp = vi.fn(() => {
      document.cookie = "mc_user_optin=true; Path=/";
    });
    (window as TestWindow).$mcSite = {
      createCookie: vi.fn(),
      enableOptIn: enableMailchimp,
    };
    const root = banner();
    vi.spyOn(document.head, "append").mockImplementation(() => undefined);
    initAnalyticsConsent(root);

    document.querySelector<HTMLButtonElement>("[data-consent-open]")!.click();
    root.querySelector<HTMLButtonElement>("[data-consent-grant]")!.click();

    expect(enableMailchimp).toHaveBeenCalledOnce();
    expect(document.cookie).toContain("mc_user_optin=true");
  });

  it("records an opt-out while the Mailchimp script is still loading", () => {
    const loadMailchimp = vi.fn();
    (window as TestWindow).njpbsLoadMailchimp = loadMailchimp;
    const root = banner();
    vi.spyOn(document.head, "append").mockImplementation(() => undefined);
    initAnalyticsConsent(root);

    root.querySelector<HTMLButtonElement>("[data-consent-grant]")!.click();
    document.querySelector<HTMLButtonElement>("[data-consent-open]")!.click();
    root.querySelector<HTMLButtonElement>("[data-consent-deny]")!.click();

    expect(loadMailchimp).toHaveBeenCalledOnce();
    expect(document.cookie).toContain("mc_user_optin=false");
  });
});
