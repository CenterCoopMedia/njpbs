import type { VideoSearchEntry } from "./video-search-session-cache";

export interface VideoSearchGroup {
  entry: VideoSearchEntry;
  passages: VideoSearchEntry[];
  passageCount: number;
}

/** Keep the top 12 videos and 12 distinct passages per video, then sort by playback time. */
export function groupVideoSearchResults(results: readonly VideoSearchEntry[]): VideoSearchGroup[] {
  const groups = new Map<string, VideoSearchGroup>();
  const seen = new Set<string>();
  for (const entry of results) {
    const key = `${entry.asset.sourceId}/${entry.asset.id}`;
    const chunk = entry.chunk;
    const passageKey = JSON.stringify(chunk
      ? [key, chunk.transcriptId, chunk.editRevision, chunk.segmentIndex, chunk.startSeconds]
      : [key]);
    if (seen.has(passageKey)) continue;
    seen.add(passageKey);
    let group = groups.get(key);
    if (!group) {
      if (groups.size >= 12) continue;
      group = { entry: { ...entry, chunk: undefined }, passages: [], passageCount: 0 };
      groups.set(key, group);
    }
    if (entry.chunk) {
      group.passageCount += 1;
      if (group.passages.length < 12) group.passages.push(entry);
    }
  }
  for (const group of groups.values()) group.passages.sort((a, b) => a.chunk!.startSeconds - b.chunk!.startSeconds);
  return [...groups.values()];
}

/** Nearby saved segments supply context even when a transcript uses one word per segment. */
export function videoPassageContext(entry: VideoSearchEntry, corpus: readonly VideoSearchEntry[], query: string): string {
  const chunk = entry.chunk;
  if (!chunk) return entry.text;
  const neighbors = corpus.filter(row => row.asset.id === entry.asset.id && row.asset.sourceId === entry.asset.sourceId &&
    row.chunk?.transcriptId === chunk.transcriptId && row.chunk.editRevision === chunk.editRevision)
    .sort((a, b) => a.chunk!.segmentIndex - b.chunk!.segmentIndex || a.chunk!.id.localeCompare(b.chunk!.id));
  const position = neighbors.findIndex(row => row.id === entry.id);
  let start = position;
  let end = position;
  let before = 0;
  let after = 0;
  while (start > 0 && before < 90 && neighbors[start].chunk!.segmentIndex === neighbors[start - 1].chunk!.segmentIndex + 1 &&
    neighbors[start].chunk!.startSeconds - neighbors[start - 1].chunk!.endSeconds <= 3) {
    before += neighbors[--start].text.length + 1;
  }
  while (end >= 0 && end < neighbors.length - 1 && after < 90 && neighbors[end + 1].chunk!.segmentIndex === neighbors[end].chunk!.segmentIndex + 1 &&
    neighbors[end + 1].chunk!.startSeconds - neighbors[end].chunk!.endSeconds <= 3) {
    after += neighbors[++end].text.length + 1;
  }
  const text = position < 0 ? chunk.text : neighbors.slice(start, end + 1).map(row => row.text.trim()).join(" ");
  if (text.length <= 300) return text;
  const match = query.trim() ? text.match(new RegExp(escapePattern(query.trim()), "iu")) : null;
  const offset = Math.max(0, (match?.index ?? before) - 90);
  return `${offset ? "…" : ""}${text.slice(offset, offset + 300)}${offset + 300 < text.length ? "…" : ""}`;
}

function escapePattern(text: string) { return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export function videoSearchHighlight(text: string, query: string): { text: string; match: boolean }[] {
  const needle = query.trim();
  if (!needle) return [{ text, match: false }];
  return text.split(new RegExp(`(${escapePattern(needle)})`, "giu"))
    .map((part, index) => ({ text: part, match: index % 2 === 1 }));
}
