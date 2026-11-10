import { describe, expect, it, vi } from "vitest";
import relay, { forwardPublishedPostRead } from "../workers/src/published-post-reader-worker";
import { servicePublishedPostReader, createShadowPostWorker } from "../workers/src/shadow-post-worker";
import { randomBytes } from "node:crypto";
import fixture from "../site/tests/fixtures/shadow-posts/post.json";

const url = "https://published-posts.internal/posts/shadow-fixture/";
const endpoint = "https://us-central1-demo-njpbs.cloudfunctions.net/cmsGetPublishedPost";

describe("private published reader relay", () => {
  it.each(["", "https://example.test/cmsGetPublishedPost", endpoint + "?key=private", endpoint.replace("https:", "http:"),
    endpoint.replace("cmsGetPublishedPost", "cmsSaveContent")])("makes no network call for invalid configuration %s", async value => {
    const fetchImpl = vi.fn();
    const response = await forwardPublishedPostRead(new Request(url), { PUBLISHED_POST_FUNCTION_URL: value }, fetchImpl);
    expect(response.status).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("strips staff credentials and refuses redirects or network errors", async () => {
    const fetchImpl = vi.fn(async request => {
      expect(request.url).toBe(endpoint + "/posts/shadow-fixture/");
      expect(request.redirect).toBe("manual");
      expect([...request.headers.keys()]).toEqual(["x-njpbs-post-signature", "x-njpbs-post-timestamp"]);
      throw new Error("Private network error");
    });
    const request = new Request(url, { headers: { cookie: "Private staff session", authorization: "Private staff header",
      "x-njpbs-post-signature": "Signed request", "x-njpbs-post-timestamp": "1791397200000" } });
    const response = await forwardPublishedPostRead(request, { PUBLISHED_POST_FUNCTION_URL: endpoint }, fetchImpl);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("Private");
  });
  it("uses the Worker fetch signature when an execution context is supplied", async () => {
    expect((await relay.fetch(new Request(url), { PUBLISHED_POST_FUNCTION_URL: "" })).status).toBe(503);
  });
  it.each([url + "?draft=true", "https://example.test/posts/shadow-fixture/", "https://published-posts.internal/cmsSaveContent"])(
    "refuses non-contract requests %s", async value => {
      const fetchImpl = vi.fn();
      expect((await forwardPublishedPostRead(new Request(value), { PUBLISHED_POST_FUNCTION_URL: endpoint }, fetchImpl)).status).toBe(403);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  it("maps 404 and 410 to content state only for the reader's JSON envelope", async () => {
    const now = new Date("2026-10-07T13:00:00Z");
    const json = { "Content-Type": "application/json" };
    const read = (response: Response) => servicePublishedPostReader({ async fetch() { return response; } },
      { secret: randomBytes(32).toString("hex"), now: () => now }).read("shadow-fixture");
    expect(await read(new Response(JSON.stringify({ kind: "not-found" }), { status: 404, headers: json }))).toBeNull();
    expect(await read(new Response(JSON.stringify({ kind: "gone" }), { status: 410, headers: json }))).toEqual({ kind: "gone" });
    for (const response of [
      new Response("<html>Not found</html>", { status: 404, headers: { "Content-Type": "text/html" } }),
      new Response("<html>Gone</html>", { status: 410, headers: { "Content-Type": "text/html" } }),
      new Response(JSON.stringify({ kind: "gone" }), { status: 404, headers: json }),
      new Response("not json", { status: 404, headers: json }),
    ]) await expect(read(response)).rejects.toThrow("Published read failed");
  });
  it("fails closed on upstream errors even with cached HTML", async () => {
    const now = new Date("2026-10-07T13:00:00Z");
    let fail = false;
    const reader = servicePublishedPostReader({ async fetch() {
      return fail ? new Response(null, { status: 403 }) : new Response(JSON.stringify(fixture), { headers: { "Content-Type": "application/json" } });
    } }, { secret: randomBytes(32).toString("hex"), now: () => now });
    let cached: Response | undefined;
    const worker = createShadowPostWorker({ reader, rendererSha: "a".repeat(40), now: () => now,
      cache: { async match() { return cached?.clone(); }, async put(_key, response) { cached = response.clone(); } },
      async render() { return "<!doctype html><html><main>Authorized body</main></html>"; } });
    const request = new Request("https://dev-public.example.org/posts/shadow-fixture/");
    const config = { SHADOW_POSTS_ENABLED: "true", SHADOW_POST_SLUGS: "shadow-fixture" };
    expect((await worker.fetch(request, config)).status).toBe(200);
    fail = true;
    const response = await worker.fetch(request, config);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("Authorized body");
  });
});
