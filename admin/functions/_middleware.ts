import { onRequest as serveGuideContent } from "./guide-content/[[path]]";

type Context = Parameters<typeof serveGuideContent>[0] & {
  next: () => Promise<Response>;
};

function targetsGuideContent(pathname: string): boolean {
  let candidate = pathname;
  for (let depth = 0; depth < 4; depth += 1) {
    if (candidate.toLowerCase().includes("guide-content")) return true;
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded === candidate) break;
      candidate = decoded;
    } catch {
      return true;
    }
  }
  return false;
}

async function serveRequest(context: Context): Promise<Response> {
  if (targetsGuideContent(new URL(context.request.url).pathname)) {
    return serveGuideContent(context);
  }
  const response = await context.next();
  if (!response.headers.get("cache-control")?.includes("immutable")) return response;
  const contentType = response.headers.get("content-type") ?? "";
  const isHtml = /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType);
  if ((response.ok || response.status === 304) && !isHtml) return response;

  // The /assets/* header also matches missing files served through 404.html.
  const uncached = new Response(response.body, response);
  uncached.headers.set("cache-control", "private, no-store");
  uncached.headers.set("cdn-cache-control", "no-store");
  uncached.headers.set("cloudflare-cdn-cache-control", "no-store");
  return uncached;
}

export async function onRequest(context: Context): Promise<Response> {
  const response = await serveRequest(context);
  // Pages _headers does not apply to Function responses. Wrap every return
  // path, including guide admission failures and immutable asset responses.
  const protectedResponse = new Response(response.body, response);
  const policy = protectedResponse.headers.get("content-security-policy");
  // A separate enforcing policy intersects with any upstream policy. Appending
  // a duplicate directive in one policy would leave its first value in force.
  protectedResponse.headers.set("content-security-policy",
    policy ? `${policy}, frame-ancestors 'none'` : "frame-ancestors 'none'");
  protectedResponse.headers.set("x-frame-options", "DENY");
  return protectedResponse;
}

