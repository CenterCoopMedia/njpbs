import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  loadPublicContentStatus,
  publicContentKey,
  type PublicContentInventory,
  type PublicContentRoute,
} from "../lib/public-content-status";
import { cmsGetPublicationStatus, cmsRetryPublication, cmsRecheckPublication,
  type PublicationRecheckResult, type ContentPublicationMetadata, type SaveCollection } from "../lib/functions";

interface PublicStatus {
  state: "checking" | "current" | "unavailable";
  routes: PublicContentRoute[];
}

const PublicContentStatusContext = createContext<PublicStatus | null>(null);
const PublicContentStatusControlContext = createContext<{
  subscribe: () => () => void;
} | null>(null);
type MetadataResult = { data: ContentPublicationMetadata | null; unavailable: boolean;
  lastRecheck?: PublicationRecheckResult; lastRecheckSourceVersion?: number | null };
interface WatchedRecord { collection: SaveCollection; id: string; count: number; loading: boolean; poll: boolean }
const PublicationMetadataContext = createContext<{
  records: Record<string, MetadataResult>;
  watch: (collection: SaveCollection, id: string) => () => void;
  retry: (request: Parameters<typeof cmsRetryPublication>[1]) => Promise<void>;
  recheck: (queueId: string, collection: SaveCollection, id: string) => Promise<PublicationRecheckResult>;
} | null>(null);

function startInterval(callback: () => void, intervalMs = 5_000) {
  if (document.visibilityState === "hidden") return 0;
  return window.setInterval(callback, intervalMs);
}

export function PublicContentStatusProvider({ children, getIdToken }: {
  children: ReactNode;
  getIdToken?: () => Promise<string>;
}) {
  const [status, setStatus] = useState<PublicStatus>({ state: "checking", routes: [] });
  const [records, setRecords] = useState<Record<string, MetadataResult>>({});
  const [publicWatchers, setPublicWatchers] = useState(0);
  const watched = useRef(new Map<string, WatchedRecord>());
  const inventory = useRef<PublicContentInventory | null>(null);
  const subscribe = useCallback(() => {
    setPublicWatchers((count) => count + 1);
    return () => {
      setPublicWatchers((count) => Math.max(0, count - 1));
    };
  }, []);
  const control = useMemo(() => ({ subscribe }), [subscribe]);
  const readMetadata = useCallback(async (record: WatchedRecord) => {
    if (!getIdToken || record.loading || document.visibilityState === "hidden") return;
    const identity = `${record.collection}/${record.id}`;
    record.loading = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await cmsGetPublicationStatus(await getIdToken(), {
        collection: record.collection, id: record.id,
      }, controller.signal);
      if (!response.publication) throw new Error("Publication status is unavailable.");
      record.poll = response.publication.postProofPending === true ||
        response.publication.recordPublication?.status === "pending" ||
        ["reserved", "pending", "publishing", "unavailable"].includes(response.publication.queueStatus ?? "");
      if (watched.current.get(identity) === record) {
        setRecords((previous) => {
          const old = previous[identity], publication = response.publication;
          const operationId = publication.publicBuildQueueId ?? publication.recheckQueueId ??
            publication.postProofQueueId ?? publication.pageReceipt?.operationId;
          const retainOutcome = old?.lastRecheck && old.lastRecheckSourceVersion === publication.publishedSourceVersion &&
            (!operationId || operationId === old.lastRecheck.queueId);
          return { ...previous, [identity]: { data: publication, unavailable: false,
            ...(retainOutcome ? { lastRecheck: old.lastRecheck, lastRecheckSourceVersion: old.lastRecheckSourceVersion } : {}) } };
        });
      }
    } catch {
      record.poll = true;
      if (watched.current.get(identity) === record) {
        setRecords((previous) => ({ ...previous, [identity]: {
          ...previous[identity], data: previous[identity]?.data ?? null, unavailable: true,
        } }));
      }
    } finally {
      window.clearTimeout(timeout);
      record.loading = false;
    }
  }, [getIdToken]);
  const watch = useCallback((collection: SaveCollection, id: string) => {
    const identity = `${collection}/${id}`;
    let record = watched.current.get(identity);
    if (record) record.count += 1;
    else {
      record = { collection, id, count: 1, loading: false, poll: true };
      watched.current.set(identity, record);
    }
    void readMetadata(record);
    const entry = record;
    return () => {
      entry.count -= 1;
      if (!entry.count) {
        watched.current.delete(identity);
        setRecords((previous) => {
          const next = { ...previous };
          delete next[identity];
          return next;
        });
      }
    };
  }, [readMetadata]);
  useEffect(() => {
    const refresh = (pendingOnly = false) => {
      if (document.visibilityState === "hidden") return;
      for (const record of watched.current.values()) {
        if (!pendingOnly || record.poll) void readMetadata(record);
      }
    };
    let interval = startInterval(() => refresh(true));
    const onFocus = () => refresh();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        window.clearInterval(interval);
        interval = 0;
        return;
      }
      refresh();
      if (!interval) interval = startInterval(() => refresh(true));
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      watched.current.clear();
    };
  }, [readMetadata]);
  const retry = useCallback(async (request: Parameters<typeof cmsRetryPublication>[1]) => {
    if (!getIdToken) throw new Error("Sign in before retrying publication.");
    await cmsRetryPublication(await getIdToken(), request);
    const record = watched.current.get(`${request.collection}/${request.id}`);
    if (record) await readMetadata(record);
  }, [getIdToken, readMetadata]);
  const recheck = useCallback(async (queueId: string, collection: SaveCollection, id: string) => {
    if (!getIdToken) throw new Error("Sign in before checking publication.");
    const result = await cmsRecheckPublication(await getIdToken(), queueId);
    const identity = `${collection}/${id}`;
    if (watched.current.has(identity)) setRecords(previous => ({ ...previous,
      [identity]: { ...previous[identity], lastRecheck: result,
        lastRecheckSourceVersion: previous[identity]?.data?.publishedSourceVersion } }));
    const record = watched.current.get(identity);
    if (record) await readMetadata(record);
    return result;
  }, [getIdToken, readMetadata]);
  const metadata = useMemo(() => ({ records, watch, retry, recheck }), [records, watch, retry, recheck]);
  const watchingPublicReceipts = publicWatchers > 0;
  useEffect(() => {
    if (!watchingPublicReceipts) return;
    setStatus((previous) => (
      previous.state === "checking" ? previous : { ...previous, state: "checking" }
    ));
    let stopped = false;
    let active: AbortController | null = null;
    async function refresh() {
      if (active || document.visibilityState === "hidden") return;
      const controller = new AbortController();
      active = controller;
      let onAbort!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      const timeout = window.setTimeout(() => controller.abort(), 8_000);
      try {
        const previous = inventory.current;
        // Release the refresh slot on abort even if the network/body read has not settled.
        const result = await Promise.race([
          loadPublicContentStatus(controller.signal, previous ?? undefined), aborted,
        ]);
        if (!stopped) {
          inventory.current = result;
          setStatus((current) => ({ ...current, state: "current", routes: result.routes }));
          if (previous !== null && previous !== result) {
            for (const record of watched.current.values()) void readMetadata(record);
          }
        }
      } catch {
        if (!stopped) setStatus((previous) => ({ ...previous, state: "unavailable" }));
      } finally {
        window.clearTimeout(timeout);
        controller.signal.removeEventListener("abort", onAbort);
        controller.abort();
        active = null;
      }
    }
    let interval = startInterval(() => { void refresh(); }, 10_000);
    const onFocus = () => { void refresh(); };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        window.clearInterval(interval);
        interval = 0;
        active?.abort();
        return;
      }
      void refresh();
      if (!interval) interval = startInterval(() => { void refresh(); }, 10_000);
    };
    void refresh();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      active?.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [watchingPublicReceipts, readMetadata]);
  return <PublicContentStatusContext.Provider value={status}>
    <PublicContentStatusControlContext.Provider value={control}>
      <PublicationMetadataContext.Provider value={metadata}>{children}</PublicationMetadataContext.Provider>
    </PublicContentStatusControlContext.Provider>
  </PublicContentStatusContext.Provider>;
}

export function usePublicContentStatus(options?: { watch?: boolean }) {
  const status = useContext(PublicContentStatusContext);
  const control = useContext(PublicContentStatusControlContext);
  const watch = options?.watch !== false;
  useEffect(() => {
    if (!watch) return;
    return control?.subscribe();
  }, [control, watch]);
  return status;
}

export function usePublicContentRoute(collection?: SaveCollection, id?: string) {
  const status = usePublicContentStatus();
  const identity = collection && id ? `${collection}/${id}` : null;
  const [key, setKey] = useState<{ identity: string; value: string } | null>(null);
  useEffect(() => {
    if (!collection || !id || !identity) return;
    let stopped = false;
    void publicContentKey(collection, id).then((value) => {
      if (!stopped) setKey({ identity, value });
    }).catch(() => {
      if (!stopped) setKey(null);
    });
    return () => {
      stopped = true;
    };
  }, [collection, id, identity]);
  if (status?.state !== "current" || key?.identity !== identity) return undefined;
  return status.routes.find((route) => route.source === "cms" && route.contentKey === key.value);
}

export function usePublicationMetadata(collection?: SaveCollection, id?: string, revision?: number) {
  const context = useContext(PublicationMetadataContext);
  const watch = context?.watch;
  useEffect(() => {
    if (collection && id && watch) return watch(collection, id);
  }, [watch, collection, id, revision]);
  return collection && id ? context?.records[`${collection}/${id}`] : undefined;
}

export function usePublicationRetry() {
  return useContext(PublicationMetadataContext)?.retry;
}

export function usePublicationRecheck() {
  return useContext(PublicationMetadataContext)?.recheck;
}
