import { defineCollection } from "astro:content";
import { projectCmsPost } from "../../../../src/lib/cms-posts-projection";
import { spotlightArchivePost } from "../fixtures";

export const collections = {
  cmsPosts: defineCollection({
    loader: async () => {
      const post = projectCmsPost(spotlightArchivePost.document, {
        now: new Date("2026-10-07T13:00:00Z"),
        assets: new Map(spotlightArchivePost.assets.map(asset => [asset.id, asset])),
      });
      if (!post) throw new Error("Archive Post fixture was not admitted");
      return [{ id: post.postId, ...post }];
    },
  }),
};
