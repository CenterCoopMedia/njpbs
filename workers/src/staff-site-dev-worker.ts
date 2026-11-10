import { serveDevStaffSite } from "./staff-site-worker";

const siteOrigin = "https://dev-public.example.org";

async function fetchDevPublic(request: Request, env: DevStaffSiteBindings): Promise<Response> {
  // The Admin handoff can resume an Access callback URL. Consume it after
  // admission without copying its one-time query credentials to the origin.
  if (new URL(request.url).pathname === "/cdn-cgi/access/authorized") {
    return new Response(null, { status: 302, headers: { location: `${siteOrigin}/` } });
  }
  // The service binding reaches only the private dev Worker. Keep the dev URL
  // so asset redirects stay on the admitted host, without any origin identity.
  const url = new URL(request.url);
  const upstream = await env.DEV_PUBLIC.fetch(new Request(request, {
    redirect: "manual", signal: AbortSignal.timeout(30_000),
  }));
  if (upstream.status === 401 || upstream.status === 403) {
    await upstream.body?.cancel();
    throw new Error("Dev origin refused");
  }
  if (upstream.status >= 300 && upstream.status < 400 && upstream.status !== 304) {
    const location = upstream.headers.get("location");
    const target = location ? new URL(location, url) : null;
    await upstream.body?.cancel();
    if (!target || target.username || target.password ||
        target.origin !== siteOrigin) {
      throw new Error("Dev origin redirect refused");
    }
    const redirectedHeaders = new Headers(upstream.headers);
    redirectedHeaders.set("location", target.href);
    redirectedHeaders.delete("content-length");
    redirectedHeaders.delete("content-encoding");
    return new Response(null, { status: upstream.status, headers: redirectedHeaders });
  }
  return upstream;
}

// This deployment has no production bindings or production admission mode.
export default {
  fetch(request: Request, env: DevStaffSiteBindings) {
    return serveDevStaffSite(request, env, cleanRequest => fetchDevPublic(cleanRequest, env));
  },
} satisfies ExportedHandler<DevStaffSiteBindings>;
