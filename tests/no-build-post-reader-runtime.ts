import { WorkerEntrypoint } from "cloudflare:workers";
import type { PublicContentEntrypoint } from "../cms-api/src/index";
import { createNoBuildPostWorker } from "../workers/src/no-build-post-worker";
import fixture from "../site/tests/fixtures/shadow-posts/post.json";

// Synthetic Function network boundary, isolated from the test Worker. Its control
// binding changes responses while the actual CMS reader service stays running.
let responseState: { reply: unknown; status: number; next?: unknown } = { reply: null, status: 503 };
let requestCount = 0;
export class FunctionBoundary extends WorkerEntrypoint {
  setReply(reply: unknown, status = 200, next?: unknown) { responseState = { reply, status, next }; }
  count() { return requestCount; }
  async fetch(request: Request) {
    requestCount++;
    if (request.url !== "https://functions.example.test/cmsGetPublicPage" || request.method !== "POST") {
      return new Response(null, { status: 404 });
    }
    // This is a public test fixture, never a credential for any real service.
    if (request.headers.get("x-njpbs-cms-edge") !== "synthetic-edge-fixture") return new Response(null, { status: 401 });
    const body = await request.json() as { mode: string; rendererSha: string; path: string; method: string };
    assert(body.mode === "no-build-post-v1" && body.rendererSha === "a".repeat(40), "Authenticated read contract");
    assert(body.path.startsWith("/") && ["GET", "HEAD"].includes(body.method), "Read path and method contract");
    const { reply, status, next } = responseState;
    if (next !== undefined) responseState = { reply: next, status };
    if (status === 302) return new Response(null, { status, headers: { location: "https://redirect.example.test/" } });
    return Response.json(reply, { status });
  }
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export default {
  async test(_controller: unknown, env: {
    CONTENT: Service<typeof PublicContentEntrypoint>;
    UNAUTHENTICATED: Service<typeof PublicContentEntrypoint>;
    CONTROL: Service<FunctionBoundary>;
  }) {
    const rendererSha = "a".repeat(40);
    const receipt = { schemaVersion: 1 as const, postId: "shadow-fixture", operationId: "A".repeat(20), rendererSha,
      sourceVersion: 7, slug: "shadow-fixture", ownedSlugs: ["shadow-fixture"], generation: 1,
      visible: true, contextDigest: "b".repeat(64), admissionRevision: 1 };
    const published = { kind: "post", receipt, published: fixture };
    const cache = new Map<string, Response>();
    const worker = createNoBuildPostWorker({ rendererSha,
      cache: {
        async match(request: Request) { return cache.get(request.url)?.clone(); },
        async put(request: Request, response: Response) { cache.set(request.url, response.clone()); },
      },
      render: async content => `<!doctype html><html>${content.posts[0].title}</html>`,
      getDecision: (path, method, probe) => env.CONTENT.getNoBuildPost(path, rendererSha, method, probe),
      fetchAsset: async () => Response.json({ schemaVersion: 1, generation: 1, commitSha: rendererSha,
        buildBatchId: "baseline-fixture", collections: ["cmsPages", "cmsPosts"], routes: [] }),
    });
    const request = async (path = "/posts/shadow-fixture/", method = "GET") => {
      const response = await worker.fetch(new Request(`https://njpbs.org${path}`, { method }));
      assert(response, "Owned route fell through to stale static content");
      assert(response.headers.get("cache-control") === "no-store", "Response must not persist in browser cache");
      return response;
    };

    await env.CONTROL.setReply(null, 503);
    assert((await request()).status === 503, "Missing admission must fail closed");
    await env.CONTROL.setReply(published);
    let response = await request();
    assert(response.status === 200 && response.headers.get("x-njpbs-admission-revision") === "1", "Admitted Post receipt");
    assert((await response.text()).includes("A published fixture"), "Published content must render");
    assert(response.headers.get("access-control-expose-headers")?.includes("x-njpbs-admission-revision"), "Admin can read revision");
    assert((await request()).headers.get("x-njpbs-render-cache") === "HIT", "Admitted cache hit");

    await env.CONTROL.setReply({ ...published, receipt: { ...receipt, admissionRevision: 2 } });
    response = await request();
    assert(response.status === 200 && response.headers.get("x-njpbs-admission-revision") === "2", "Same reader must observe new revision");
    assert(response.headers.get("x-njpbs-render-cache") === "MISS", "Revision changes invalidate old render identity");
    await env.CONTROL.setReply(null, 503);
    assert((await request()).status === 503, "Paused admission cannot serve cached HTML");
    for (const admissionRevision of [3, null]) {
      await env.CONTROL.setReply({ kind: "gone", receipt: { ...receipt, visible: false, admissionRevision } });
      response = await request();
      assert(response.status === 410, "Tombstone survives paused or missing admission");
      assert(response.headers.get("x-njpbs-admission-revision") === (admissionRevision === null ? "unavailable" : "3"), "Tombstone revision receipt");
      assert(await (await request(undefined, "HEAD")).text() === "", "Tombstone HEAD has no body");
    }

    for (const admissionRevision of [undefined, null, 0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
      await env.CONTROL.setReply({ ...published, receipt: { ...receipt, admissionRevision } });
      assert((await request()).status === 503, "Invalid admission revision must fail closed");
    }
    for (const changed of [{ rendererSha: "c".repeat(40) }, { sourceVersion: 8 }, { operationId: "invalid" }]) {
      await env.CONTROL.setReply({ ...published, receipt: { ...receipt, ...changed } });
      assert((await request()).status === 503, "Wrong publication receipt must fail closed");
    }
    await env.CONTROL.setReply(published, 200, { ...published, receipt: { ...receipt, admissionRevision: 4 } });
    assert((await request()).status === 503, "Revision changes during rendering must fail closed");

    for (const path of ["/_publication.json", "/_content-status.json"]) {
      const bodies: { buildBatchId: string; admissionRevision: number }[] = [];
      for (const admissionRevision of [5, 6]) {
        await env.CONTROL.setReply({ kind: "receipts", receipt: { ...receipt, admissionRevision } });
        response = await request(path);
        assert(response.status === 200 && response.headers.get("x-njpbs-admission-revision") === String(admissionRevision), "Public receipt revision header");
        const body = await response.json() as typeof bodies[number];
        assert(body.admissionRevision === admissionRevision, "Public receipt revision body");
        bodies.push(body);
      }
      assert(bodies[0].buildBatchId !== bodies[1].buildBatchId, "Revision changes public JSON receipt identity");
    }
    await env.CONTROL.setReply({ kind: "alias", receipt: { ...receipt, slug: "renamed", admissionRevision: 7 }, location: "/posts/renamed/" });
    response = await request();
    assert(response.status === 308 && response.headers.get("x-njpbs-admission-revision") === "7", "Alias receipt revision");

    for (const admissionRevision of [undefined, "0", "1.5", "unavailable", "8"]) {
      await env.CONTROL.setReply({ kind: "background", status: 200, bytes: btoa("aggregate fixture"), headers: {
        "content-type": "text/plain", "x-njpbs-background-renderer-sha": rendererSha, ...(admissionRevision ? { "x-njpbs-admission-revision": admissionRevision } : {}),
      } });
      response = await request("/feeds/news.xml");
      assert(response.status === (admissionRevision === "8" ? 200 : 503), "Background response requires admission revision");
    }

    for (const kind of ["gone", "alias"] as const) {
      const { admissionRevision: _revision, ...legacy } = receipt;
      await env.CONTROL.setReply({ kind, receipt: { ...legacy, mode: "static" }, location: "/posts/shadow-fixture/" });
      response = await request();
      assert(response.status === (kind === "gone" ? 410 : 308), "Retained static rollback remains compatible");
      assert(!response.headers.has("x-njpbs-admission-revision"), "Legacy static has no invented revision");
    }

    await env.CONTROL.setReply(published, 302);
    const beforeRedirect = await env.CONTROL.count();
    assert((await request()).status === 503, "Upstream redirect must fail closed");
    assert(await env.CONTROL.count() === beforeRedirect + 1, "Authenticated read must never follow redirects");
    await env.CONTROL.setReply(published);
    let refused = false;
    try { await env.UNAUTHENTICATED.getNoBuildPost("/posts/shadow-fixture/", rendererSha); } catch { refused = true; }
    assert(refused, "Wrong edge authentication must be refused");
    for (const [path, sha, method] of [["relative", rendererSha, "GET"], ["/posts/shadow-fixture/", "bad", "GET"],
      ["/posts/shadow-fixture/", rendererSha, "POST"]]) {
      const before = await env.CONTROL.count();
      refused = false;
      try { await env.CONTENT.getNoBuildPost(path, sha, method); } catch { refused = true; }
      assert(refused && await env.CONTROL.count() === before, "Invalid read refused before authenticated network request");
    }
  },
};
