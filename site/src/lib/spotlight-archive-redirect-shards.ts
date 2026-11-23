import { spotlightArchiveRedirectShard } from "../../../packages/content-core/src/spotlight-archive-paths";
import type { CmsPostBuildData } from "./cms-posts-projection";

type ArchivePost = Pick<CmsPostBuildData, "spotlightArchive" | "archiveLegacyPaths" | "path" | "contentLinkMode">;

export function buildSpotlightArchiveRedirectShards(posts: readonly ArchivePost[]): Map<string, Map<string, string>> {
  const shards = new Map<string, Map<string, string>>();
  for (const post of posts) {
    if (!post.spotlightArchive || post.contentLinkMode === "custom") continue;
    for (const path of post.archiveLegacyPaths ?? []) {
      const key = spotlightArchiveRedirectShard(path);
      let shard = shards.get(key);
      if (!shard) shards.set(key, shard = new Map());
      if (shard.has(path)) throw new Error(`Archive Posts claim the same path: ${path}`);
      shard.set(path, post.path);
    }
  }
  return shards;
}
