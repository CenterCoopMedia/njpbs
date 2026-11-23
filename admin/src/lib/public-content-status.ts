import { fetchStaffSiteRead } from "./staff-site-read";
import { publicSiteOrigin } from "./dev-origins";

export interface PublicContentRoute {
  path: string;
  source: "site" | "cms";
  contentKey?: string;
  sourceVersion?: number;
}

export interface PublicContentInventory {
  identity: PublicContentIdentity;
  routes: PublicContentRoute[];
}

export interface PublicContentIdentity {
  buildBatchId: string;
  generation: number;
  commitSha: string;
}

const safePath = /^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)*$/;
const digest = /^[a-f0-9]{64}$/;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readPublicContentIdentity(value: unknown): PublicContentIdentity {
  if (!object(value) || value.schemaVersion !== 1 ||
      typeof value.buildBatchId !== "string" || !value.buildBatchId ||
      !Number.isSafeInteger(value.generation) || Number(value.generation) < 1 ||
      typeof value.commitSha !== "string" || !/^[a-f0-9]{40}$/.test(value.commitSha)) {
    throw new Error("Public version receipt is invalid.");
  }
  return {
    buildBatchId: value.buildBatchId,
    generation: Number(value.generation),
    commitSha: value.commitSha,
  };
}

function sameIdentity(left: PublicContentIdentity, right: PublicContentIdentity): boolean {
  return left.buildBatchId === right.buildBatchId &&
    left.generation === right.generation &&
    left.commitSha === right.commitSha;
}

// A cache or deployment can return files from different builds. Never call that
// mixture live, or treat a malformed/absent inventory as an empty public site.
export function readPublicContentStatus(
  status: unknown,
  publication: unknown,
): PublicContentRoute[] {
  const statusIdentity = readPublicContentIdentity(status);
  const publicationIdentity = readPublicContentIdentity(publication);
  if (!object(status) ||
      JSON.stringify(status.collections) !== JSON.stringify(["cmsPages", "cmsPosts"]) ||
      !sameIdentity(statusIdentity, publicationIdentity) ||
      !Array.isArray(status.routes) || status.routes.length > 10_000) {
    throw new Error("Public version receipts do not match.");
  }
  const paths = new Set<string>();
  const contentKeys = new Set<string>();
  return status.routes.map((route: unknown) => {
    if (!object(route) || typeof route.path !== "string" || !safePath.test(route.path) || paths.has(route.path)) {
      throw new Error("Public route receipt is invalid.");
    }
    paths.add(route.path);
    if (route.source === "site" && route.sourceVersion === undefined && route.contentKey === undefined) {
      return { path: route.path, source: "site" };
    }
    if (route.source !== "cms" || typeof route.contentKey !== "string" || !digest.test(route.contentKey) ||
        contentKeys.has(route.contentKey) || !Number.isSafeInteger(route.sourceVersion) || Number(route.sourceVersion) < 1) {
      throw new Error("Public CMS version receipt is invalid.");
    }
    contentKeys.add(route.contentKey);
    return { path: route.path, source: "cms", contentKey: route.contentKey, sourceVersion: Number(route.sourceVersion) };
  });
}

export async function publicContentKey(collection: string, documentId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${collection}/${documentId}`);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type PublicPageStatus = { state: "live"; route: PublicContentRoute } | { state: "gone" };
export const PUBLIC_PAGE_STATUS_TIMEOUT_MS = 15_000;
const pagePathPattern = /^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?$/;

export async function loadPublicPageStatus(
  path: string,
  pageId: string,
  signal: AbortSignal,
): Promise<PublicPageStatus | undefined> {
  if (!pagePathPattern.test(path)) return;
  try {
    const key = await publicContentKey("cmsPages", pageId);
    async function probe(address: string) {
      const url = `${publicSiteOrigin}${address}?cms-page-status=1`;
      const response = await fetchStaffSiteRead(url, {
        ...requestOptions(signal), method: "HEAD", redirect: "error",
      });
      const receipt = /^([a-f0-9]{64}):(site|[1-9]\d*)$/.exec(response.headers.get("x-njpbs-page-status") ?? "");
      if (signal.aborted || response.url !== url || response.headers.get("x-njpbs-page-path") !== address ||
          receipt?.[1] !== key) return;
      return { status: response.status, version: receipt[2], alias: response.headers.get("x-njpbs-page-redirect") };
    }
    let result = await probe(path);
    if (result?.alias) {
      if (result.status !== 200 || result.alias === path || !pagePathPattern.test(result.alias)) return;
      path = result.alias;
      result = await probe(path);
    }
    if (!result || result.alias !== null) return;
    const { status, version } = result;
    if (version === "site") {
      if (status === 200) return { state: "live", route: { path, source: "site" } };
      return;
    }
    const sourceVersion = Number(version);
    if (!Number.isSafeInteger(sourceVersion)) return;
    if (status === 410) return { state: "gone" };
    if (status === 200) return {
      state: "live", route: { path, source: "cms", contentKey: key, sourceVersion },
    };
  } catch {
    // Retained content and unavailable reads cannot confirm current authority.
    return;
  }
}

function requestOptions(signal: AbortSignal): RequestInit {
  return { signal, credentials: "omit", cache: "no-store" };
}

async function readPublicJson(path: string, nonce: string, signal: AbortSignal) {
  const response = await fetchStaffSiteRead(
    `${publicSiteOrigin}/${path}?cms-status=${nonce}`,
    requestOptions(signal),
  );
  if (!response.ok) throw new Error("Public status is unavailable.");
  const bytes = await response.text();
  if (bytes.length > 2_000_000) throw new Error("Public status is too large.");
  return JSON.parse(bytes) as unknown;
}

export async function loadPublicContentStatus(
  signal: AbortSignal,
  previous?: PublicContentInventory,
): Promise<PublicContentInventory> {
  const nonce = Date.now().toString(36);
  const [publication, status] = await Promise.all([
    readPublicJson("_publication.json", nonce, signal),
    readPublicJson("_content-status.json", nonce, signal),
  ]);
  const identity = readPublicContentIdentity(publication);
  const routes = readPublicContentStatus(status, publication);
  // A pair can publish a new route inventory under the same release identity.
  if (previous && sameIdentity(previous.identity, identity) &&
      JSON.stringify(previous.routes) === JSON.stringify(routes)) return previous;
  return { identity, routes };
}
