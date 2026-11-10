import { useState } from "react";
import { MediaPaging } from "../components/media/MediaPaging";

export function MediaPagingSpecimen({ mode }: { mode: "numbered" | "cursor" | "load-more" }) {
  const [page, setPage] = useState(2);
  const [loaded, setLoaded] = useState(24);
  return <div className="panel" style={{ display: "grid", gap: "var(--cms-space-4)" }}>
    <h2>{mode === "load-more" ? "Collection items" : mode === "cursor" ? "Favorite pages" : "Image pages"}</h2>
    {mode === "numbered" ? <MediaPaging mode="numbered" page={page} pageCount={4} onPage={setPage} />
      : mode === "cursor" ? <MediaPaging mode="cursor" page={page} isLastPage={page === 3}
        onFirst={() => setPage(1)} onPrevious={() => setPage(value => Math.max(1, value - 1))}
        onNext={() => setPage(value => Math.min(3, value + 1))} />
        : <MediaPaging mode="load-more" loaded={loaded} total={72} hasMore={loaded < 72}
          onMore={() => setLoaded(value => Math.min(72, value + 24))} />}
  </div>;
}
