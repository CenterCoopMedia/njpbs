import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockScriptRequests } from "./mock-script-requests";
import { loadActiveCampaign, stopActiveCampaign } from "../src/lib/activecampaign-consent";
import { isChildDirectedPage, isKidsPath } from "../src/lib/analytics-page-policy";

const selector = "script[data-njpbs-activecampaign]";
function context(pathname = "/about/") {
  return { document, location: { pathname, reload: vi.fn() } } as unknown as Window & {
    vgo?: ((...args: unknown[]) => void) & { q?: unknown[][] };
  };
}
beforeEach(() => {
  mockScriptRequests();
  document.head.innerHTML = "";
  document.body.innerHTML = '<aside data-activecampaign-enabled></aside>';
});

describe("child-directed exclusions", () => {
  it.each(["/kids", "/kids/", "/kids/games/", "/kids/games/deep/", "/KIDS/games/", "/%6bids/games/", "/fr/kids/games/"])("blocks %s before loading", path => {
    expect(isKidsPath(path)).toBe(true);
    loadActiveCampaign(context(path), () => true);
    expect(document.querySelector(selector)).toBeNull();
  });
  it("also excludes a canonical alias, Kids page identity and explicit template metadata", () => {
    for (const input of [{ canonicalPath: "/kids/games/" }, { pageId: "kids" }, { childDirected: true }]) {
      expect(isChildDirectedPage({ path: "/learn/", ...input })).toBe(true);
    }
    expect(isKidsPath("/%invalid")).toBe(true);
    expect(isKidsPath("/kids-news/")).toBe(false);
    expect(isChildDirectedPage({ path: "/about/", childDirected: false })).toBe(false);
  });
});

describe("ActiveCampaign consent loader (DOM only; no vendor code)", () => {
  it("requests nothing without an allowed decision or an eligible-page marker", () => {
    const win = context();
    loadActiveCampaign(win, () => false);
    expect(win.vgo).toBeUndefined();
    expect(document.querySelector(selector)).toBeNull();
    document.body.innerHTML = '<meta data-child-directed><aside data-activecampaign-enabled></aside>';
    loadActiveCampaign(win, () => true);
    expect(document.querySelector(selector)).toBeNull();
    document.body.innerHTML = "";
    loadActiveCampaign(win, () => true);
    expect(document.querySelector(selector)).toBeNull();
  });
  it("defaults off and processes one visit only after load and a current grant", () => {
    const win = context();
    loadActiveCampaign(win, () => true);
    loadActiveCampaign(win, () => true);
    const scripts = document.querySelectorAll<HTMLScriptElement>(selector);
    expect(scripts).toHaveLength(1);
    expect(scripts[0].src).toBe("https://diffuser-cdn.app-us1.com/diffuser/diffuser.js");
    expect(scripts[0].referrerPolicy).toBe("no-referrer");
    expect(win.vgo?.q).toEqual([["setAccount", "255654599"], ["setTrackByDefault", false]]);
    const vendor = vi.fn();
    win.vgo = vendor;
    scripts[0].dispatchEvent(new Event("load"));
    expect(vendor.mock.calls).toEqual([["process", "allowTracking"]]);
  });
  it.each(["denied", "gpc", "cookie lost", "Kids navigation"])("does not process a late load after %s", reason => {
    const win = context();
    let allowed = true;
    loadActiveCampaign(win, () => allowed);
    const script = document.querySelector<HTMLScriptElement>(selector)!;
    const vendor = vi.fn(); win.vgo = vendor;
    if (reason === "Kids navigation") win.location.pathname = "/kids/games/";
    else allowed = false;
    script.dispatchEvent(new Event("load"));
    expect(vendor).not.toHaveBeenCalled();
  });
  it("clears queued work, detaches the handler and reloads after revocation", () => {
    const win = context();
    loadActiveCampaign(win, () => true);
    const script = document.querySelector<HTMLScriptElement>(selector)!;
    const queue = win.vgo!.q!;
    document.cookie = "prism_255654599=test; Path=/";
    stopActiveCampaign(win);
    expect(queue).toEqual([]);
    expect(script.onload).toBeNull();
    expect(script.isConnected).toBe(false);
    expect(document.cookie).not.toContain("prism_255654599=");
    expect(win.location.reload).toHaveBeenCalledTimes(1);
    stopActiveCampaign(win);
    expect(win.location.reload).toHaveBeenCalledTimes(1);
  });
});
