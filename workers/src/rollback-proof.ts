export const versionOverride = "cloudflare-workers-version-overrides";
export const rollbackProbe = "x-njpbs-rollback-probe";
export const workerVersion = "x-njpbs-worker-version";
export const rollbackCacheControl = "no-cache, no-store";

export function rollbackRead(url: URL, method: string): "code" | "schedule" | "edge" | null {
  if (method === "HEAD" && url.pathname === "/_publication.json" && url.search === "?cms-context=code") return "code";
  if (url.search) return null;
  if (method === "GET" && ["/_schedule-sources.json", "/schedule/downloads/nj-pbs-schedule.pdf"].includes(url.pathname)) return "schedule";
  if (method === "HEAD" && ["/", "/schedule/"].includes(url.pathname)) return "edge";
  return null;
}

export function overrideVersion(value: string, worker: string): string | undefined {
  const member = /^([a-z][a-z0-9-]*)="([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})"$/.exec(value);
  return member?.[1] === worker ? member[2] : undefined;
}

export function versionedProof(response: Response, version: string | undefined): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  if (version) headers.set(workerVersion, version);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
