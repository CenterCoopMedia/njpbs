import type { ListMediaResponse, MediaCorpusRequest, MediaCorpusResponse, MediaListQuery } from "../lib/functions";
import { DEFAULT_MEDIA_QUERY } from "../lib/media-query";

// Gallery list loaders return their complete local fixture, including its empty,
// pending or failed state. Keep meaning search on that same fixture transport.
export function galleryMediaCorpusLoader(loadMedia: (query: MediaListQuery) => Promise<ListMediaResponse>) {
  return async ({ cursor, limit = 500 }: MediaCorpusRequest): Promise<MediaCorpusResponse> => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Invalid fixture corpus limit");
    const { records } = await loadMedia({ ...DEFAULT_MEDIA_QUERY });
    if (records.length > 5000) throw new Error("Fixture corpus exceeds the media scan limit");
    const ordered = records
      .filter(asset => cursor === undefined || asset.id > cursor)
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    const page = ordered.slice(0, limit);
    return {
      success: true,
      records: page,
      nextCursor: ordered.length > limit ? page[page.length - 1].id : null,
    };
  };
}
