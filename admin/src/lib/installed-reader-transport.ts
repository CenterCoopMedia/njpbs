import { createVersionedReaderClient } from "./versioned-reader-client";

const endpoints = new Set(["cmsGetPublicPage", "cmsGetPublishedSettings", "cmsPreview", "cmsPreviewStatus", "cmsReadPairCurrentCodeV2"]);
export const isInstalledReaderEndpoint = (endpoint: string) => endpoints.has(endpoint);
const hex = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
interface Manifest {
  schemaVersion: 2;
  version: 1 | 2;
  functionsReader: string;
  cmsApiReader: string;
}
interface ReaderResponse {
  response: Response;
  token: string;
}
interface ReaderState {
  ids: { functions: string; cmsApi: string };
  opened: boolean;
  key: string;
  expiresAt: number | null;
  opening?: Promise<ReaderResponse | null>;
}
const refuse = () => { throw new Error("Installed CMS reader configuration unavailable"); };
const SESSION_ENDED = "This Boardwalk reader session has ended. Reload Boardwalk to start a new session.";
// Stored and held expiry after the server confirms it. Any clock reads this as
// past, so a browser clock behind the server cannot retain the ended UUIDs.
const CONFIRMED_ENDED = 0;
function waitForReaderOpen<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(value => {
      signal.removeEventListener("abort", abort); resolve(value);
    }, error => {
      signal.removeEventListener("abort", abort); reject(error);
    });
  });
}

/** Installation supplies the manifest after both deployed readers are proven.
 * Session storage retains original UUIDs through active/uncertain retries.
 * Only a new page after CONFIRMED expiry may ask for a new lease: a known
 * expiry, or the server's typed reply for these exact UUIDs. A closed server
 * reader window still refuses it; a loaded tab never renews itself.
 */
export function createInstalledReaderTransport({ enabled, manifest: raw, origin, storage, randomUUID = () => crypto.randomUUID(), request = fetch, now = Date.now }: {
  enabled?: string;
  manifest?: string;
  origin: string;
  storage: Pick<Storage, "getItem" | "setItem">;
  randomUUID?: () => string;
  request?: typeof fetch;
  now?: () => number;
}) {
  if (enabled !== "true") return null;
  let manifest: Manifest;
  try { manifest = JSON.parse(raw ?? ""); } catch { return refuse(); }
  if (!manifest || Object.keys(manifest).sort().join(",") !== "cmsApiReader,functionsReader,schemaVersion,version" ||
      manifest.schemaVersion !== 2 || ![1, 2].includes(manifest.version) ||
      !hex.test(manifest.functionsReader) || !hex.test(manifest.cmsApiReader)) refuse();
  const states = new Map<string, ReaderState>();
  // Anything but a typed reply naming this tab's own leases stays uncertain.
  async function confirmsExpiry(response: Response, ids: ReaderState["ids"]) {
    if (response.status !== 410) return false;
    const value = await response.clone().json().catch(() => null) as {
      schemaVersion?: number; version?: number; code?: string; identities?: Record<string, string>;
      expired?: { sessionId?: string; readerDigest?: string; issuedAt?: number; expiresAt?: number }[];
    } | null;
    const readers = { functions: manifest.functionsReader, cmsApi: manifest.cmsApiReader };
    return value?.schemaVersion === 2 && value.version === manifest.version && value.code === "cms-reader-session-expired" &&
      value.identities?.functions === readers.functions && value.identities?.cmsApi === readers.cmsApi &&
      Array.isArray(value.expired) && value.expired.length > 0 && value.expired.every(lease =>
        (["functions", "cmsApi"] as const).some(component => lease?.sessionId === ids[component] && lease.readerDigest === readers[component]) &&
        Number.isSafeInteger(lease.issuedAt) && Number.isSafeInteger(lease.expiresAt) && lease.expiresAt! > lease.issuedAt!);
  }
  function stateFor(principalId: string) {
    if (!principalId || principalId.length > 128) refuse();
    const existing = states.get(principalId);
    if (existing) return existing;
    const key = `cms-reader:${manifest.functionsReader}:${manifest.cmsApiReader}:${manifest.version}:${principalId}`;
    const saved = storage.getItem(key);
    let record: { ids: { functions: string; cmsApi: string }; expiresAt: number | null } | null = null;
    if (saved !== null) {
      try { record = JSON.parse(saved); } catch { return refuse(); }
      if (!record || Object.keys(record).sort().join(",") !== "expiresAt,ids" ||
          record.expiresAt !== null && !Number.isSafeInteger(record.expiresAt)) refuse();
    }
    // This runs only for the first call from a newly loaded page. Keep IDs
    // while expiry is unknown: a lost open may already have issued its lease.
    if (!record || record.expiresAt !== null && now() >= record.expiresAt) {
      record = { ids: { functions: randomUUID(), cmsApi: randomUUID() }, expiresAt: null };
      storage.setItem(key, JSON.stringify(record));
    }
    const ids = record.ids;
    if (!ids || Object.keys(ids).sort().join(",") !== "cmsApi,functions" ||
        !uuid.test(ids.functions) || !uuid.test(ids.cmsApi) || ids.functions === ids.cmsApi) refuse();
    const state: ReaderState = { ids, opened: false, key, expiresAt: record.expiresAt };
    states.set(principalId, state);
    return state;
  }
  return {
    supports: (endpoint: string) => endpoints.has(endpoint),
    async send({ endpoint, body, principalId, token, appCheckToken, signal }: {
      endpoint: string; body: unknown; principalId: string; token: string;
      appCheckToken?: string | null; signal?: AbortSignal;
    }): Promise<ReaderResponse> {
      if (!endpoints.has(endpoint)) refuse();
      signal?.throwIfAborted();
      const state = stateFor(principalId);
      if (state.expiresAt !== null && now() >= state.expiresAt) {
        throw new Error(SESSION_ENDED);
      }
      const client = createVersionedReaderClient({ origin, version: manifest.version, sessionIds: state.ids,
        readToken: async () => token, request,
        ...(appCheckToken ? { readAppCheckToken: async () => appCheckToken } : {}) });
      if (!state.opened) {
        // Share an in-flight open, never issue concurrent leases for one tab.
        // A failed call has no hidden retry. The next explicit call retains IDs.
        state.opening ??= (async () => {
          try {
            // The open belongs to the retained tab state, not to one waiter.
            const opened = await client.open();
            if (await confirmsExpiry(opened, state.ids)) {
              // This page sends nothing more. Only the next explicit reload rotates.
              state.expiresAt = CONFIRMED_ENDED;
              storage.setItem(state.key, JSON.stringify({ ids: state.ids, expiresAt: CONFIRMED_ENDED }));
              throw new Error(SESSION_ENDED);
            }
            // Every waiter must attribute a shared refusal to the token sent
            // by the opener, even after refresh, sign-in or waiter cancellation.
            if (!opened.ok) return { response: opened, token };
            const value = await opened.json() as {
              schemaVersion?: number; version?: number; identities?: Record<string, string>;
              leases?: Record<string, { sessionId?: string; readerDigest?: string; issuedAt?: number; expiresAt?: number }>;
            };
            if (value.schemaVersion !== 2 || value.version !== manifest.version ||
                value.identities?.functions !== manifest.functionsReader || value.identities?.cmsApi !== manifest.cmsApiReader ||
                (["functions", "cmsApi"] as const).some(component => {
                  const lease = value.leases?.[component];
                  return lease?.sessionId !== state.ids[component] || lease.readerDigest !== value.identities?.[component] ||
                    !Number.isSafeInteger(lease.issuedAt) || !Number.isSafeInteger(lease.expiresAt) ||
                    lease.expiresAt! - lease.issuedAt! !== 24 * 60 * 60_000;
                })) refuse();
            state.expiresAt = Math.min(value.leases!.functions.expiresAt!, value.leases!.cmsApi.expiresAt!);
            storage.setItem(state.key, JSON.stringify({ ids: state.ids, expiresAt: state.expiresAt }));
            state.opened = true;
            return null;
          } finally { state.opening = undefined; }
        })();
        const refusal = await waitForReaderOpen(state.opening, signal);
        if (refusal) return { response: refusal.response.clone(), token: refusal.token };
      }
      return { response: await client.request(endpoint, body, signal), token };
    },
  };
}
