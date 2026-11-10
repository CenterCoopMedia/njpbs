import { serveDevStaffSite, type DevStaffSiteEnv } from "./staff-site-worker";

interface DevPreviewStaffBindings extends DevStaffSiteEnv {
  DEV_PREVIEW: Fetcher;
}

const previewOrigin = "https://dev-preview.example.org";

async function fetchPreview(request: Request, env: DevPreviewStaffBindings): Promise<Response> {
  if (new URL(request.url).pathname === "/cdn-cgi/access/authorized") {
    return new Response(null, { status: 302, headers: { location: `${previewOrigin}/` } });
  }
  const upstream = await env.DEV_PREVIEW.fetch(new Request(request, {
    redirect: "manual", signal: AbortSignal.timeout(30_000),
  }));
  // The private artifact gateway has no login or redirect surface. Never relay
  // a provider challenge, origin credential or foreign navigation to the editor.
  if ((upstream.status >= 300 && upstream.status < 400 && upstream.status !== 304) ||
      upstream.status === 401 || upstream.status === 403) {
    await upstream.body?.cancel();
    throw new Error("Private dev preview origin refused");
  }
  return upstream;
}

export default {
  fetch(request: Request, env: DevPreviewStaffBindings) {
    return serveDevStaffSite(request, env, clean => fetchPreview(clean, env), previewOrigin);
  },
} satisfies ExportedHandler<DevPreviewStaffBindings>;
