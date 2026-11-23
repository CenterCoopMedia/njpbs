import {
  DONATE_ALTERNATE_LABEL,
  resolveDonateCta,
  type DonatePortalSignal,
} from "../../site/src/lib/donate-degradation";
import { donateUrl } from "../../packages/content-core/src/launch-fallback";
import { bytesDigest } from "../../packages/content-core/src/public-release-routing";

const CONTACT_PATH = "/contact/";
const DONATION_STATION = new URL(donateUrl).searchParams.get("station_id");
const NOTICE_ID = "njpbs-donation-form-notice";
const DONATE_LABEL = /^(\s*)(?:Donate(?: through PBS)?|PBS donation (?:form|portal))(\s*)$/i;
const SUCCESS_MS = 15_000;
const FAILURE_MS = 5_000;
const MAX_OBSERVATION_AGE_MS = 30_000;
const DOCUMENT_VALIDATORS = ["if-none-match", "if-modified-since", "range", "if-range"];
const HTML_DIGEST = "x-njpbs-html-sha256";
type HealthContext = Pick<ExecutionContext, "waitUntil">;
type ReadDonationHealth = (ctx: HealthContext) => DonatePortalSignal | null;

function donationDocumentRequest(request: Request): Request {
  if (!DOCUMENT_VALIDATORS.some(name => request.headers.has(name))) return request;
  // A retained asset's 304 would let the browser keep the old donation state.
  const documentRequest = new Request(request);
  for (const name of DOCUMENT_VALIDATORS) documentRequest.headers.delete(name);
  return documentRequest;
}

export function createDonationHealthReader(projectId: string): ReadDonationHealth {
  const endpoint = `https://us-central1-${projectId}.cloudfunctions.net/donationHealth`;
  let cached: { signal: DonatePortalSignal | null; observedAt: number } | undefined;
  let pending: Promise<void> | undefined;

  async function refresh(): Promise<void> {
    let signal: DonatePortalSignal | null = null;
    try {
      const response = await fetch(endpoint, {
        headers: { Accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(2_000),
      });
      const status = response.ok ? (await response.json() as { status?: unknown })?.status : undefined;
      if (status === "reachable") signal = { kind: "reachable" };
      if (status === "timeout" || status === "forbidden" || status === "rateLimited" || status === "error") {
        signal = { kind: "outage", status };
      }
    } catch {
      // An unavailable health service supplies no observation of the PBS form.
    }
    cached = { signal, observedAt: Date.now() };
  }

  return ctx => {
    const age = cached ? Date.now() - cached.observedAt : Infinity;
    const ttl = cached?.signal?.kind === "reachable" ? SUCCESS_MS : FAILURE_MS;
    if (age >= ttl && !pending) {
      pending = refresh().finally(() => { pending = undefined; });
      ctx.waitUntil(pending);
    }
    // Refresh in the request that owns the fetch. Other requests use only its
    // completed observation, so a cold Functions instance never holds page HTML.
    return age < MAX_OBSERVATION_AGE_MS ? cached?.signal ?? null : null;
  };
}

function isDonationForm(href: string | null): boolean {
  if (!href) return false;
  try {
    const url = new URL(href, "https://njpbs.org");
    const station = url.searchParams.get("station_id");
    return ["pbs.org", "www.pbs.org"].includes(url.hostname) &&
      ["http:", "https:"].includes(url.protocol) && /^\/donation\/?$/i.test(url.pathname) &&
      (!station || station === DONATION_STATION);
  } catch {
    return false;
  }
}

export async function serveDonationDocument(
  request: Request,
  serve: (request: Request) => Promise<Response>,
  readHealth: ReadDonationHealth,
  ctx: HealthContext,
): Promise<Response> {
  if (request.method !== "GET" || !/(?:\/|\.html)$/.test(new URL(request.url).pathname)) return serve(request);
  const signal = readHealth(ctx);
  if (signal?.kind !== "outage") return serve(request);
  const response = await serve(donationDocumentRequest(request));
  return applyDonationFallback(response, signal);
}

async function applyDonationFallback(response: Response, signal: DonatePortalSignal): Promise<Response> {
  const render = resolveDonateCta(signal).render;
  if (render.mode !== "unavailable" || !response.body ||
      !response.headers.get("content-type")?.startsWith("text/html")) return response;

  // Rewrite the final document so generated and stored links share the same
  // policy, including Markdown, service pages and other CMS block output.
  let fallbackLink = false;
  let donationFound = false;
  let noticeShown = false;
  function noticeHtml(): string {
    if (!donationFound || noticeShown) return "";
    noticeShown = true;
    const copy = render.notice.replace(DONATE_ALTERNATE_LABEL, `<a href="${CONTACT_PATH}">${DONATE_ALTERNATE_LABEL}</a>`);
    return `<aside class="wrap" aria-label="Online donations"><p id="${NOTICE_ID}">${copy}</p></aside>`;
  }

  const result = new HTMLRewriter()
    .on("a[href]", {
      element(link) {
        fallbackLink = false;
        if (!isDonationForm(link.getAttribute("href"))) return;
        fallbackLink = true;
        donationFound = true;
        link.setAttribute("href", CONTACT_PATH);
        link.removeAttribute("ping");
        link.removeAttribute("download");
        link.removeAttribute("attributionsrc");
        const description = link.getAttribute("aria-describedby");
        link.setAttribute("aria-describedby", description ? `${description} ${NOTICE_ID}` : NOTICE_ID);
        const label = link.getAttribute("aria-label");
        if (label && DONATE_LABEL.test(label)) link.setAttribute("aria-label", "Giving help");
      },
      text(chunk) {
        // Relabel the site's conventional CTAs while preserving their icons,
        // rich-text formatting, images and the existing new-tab announcement.
        if (fallbackLink && DONATE_LABEL.test(chunk.text)) {
          chunk.replace(chunk.text.replace(DONATE_LABEL, "$1Giving help$2"));
        }
      },
    })
    .on("main#main", {
      element(main) { main.before(noticeHtml(), { html: true }); },
    })
    .on("body", {
      element(body) { body.onEndTag(end => { end.before(noticeHtml(), { html: true }); }); },
    })
    .transform(response);

  // The original validators identify retained HTML, not its current CTA state.
  const headers = new Headers(result.headers);
  if (!/\b(?:no-cache|no-store)\b/i.test(headers.get("cache-control") ?? "")) {
    headers.set("cache-control", "private, no-cache");
  }
  for (const name of ["etag", "last-modified", "content-length"]) headers.delete(name);
  let body: BodyInit | null = result.body;
  if (headers.has(HTML_DIGEST)) {
    const bytes = new Uint8Array(await result.arrayBuffer());
    headers.set(HTML_DIGEST, await bytesDigest(bytes));
    headers.delete("content-encoding");
    body = bytes;
  }
  return new Response(body, { status: result.status, statusText: result.statusText, headers });
}
