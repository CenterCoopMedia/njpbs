import type { NoBuildPageReply } from "../../cms-api/src/index";
import { SECURITY_HEADER_BASELINE } from "../../packages/content-core/src/public-security-headers";

const heading = "This profile is being published.";
const description = "Check back in a few minutes.";
const body = `<section class="page-hero" aria-labelledby="profile-pending-title"><div class="wrap page-hero__inner"><p class="page-hero__kicker">Staff</p><h1 id="profile-pending-title">${heading}</h1><p class="page-hero__lead">${description}</p></div></section>`;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Only a missing author route needs another read. The public Staff projection
 * supplies the published slug set; working and withdrawn profiles cannot join it. */
export async function pendingAuthorResponse(request: Request, response: Response, deps: {
  rendererSha: string;
  readStaff(path: string): Promise<NoBuildPageReply>;
  fetchAsset(request: Request): Promise<Response>;
}): Promise<Response> {
  const url = new URL(request.url);
  const slug = /^\/authors\/([a-z0-9]+(?:-[a-z0-9]+)*)\/$/.exec(url.pathname)?.[1];
  if (response.status !== 404 || !["GET", "HEAD"].includes(request.method) || !slug) return response;
  try {
    let staff = await deps.readStaff("/staff/");
    if (["alias", "redirect"].includes(staff.kind) && staff.location &&
        /^\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(staff.location) && staff.location !== "/staff/") {
      staff = await deps.readStaff(staff.location);
    }
    const input = staff.kind === "page" && staff.receipt?.pageId === "staff" && staff.receipt.visible &&
        staff.receipt.rendererSha === deps.rendererSha ? staff.published
      : staff.kind === "context-page" && staff.contextReceipt?.rendererSha === deps.rendererSha &&
        object(staff.renderContext) && staff.renderContext.pageId === "staff" ? staff.renderContext : null;
    if (!object(input) || !Array.isArray(input.authors) ||
        !input.authors.some(author => object(author) && author.slug === slug)) return response;

    // Keep the deployed site's header, footer and assets. A background miss has
    // no HTML, so use the same public 404 shell that Assets would have served.
    const shell = response.headers.get("content-type")?.startsWith("text/html") && response.body
      ? response.clone() : await deps.fetchAsset(new Request(`${url.origin}/404/`));
    if (![200, 404].includes(shell.status) || !shell.headers.get("content-type")?.startsWith("text/html")) {
      await shell.body?.cancel(); return response;
    }
    let main = false;
    const html = await new HTMLRewriter()
      .on("main#main", { element(element) { main = true; element.removeAttribute("data-pagefind-body"); element.setInnerContent(body, { html: true }); } })
      .on("title", { element(element) { element.setInnerContent(`${heading} — NJ PBS`); } })
      .on('meta[name="description"], meta[property="og:description"], meta[name="twitter:description"]', {
        element(element) { element.setAttribute("content", description); },
      })
      .on('meta[property="og:title"], meta[name="twitter:title"]', { element(element) { element.setAttribute("content", heading); } })
      .on('meta[name="robots"]', { element(element) { element.setAttribute("content", "noindex, nofollow"); } })
      .on('link[rel="canonical"]', { element(element) { element.setAttribute("href", `${url.origin}${url.pathname}`); } })
      .on('meta[property="og:url"]', { element(element) { element.setAttribute("content", `${url.origin}${url.pathname}`); } })
      .on('script[type="application/ld+json"]', { element(element) { element.remove(); } })
      .transform(shell).text();
    if (!main || new TextEncoder().encode(html).length > 4 * 1024 * 1024) return response;
    await response.body?.cancel();
    return new Response(request.method === "HEAD" ? null : html, { status: 503, headers: {
      ...SECURITY_HEADER_BASELINE, "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store", "retry-after": "120", "x-robots-tag": "noindex, nofollow",
    } });
  } catch { return response; }
}
