/** Private service relay. It has no Firestore credential and forwards only the
 * signed published-read request to the explicitly configured Function.
 */
export async function forwardPublishedPostRead(request: Request,
  env: { PUBLISHED_POST_FUNCTION_URL: string }, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const incoming = new URL(request.url);
  if (request.method !== "GET" || incoming.origin !== "https://published-posts.internal" || incoming.search ||
      !/^\/posts\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(incoming.pathname)) return new Response(null, { status: 403 });
  try {
    const endpoint = new URL(env.PUBLISHED_POST_FUNCTION_URL);
    if (endpoint.protocol !== "https:" || !/^[a-z0-9-]+\.cloudfunctions\.net$/.test(endpoint.hostname) ||
        endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
        endpoint.pathname !== "/cmsGetPublishedPost") throw new Error("Unconfigured reader");
    const headers = new Headers();
    for (const name of ["x-njpbs-post-timestamp", "x-njpbs-post-signature"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const response = await fetchImpl(new Request(`${endpoint.href}${incoming.pathname}`, {
      method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(10_000),
    }));
    if (response.status >= 300 && response.status < 400) throw new Error("Reader redirect refused");
    return response;
  } catch {
    return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
export default {
  fetch(request: Request, env: { PUBLISHED_POST_FUNCTION_URL: string }): Promise<Response> {
    return forwardPublishedPostRead(request, env);
  },
};
