import { hubElectricityEmbed, readHubElectricity } from "./data-hub-electricity.ts";
import { SECURITY_HEADER_BASELINE } from "./public-security-headers";

const basePath = /^\/data\/figures\/([a-z0-9-]+)\/embed\/?$/;
const savedPath = /^\/data\/figures\/[a-z0-9-]+\/embed\/(?:number|\d{4}-\d{2}-\d{2}\/(?:chart|number))\/$/;
const embedFamily = /^\/data\/figures\/[^/]+\/embed(?:\/|$)/;

/** Only the script-free public figure documents allow third-party framing.
 * The latest electricity embed shows the record in the Hub page being served. */
export function serveDataHubEmbed(request: Request, fetchAsset: (request: Request) => Promise<Response>,
  hubPage: () => Promise<Response | null> = () => fetchAsset(new Request(new URL("/data-hub/", request.url)))): Response | Promise<Response> | null {
  const url = new URL(request.url);
  const base = basePath.exec(url.pathname);
  if (!embedFamily.test(url.pathname)) return null;
  const headers = new Headers(SECURITY_HEADER_BASELINE);
  headers.delete("x-frame-options");
  headers.delete("content-security-policy-report-only");
  headers.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; font-src https://njpbs.org; img-src 'self' data:; frame-ancestors *; base-uri 'none'; form-action 'none'; object-src 'none'");
  headers.set("referrer-policy", "no-referrer");
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-cache");
  const missing = () => new Response(request.method === "HEAD" ? null : "<!doctype html><html lang=\"en\"><title>Figure not found - NJ PBS</title><h1>Figure not found</h1><p><a href=\"https://njpbs.org/data-hub/\">Visit the NJ PBS Data Hub</a></p></html>", { status: 404, headers });
  if (!base && !savedPath.test(url.pathname)) return missing();
  if (!["GET", "HEAD"].includes(request.method)) {
    headers.set("allow", "GET, HEAD");
    return new Response(null, { status: 405, headers });
  }
  let latest: "chart" | "number" | undefined = url.pathname === "/data/figures/electricity/embed/number/" ? "number" : undefined;
  if (base) {
    const view = url.searchParams.get("view") ?? "chart";
    const revision = url.searchParams.get("revision");
    if (!["chart", "number"].includes(view) || revision !== null && !/^\d{4}-\d{2}-\d{2}$/.test(revision)) return missing();
    if (base[1] === "electricity" && revision === null) latest = view as "chart" | "number";
    url.pathname = `/data/figures/${base[1]}/embed/` + (revision ? `${revision}/${view}/` : view === "number" ? "number/" : "");
  }
  url.search = "";
  // Avoid a cached site-shell 304 or partial response carrying a different body.
  return (async () => {
    const asset = await fetchAsset(new Request(url, { method: "GET" }));
    if (asset.status !== 200 || !asset.headers.get("content-type")?.startsWith("text/html")) return missing();
    // The Hub worker already tries its retained copies. A page it will not serve has no current price to show.
    const hub = latest ? await hubPage().catch(() => null) : undefined;
    if (hub && (hub.status === 404 || hub.status === 410)) return missing();
    if (hub !== undefined && hub?.status !== 200) {
      headers.set("cache-control", "no-store");
      return new Response(request.method === "HEAD" ? null : "Figure unavailable", { status: 503, headers });
    }
    if (request.method === "HEAD") return new Response(null, { headers });
    const metric = hub ? readHubElectricity(await hub.text()) : null;
    return new Response(metric ? hubElectricityEmbed(await asset.text(), metric, latest!) : asset.body, { headers });
  })();
}
