import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useOptionalShell } from "../routes/ShellContext";
import { parseBioCatalog, type BioCatalog } from "../lib/bio-catalog";

export type BioCatalogLoader = (signal: AbortSignal) => Promise<BioCatalog>;
interface BioCatalogState { catalog: BioCatalog | null; busy: boolean; error: string; load: () => void }
const BioCatalogContext = createContext<BioCatalogState | null>(null);
export function useBioCatalog() { return useContext(BioCatalogContext); }

/** Mounted only around article body blocks. No request is made until a writer opens a picker. */
export function BioCatalogProvider({ children, loader, sessionKey }: {
  children: ReactNode; loader?: BioCatalogLoader; sessionKey?: string;
}) {
  const shell = useOptionalShell();
  const uid = sessionKey ?? shell?.user.uid ?? "";
  const getIdToken = shell?.getIdToken;
  const [loaded, setLoaded] = useState<{ uid: string; catalog: BioCatalog } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const flight = useRef<AbortController | null>(null);
  const catalog = loaded?.uid === uid ? loaded.catalog : null;
  useEffect(() => {
    setLoaded(null); setBusy(false); setError("");
    return () => { flight.current?.abort(); flight.current = null; };
  }, [uid, loader, getIdToken]);
  const load = useCallback(() => {
    if (catalog || flight.current) return;
    const controller = new AbortController();
    flight.current = controller;
    setBusy(true); setError("");
    void (async () => {
      try {
        let result: BioCatalog;
        if (loader) result = await loader(controller.signal);
        else {
          if (!uid || !getIdToken) throw new Error("No session");
          const token = await getIdToken();
          if (controller.signal.aborted) return;
          const response = await fetch("/guide-content/resources/public-bios.json", {
            headers: { authorization: `Bearer ${token}` }, cache: "no-store", signal: controller.signal,
          });
          if (!response.ok) throw new Error("Catalog unavailable");
          result = parseBioCatalog(await response.json());
        }
        if (!controller.signal.aborted) setLoaded({ uid, catalog: result });
      } catch {
        if (!controller.signal.aborted) setError("Bios could not be loaded. Try again.");
      } finally {
        if (!controller.signal.aborted) { setBusy(false); flight.current = null; }
      }
    })();
  }, [catalog, loader, uid, getIdToken]);
  return <BioCatalogContext.Provider value={{ catalog, busy, error, load }}>{children}</BioCatalogContext.Provider>;
}
