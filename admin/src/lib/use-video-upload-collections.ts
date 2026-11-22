import { useEffect, useRef, useState } from "react";
import { listMediaCollections, type MediaCollectionScope, type MediaCollectionSummary } from "./media-collections";

const scopes = ["private", "all_staff"] as const;
type Page = { records: MediaCollectionSummary[]; nextCursor: string | null; error?: boolean };

export function useVideoUploadCollections(enabled: boolean, userId: string, getIdToken: () => Promise<string>) {
  const [pages, setPages] = useState<Partial<Record<MediaCollectionScope, Page>>>({});
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);

  async function load(current: number, previous: typeof pages) {
    setLoading(true);
    const token = Promise.resolve().then(getIdToken);
    const entries = await Promise.all(scopes.map(async scope => {
      const page = previous[scope];
      if (page && !page.error && !page.nextCursor) return [scope, page] as const;
      try {
        const idToken = await token;
        if (generation.current !== current) return [scope, page] as const;
        const result = await listMediaCollections(idToken, {
          scope, lifecycle: "active", limit: 30, cursor: page?.nextCursor ?? undefined,
        });
        return [scope, { records: [...(page?.records ?? []), ...result.collections], nextCursor: result.nextCursor }] as const;
      } catch {
        return [scope, { records: page?.records ?? [], nextCursor: page?.nextCursor ?? null, error: true }] as const;
      }
    }));
    if (generation.current !== current) return;
    setPages(Object.fromEntries(entries));
    setLoading(false);
  }

  useEffect(() => {
    if (!enabled) return;
    setPages({});
    void load(++generation.current, {});
    return () => { generation.current++; };
  }, [enabled, userId, getIdToken]);

  return {
    collections: scopes.flatMap(scope => pages[scope]?.records ?? []),
    loading,
    error: scopes.some(scope => pages[scope]?.error),
    hasMore: scopes.some(scope => pages[scope]?.nextCursor),
    loadMore: () => { if (!loading) void load(generation.current, pages); },
  };
}
