import type { LayoutBlock } from "./content-layout";

/** An explicit Boardwalk destination; legacy body content is never inferred. */
export const LIVE_BLOG_SIDEBAR = "post-live-blog-sidebar";

export function canPlaceInLiveBlogSidebar(block: Pick<LayoutBlock, "type" | "layout" | "section">): boolean {
  return block.type !== "row" && block.layout === undefined &&
    (block.section === undefined || block.section === LIVE_BLOG_SIDEBAR);
}

export function splitLiveBlogBlocks<T extends Pick<LayoutBlock, "section">>(groups: readonly T[], liveBlog: boolean): { body: T[]; sidebar: T[] } {
  return {
    body: groups.filter(group => !liveBlog || group.section !== LIVE_BLOG_SIDEBAR),
    sidebar: liveBlog ? groups.filter(group => group.section === LIVE_BLOG_SIDEBAR) : [],
  };
}
