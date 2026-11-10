import type { PairRenderRoute } from "./public-release-pair-render-plan";
import work from "../../functions/lib/public-release-pair-work.js";
export type PairRenderRequest = Readonly<{ schemaVersion: 1; read: unknown; homeSourcesFile: string | null;
  resources: readonly Readonly<{ url: string; file: string; contentType: string }>[] }>;
/** Reader payloads keep their established individual validators. This envelope
 * only names additional frozen provider/image inputs; it grants no network IO. */
function refuse(): never { throw new work.PairExecutionError("input-unavailable"); }
export function parsePublicReleasePairRenderRequest(value: unknown, route: PairRenderRoute): PairRenderRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse();
  const request = value as Record<string, unknown>;
  const named = new Set(route.dependencies.map(dependency => dependency.name));
  if (Object.keys(request).sort().join(",") !== "homeSourcesFile,read,resources,schemaVersion" || request.schemaVersion !== 1 ||
      !(request.homeSourcesFile === null || typeof request.homeSourcesFile === "string" && named.has(request.homeSourcesFile)) ||
      !Array.isArray(request.resources) || request.resources.length > 10_000) refuse();
  const seen = new Set<string>();
  const resources = request.resources.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
        Object.keys(raw).sort().join(",") !== "contentType,file,url" || typeof raw.url !== "string" || raw.url.length > 4096 ||
        typeof raw.file !== "string" || !named.has(raw.file) || seen.has(raw.url) ||
        typeof raw.contentType !== "string" || !/^[a-z]+\/[a-z0-9.+-]+$/.test(raw.contentType)) refuse();
    const url = new URL(raw.url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.href !== raw.url) refuse();
    seen.add(raw.url);
    return Object.freeze({ url: raw.url, file: raw.file, contentType: raw.contentType });
  });
  return Object.freeze({ schemaVersion: 1, read: request.read, homeSourcesFile: request.homeSourcesFile as string | null,
    resources: Object.freeze(resources) });
}
