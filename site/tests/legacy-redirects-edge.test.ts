import { afterEach, describe, expect, it, vi } from "vitest";

// The edge wrapper (site/snippets/legacy-redirects/snippet.js) turns a classifier decision
// into an edge response. classify itself is pinned in legacy-redirects.test.ts; here we mock
// it so each branch of the wrapper is exercised directly, including query handling for a
// hand-picked 301 path.
vi.mock("../src/lib/legacy-redirects", () => ({ classify: vi.fn() }));

import worker from "../snippets/legacy-redirects/snippet.js";
import { classify } from "../src/lib/legacy-redirects";

const mockClassify = vi.mocked(classify);

afterEach(() => {
  vi.unstubAllGlobals();
  mockClassify.mockReset();
});

describe("legacy-redirects edge wrapper", () => {
  it("preserves the request query string on a hand-picked 301", async () => {
    mockClassify.mockReturnValue({ action: "redirect", location: "/watch/" });
    const res = await worker.fetch(
      new Request("https://njpbs.org/all-programs?utm_source=x&y=1"),
    );
    expect(res.status).toBe(301);
    // The migration contract requires 301s to keep the query string; the destination has
    // none of its own, so the request's params carry over.
    expect(res.headers.get("location")).toBe("https://njpbs.org/watch/?utm_source=x&y=1");
  });

  it("lets a destination's own query string win over the request's", async () => {
    mockClassify.mockReturnValue({ action: "redirect", location: "/give?campaign=passport" });
    const res = await worker.fetch(new Request("https://njpbs.org/x?utm_source=x"));
    expect(res.headers.get("location")).toBe("https://njpbs.org/give?campaign=passport");
  });

  it("serves a pass-through through the ASSETS binding when present", async () => {
    mockClassify.mockReturnValue(null);
    const assetsFetch = vi.fn().mockResolvedValue(new Response("asset", { status: 200 }));
    const globalFetch = vi.fn();
    vi.stubGlobal("fetch", globalFetch);
    const res = await worker.fetch(new Request("https://njpbs.org/give"), {
      ASSETS: { fetch: assetsFetch },
    });
    // A Worker fronting Workers Assets must route pass-through through env.ASSETS, or a
    // plain fetch(request) recurses into this same route.
    expect(assetsFetch).toHaveBeenCalledOnce();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("falls back to origin fetch when there is no ASSETS binding", async () => {
    mockClassify.mockReturnValue(null);
    const globalFetch = vi.fn().mockResolvedValue(new Response("origin", { status: 200 }));
    vi.stubGlobal("fetch", globalFetch);
    await worker.fetch(new Request("https://njpbs.org/give"), {}); // env present, no ASSETS
    expect(globalFetch).toHaveBeenCalledOnce();
    await worker.fetch(new Request("https://njpbs.org/give")); // env undefined (Snippet form)
    expect(globalFetch).toHaveBeenCalledTimes(2);
  });

  it("returns a 410 with the retired-page body and the security baseline", async () => {
    // The gone branch is the wrapper's only substantive body. It carries the retired-page
    // HTML, a cacheable 410, and the same security headers as the 301, since Workers Assets
    // never applies site/public/_headers to a synthetic edge response.
    mockClassify.mockReturnValue({ action: "gone" });
    const res = await worker.fetch(new Request("https://njpbs.org/njtv-pressroom/old-show"));
    expect(res.status).toBe(410);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toContain("no longer available");
  });
});
