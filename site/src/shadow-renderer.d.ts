declare module "*.shadow-renderer/server/entry.mjs" {
  export const rendererSha: string;
  export function renderPublishedPost(content: import("./lib/published-post-shadow").PublishedPostContent): Promise<string>;
}
