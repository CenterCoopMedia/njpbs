import { readHomeSourceSnapshot } from "../../../packages/content-core/src/home-published-sources";
export { readHomeSourceSnapshot } from "../../../packages/content-core/src/home-published-sources";
import type { HomeSourceSnapshot } from "../../../packages/content-core/src/home-rail-render";
import { fetchStaffSiteRead } from "./staff-site-read";

export function readHomeSourceResponse(value: unknown, publication: unknown, headers: Headers): HomeSourceSnapshot {
  const pageNames = ["X-Njpbs-Content-Source", "X-Njpbs-Publication-Operation", "X-Njpbs-Renderer-Sha", "X-Njpbs-Context-Sha256",
    "X-Njpbs-Snapshot-Sha256", "X-Njpbs-Source-Version", "X-Njpbs-Admission-Revision", "X-Njpbs-Home-Refresh-Revision"];
  if (headers.get(pageNames[0]) === "cms-page-no-build" || [pageNames[1], pageNames[4], pageNames[7]].some(name => headers.has(name))) {
    const code = publication as { schemaVersion?: unknown; commitSha?: unknown; generation?: unknown } | null;
    const source = value as { publication?: { buildBatchId?: unknown; generation?: unknown; commitSha?: unknown }; editorial?: unknown } | null;
    if (headers.get(pageNames[0]) !== "cms-page-no-build" || code?.schemaVersion !== 1 ||
        !Number.isSafeInteger(code.generation) || Number(code.generation) < 1 ||
        headers.get(pageNames[2]) !== code.commitSha || source?.publication?.commitSha !== code.commitSha ||
        !/^[A-Za-z0-9]{20}$/.test(headers.get(pageNames[1]) ?? "") || source?.publication?.buildBatchId !== headers.get(pageNames[1]) ||
        !Number.isSafeInteger(source.publication.generation) || Number(source.publication.generation) < Number(code.generation) ||
        ![pageNames[3], pageNames[4]].every(name => /^[a-f0-9]{64}$/.test(headers.get(name) ?? "")) ||
        ![pageNames[5], pageNames[6]].every(name => /^[1-9]\d*$/.test(headers.get(name) ?? "")) ||
        !/^(?:0|[1-9]\d*)$/.test(headers.get(pageNames[7]) ?? "") || !source.editorial) {
      throw new Error("The published Home catalog changed. Reload the cards before changing their selection.");
    }
    return readHomeSourceSnapshot(value, { schemaVersion: 1, ...source.publication });
  }
  const names = ["X-Njpbs-Background-State", "X-Njpbs-Background-Renderer-Sha", "X-Njpbs-Background-Context-Sha256", "X-Njpbs-Background-Revision"];
  if (names.every(name => headers.get(name) === null)) return readHomeSourceSnapshot(value, publication);
  const code = publication as { schemaVersion?: unknown; commitSha?: unknown } | null;
  const source = value as { publication?: { buildBatchId?: unknown; generation?: unknown; commitSha?: unknown }; editorial?: unknown } | null;
  if (headers.get(names[0]) !== "current" || code?.schemaVersion !== 1 ||
      headers.get(names[1]) !== code.commitSha || source?.publication?.commitSha !== code.commitSha ||
      !/^[a-f0-9]{64}$/.test(headers.get(names[2]) ?? "") || !/^[1-9]\d*$/.test(headers.get(names[3]) ?? "") || !source?.editorial) {
    throw new Error("The published Home catalog changed. Reload the cards before changing their selection.");
  }
  return readHomeSourceSnapshot(value, { schemaVersion: 1, ...source.publication });
}

export function homeSourceOrigin(env: { DEV?: boolean; VITE_FIREBASE_PROJECT_ID?: string; VITE_PUBLIC_SITE_ORIGIN?: string }): string {
  const development = env.DEV === true || env.VITE_FIREBASE_PROJECT_ID === "njpbs-site-dev";
  if (!development && env.VITE_FIREBASE_PROJECT_ID !== "njpbs-site") {
    throw new Error("The Home source Firebase project is not recognized.");
  }
  const configured = env.VITE_PUBLIC_SITE_ORIGIN?.trim();
  if (!configured && development) throw new Error("The development public site origin is not configured.");
  const origin = configured || "https://njpbs.org";
  const expected = development ? "https://dev-public.example.org" : "https://njpbs.org";
  if (origin !== expected) throw new Error("The Home source origin does not match this workspace.");
  return origin;
}

export async function loadHomeSourceSnapshot(
  signal: AbortSignal,
): Promise<HomeSourceSnapshot> {
  const origin = homeSourceOrigin({
    DEV: import.meta.env.DEV,
    VITE_FIREBASE_PROJECT_ID: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    VITE_PUBLIC_SITE_ORIGIN: import.meta.env.VITE_PUBLIC_SITE_ORIGIN,
  });
  const nonce = Date.now().toString(36);
  const read = async (path: string) => {
    const response = await fetchStaffSiteRead(
      `${origin}/${path}?cms-home=${nonce}&cms-context=${path === "_publication.json" ? "code" : "home"}`,
      { signal, credentials: "omit", cache: "no-store" },
    );
    if (!response.ok)
      throw new Error(
        "The published Home cards could not be loaded. Your page edits are still available.",
      );
    const bytes = await response.text();
    if (bytes.length > 500_000)
      throw new Error("The Home source response is too large.");
    return { value: JSON.parse(bytes) as unknown, headers: response.headers };
  };
  const [sources, publication] = await Promise.all([
    read("_home-sources.json"),
    read("_publication.json"),
  ]);
  return readHomeSourceResponse(sources.value, publication.value, sources.headers);
}
