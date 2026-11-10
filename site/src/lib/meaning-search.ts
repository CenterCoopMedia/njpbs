import { createMeaningSearch } from "../../../packages/browser-search";
import {
  MODEL_ID,
  MODEL_REVISION,
} from "../../../packages/browser-search/contracts";

export interface MeaningPassage {
  id: string;
  url: string;
  contentLinkUrl?: string;
  contentLinkNewTab?: boolean;
  title: string;
  text: string;
  vector: number[];
}

function admittedPassage(
  value: unknown,
  scope: "public" | "guide",
): value is MeaningPassage {
  if (!value || typeof value !== "object") return false;
  const passage = value as MeaningPassage;
  if (
    typeof passage.id !== "string" ||
    typeof passage.title !== "string" ||
    typeof passage.text !== "string" ||
    typeof passage.url !== "string" ||
    !passage.url.startsWith("/") ||
    passage.url.startsWith("//") ||
    passage.url.includes("\\") ||
    !Array.isArray(passage.vector)
  )
    return false;
  const url = new URL(passage.url, "https://njpbs.org");
  if (url.origin !== "https://njpbs.org") return false;
  return scope === "guide"
    ? url.pathname.startsWith("/admin/docs/")
    : !/^\/(admin|wiki|prototype|design-system)(\/|$)/.test(
        url.pathname,
      );
}

export function createPageMeaningSearch(
  scope: "public" | "guide",
  onStatus: (message: string) => void,
  onReady: () => void,
) {
  let active = true;
  let ready = false;
  let unavailable = false;
  let passages: MeaningPassage[] = [];
  const controller = new AbortController();
  const client = createMeaningSearch({
    onProgress: (progress) => {
      if (active && progress.phase === "download") {
        onStatus("Preparing meaning search… Keyword search is ready.");
      }
    },
  });
  // Start immediately while fetching the index. Both must succeed before ready.
  const started = client.start();
  void started.catch(() => undefined);
  void (async () => {
    const response = await fetch(
      scope === "guide"
        ? "/admin/docs/meaning-index.json"
        : "/search/meaning-index.json",
      { signal: controller.signal },
    );
    if (!response.ok) throw Error("Search index unavailable");
    const corpus = await response.json();
    if (
      corpus.version !== 1 ||
      corpus.model !== MODEL_ID ||
      corpus.revision !== MODEL_REVISION ||
      !Array.isArray(corpus.passages)
    ) {
      throw Error("Search index mismatch");
    }
    if (!active) return;
    passages = corpus.passages.filter((p: unknown) =>
      admittedPassage(p, scope),
    );
    onReady(); // Guide keyword results can use the index before model readiness.
    await client.prepare(
      passages.map((p) => ({
        id: p.id,
        text: `${p.title}\n${p.text}`,
        vector: p.vector,
      })),
    );
    await started;
    if (!active) return;
    ready = true;
    onStatus("Search by words or meaning. Runs on this device.");
    onReady();
  })().catch(() => {
    if (active) {
      // Startup cannot recover without a valid index. Stop the concurrent model
      // download, but retain admitted passages for guide keyword matching.
      client.dispose();
      ready = false;
      unavailable = true;
      onStatus("Meaning search is unavailable. Keyword search still works.");
    }
  });

  return {
    get ready() {
      return ready;
    },
    get unavailable() {
      return unavailable;
    },
    get passages() {
      return passages;
    },
    async search(query: string) {
      if (!ready) return [];
      const matches = await client
        .search(query, { limit: 30, minScore: 0.55 })
        .catch((error) => {
          if (active && error?.name !== "AbortError") {
            ready = false;
            unavailable = true;
            onStatus(
              "Meaning search is unavailable. Keyword search still works.",
            );
          }
          return [];
        });
      if (!active) return [];
      const byId = new Map(passages.map((p) => [p.id, p]));
      return matches
        .map((hit) => byId.get(hit.id))
        .filter((p): p is MeaningPassage => Boolean(p));
    },
    dispose() {
      active = false;
      ready = false;
      passages = [];
      controller.abort();
      client.dispose();
    },
  };
}
