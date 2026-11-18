import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

import {
  WISEPOPS_CONSENT_SNIPPET,
  WISEPOPS_SCRIPT_URL,
} from "../src/lib/analytics-consent-head";
import { ANALYTICS_CONSENT_DENIED, ANALYTICS_CONSENT_GRANTED } from "../src/lib/analytics-consent";

type ScriptRecord = {
  defer?: boolean;
  nonce?: string;
  src?: string;
  attributes: Record<string, string>;
  setAttribute(name: string, value: string): void;
};

function execute(cookie: string | Error = "", globalPrivacyControl = false) {
  const inserted: ScriptRecord[] = [];
  const reload = vi.fn();
  const writeCookie = vi.fn();
  const parentNode = {
    insertBefore(script: ScriptRecord) {
      inserted.push(script);
    },
  };
  const documentRef = {
    get cookie() {
      if (cookie instanceof Error) throw cookie;
      return cookie;
    },
    set cookie(value: string) { writeCookie(value); },
    currentScript: { nonce: "test-nonce" },
    createElement: () => {
      const script: ScriptRecord = {
        attributes: {},
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
      };
      return script;
    },
    getElementsByTagName: () => [{ parentNode }],
  };
  const windowRef: Record<string, unknown> = { location: { reload } };

  runInNewContext(WISEPOPS_CONSENT_SNIPPET, {
    decodeURIComponent,
    document: documentRef,
    navigator: { globalPrivacyControl },
    window: windowRef,
  });
  return { inserted, reload, windowRef, writeCookie };
}

const consentCookie = (value: string) => `njpbs-consent=${encodeURIComponent(value)}`;
const commands = (windowRef: Record<string, unknown>) =>
  (windowRef.wisepops as { q: IArguments[] }).q.map((args) => Array.from(args));

describe("Wisepops consent bootstrap", () => {
  it("stays idle until consent, then queues denial before grant and loads once", () => {
    const { inserted, reload, windowRef } = execute();

    expect(inserted).toEqual([]);
    (windowRef.njpbsStopWisepops as () => void)();
    expect(reload).not.toHaveBeenCalled();

    (windowRef.njpbsLoadWisepops as () => void)();
    (windowRef.njpbsLoadWisepops as () => void)();

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      attributes: {
        "data-cfasync": "false",
        "data-njpbs-wisepops": "",
      },
      defer: true,
      nonce: "test-nonce",
      src: WISEPOPS_SCRIPT_URL,
    });
    expect(commands(windowRef)).toEqual([
      ["options", { defaultConsent: "denied" }],
      ["consent", "granted"],
    ]);

    (windowRef.njpbsStopWisepops as () => void)();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("loads automatically when the stored consent grants newsletter tools", () => {
    const { inserted, windowRef } = execute(consentCookie(ANALYTICS_CONSENT_GRANTED));
    expect(inserted).toHaveLength(1);
    expect(commands(windowRef)).toEqual([
      ["options", { defaultConsent: "denied" }], ["consent", "granted"],
    ]);
  });

  it.each([
    { label: "no choice", cookie: "", gpc: false },
    { label: "denied", cookie: consentCookie(ANALYTICS_CONSENT_DENIED), gpc: false },
    { label: "GPC", cookie: consentCookie(ANALYTICS_CONSENT_GRANTED), gpc: true },
    { label: "unreadable cookie", cookie: new Error("Unreadable"), gpc: false },
  ])("loads in denied mode only after the form is requested with $label", ({ cookie, gpc }) => {
    const { inserted, reload, windowRef, writeCookie } = execute(cookie, gpc);
    expect(inserted).toHaveLength(0);
    (windowRef.njpbsShowSignupForm as () => void)();
    (windowRef.njpbsShowSignupForm as () => void)();
    if (gpc) (windowRef.njpbsLoadWisepops as () => void)();
    expect(inserted).toHaveLength(1);
    expect(inserted[0].src).toBe(WISEPOPS_SCRIPT_URL);
    expect(commands(windowRef)).toEqual([["options", { defaultConsent: "denied" }]]);
    expect(writeCookie).not.toHaveBeenCalled();
    (windowRef.njpbsStopWisepops as () => void)();
    expect(reload).not.toHaveBeenCalled();
  });

  it("upgrades the already loaded script only on an explicit grant", () => {
    const { inserted, reload, windowRef } = execute();
    (windowRef.njpbsShowSignupForm as () => void)();
    (windowRef.njpbsLoadWisepops as () => void)();
    (windowRef.njpbsLoadWisepops as () => void)();
    expect(inserted).toHaveLength(1);
    expect(commands(windowRef)).toEqual([
      ["options", { defaultConsent: "denied" }], ["consent", "granted"],
    ]);
    (windowRef.njpbsStopWisepops as () => void)();
    expect(reload).toHaveBeenCalledOnce();
  });
});
