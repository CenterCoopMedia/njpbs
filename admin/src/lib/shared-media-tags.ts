import { createContext } from "react";
import { postFunction } from "./functions";
import { mediaCacheIdentityRevision, subscribeMediaCacheIdentity } from "./media-session-cache";

export const MediaTagTokenContext = createContext<(() => Promise<string>) | null>(null);

const FRESH_MS = 60_000;
let sample: { revision: number; expiresAt: number; tags: Promise<string[]> } | undefined;
subscribeMediaCacheIdentity(() => { sample = undefined; });

/** Share an in-flight or recent sample only with the same account and access level. */
export function loadSharedMediaTags(getIdToken: () => Promise<string>, revision: number): Promise<string[]> {
  if (revision !== mediaCacheIdentityRevision()) return Promise.resolve([]);
  if (sample?.revision === revision && Date.now() < sample.expiresAt) return sample.tags;
  const tags = getIdToken().then(async token => {
    if (revision !== mediaCacheIdentityRevision()) return [];
    const [images, video] = await Promise.allSettled([
      postFunction<{ tags: string[] }>("cmsListMedia", token, { tagsOnly: true }),
      postFunction<{ tags: string[] }>("cmsListSourceMedia", token, { sourceId: "video-library", tagsOnly: true }),
    ]);
    if (revision !== mediaCacheIdentityRevision()) return [];
    return [images, video].flatMap(result =>
      result.status === "fulfilled" && Array.isArray(result.value.tags)
        ? result.value.tags.filter(tag => typeof tag === "string")
        : [],
    );
  }).catch(() => []);
  sample = { revision, expiresAt: Date.now() + FRESH_MS, tags };
  return tags;
}
