import { useEffect, useMemo, useState } from "react";
import type { PublishedVocabulary } from "../../../packages/content-core/src/published-vocabulary";

export type VocabularyLoader = () => Promise<PublishedVocabulary>;
const empty: PublishedVocabulary = { tags: [], categories: [] };

/** One request per editor mount, including StrictMode's repeated effect. Typing stays local. */
export function usePublishedVocabulary(load: VocabularyLoader | undefined, enabled: boolean) {
  const request = useMemo(() => ({ promise: null as Promise<PublishedVocabulary> | null }), [load]);
  const [result, setResult] = useState<{ request: typeof request; vocabulary: PublishedVocabulary; status: "ready" | "error" }>();
  useEffect(() => {
    if (!load || !enabled) return;
    let live = true;
    request.promise ??= Promise.resolve().then(load);
    void request.promise.then(vocabulary => {
      if (live) setResult({ request, vocabulary, status: "ready" });
    }).catch(() => {
      if (live) setResult({ request, vocabulary: empty, status: "error" });
    });
    return () => { live = false; };
  }, [load, enabled, request]);
  if (!load) return { vocabulary: empty, status: "ready" as const };
  if (!enabled) return { vocabulary: empty, status: "idle" as const };
  return result?.request === request ? result : { vocabulary: empty, status: "loading" as const };
}
