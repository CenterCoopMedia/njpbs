import { servicePublishedPostReader } from "../workers/src/shadow-post-worker";
import { forwardPublishedPostRead } from "../workers/src/published-post-reader-worker";
import fixture from "../site/tests/fixtures/shadow-posts/post.json";

export default {
  async test() {
    const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    let redirect = false;
    const service = { fetch: (request: Request) => forwardPublishedPostRead(request,
      { PUBLISHED_POST_FUNCTION_URL: "https://us-central1-demo-njpbs.cloudfunctions.net/cmsGetPublishedPost" }, async upstream => {
        const sent = upstream as Request;
        if (sent.redirect !== "manual") throw new Error("Unsafe redirect policy");
        const hex = sent.headers.get("x-njpbs-post-signature")!;
        const signature = Uint8Array.from(hex.match(/../g)!, value => parseInt(value, 16));
        const message = `njpbs-post-reader-v1\nGET\n/posts/shadow-fixture/\n${sent.headers.get("x-njpbs-post-timestamp")}`;
        if (!await crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(message))) throw new Error("Invalid runtime signature");
        return redirect ? new Response(null, { status: 302, headers: { Location: "https://example.test/" } })
          : new Response(JSON.stringify(fixture), { headers: { "Content-Type": "application/json" } });
      }) };
    const reader = servicePublishedPostReader(service, { secret });
    const result = await reader.read("shadow-fixture") as typeof fixture;
    if (result.kind !== "published-post" || result.document.published.sourceVersion !== 7) throw new Error("Runtime read failed");
    redirect = true;
    let refused = false;
    try { await reader.read("shadow-fixture"); } catch { refused = true; }
    if (!refused) throw new Error("Runtime accepted an upstream redirect");
  },
};
