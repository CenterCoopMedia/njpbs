// The compiler emits this graph from the existing published Post route.
declare module "*.public-post-renderer/server/entry.mjs" {
  export const rendererSha: string;
  export function renderPublishedPost(content: import("../../site/src/lib/published-post-shadow").PublishedPostContent): Promise<string>;
  export function renderPublishedPage(content: import("../../site/src/lib/published-page-render").PublishedPageContent): Promise<string>;
  export function renderPublishedRecordFamily(content: import("../../site/src/lib/published-record-render").PublishedRecordContent): Promise<string>;
  export function renderPublicPageContext(content: import("../../site/src/lib/public-page-context-render").PublicPageContextContent): Promise<string>;
}
