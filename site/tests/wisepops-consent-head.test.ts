import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

import {
  WISEPOPS_CONSENT_SNIPPET,
  WISEPOPS_SCRIPT_URL,
} from "../src/lib/analytics-consent-head";

type ScriptRecord = {
  defer?: boolean;
  nonce?: string;
  src?: string;
  attributes: Record<string, string>;
  setAttribute(name: string, value: string): void;
};

function execute(cookie = "") {
  const inserted: ScriptRecord[] = [];
  const reload = vi.fn();
  const parentNode = {
    insertBefore(script: ScriptRecord) {
      inserted.push(script);
    },
  };
  const documentRef = {
    cookie,
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
    navigator: { globalPrivacyControl: false },
    window: windowRef,
  });
  return { inserted, reload, windowRef };
}

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
    const wisepops = windowRef.wisepops as { q: IArguments[] };
    expect(wisepops.q.map((args) => Array.from(args))).toEqual([
      ["options", { defaultConsent: "denied" }],
      ["consent", "granted"],
    ]);

    (windowRef.njpbsStopWisepops as () => void)();
    expect(reload).toHaveBeenCalledOnce();
  });
});
