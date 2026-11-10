import { isPublishable } from "../../../packages/content-core/src/publish-gate";
import { contentLink, type ContentLinkMetadata } from "../../../packages/content-core/src/content-link.ts";
import { publicPagePath } from "../../../packages/content-core/src/public-pages";
export interface ContentLinkSearchRecord extends ContentLinkMetadata { path: string; title: string; text: string }

/** Search indexes the listing metadata, never the retained redirect-page body. */
export function publishedContentLinkRecords(documents: ReadonlyMap<string, any>, now: Date): (ContentLinkSearchRecord & { noindex: boolean })[] {
  return [...documents].flatMap(([key, document]) => {
    const metadata = document.published?.metadata;
    if (!/^cms(?:Posts|Pages)\//.test(key) || !isPublishable(document, now) || metadata?.contentLinkMode !== "custom" ||
        typeof document.published.publishedAt !== "string" ||
        !Number.isFinite(Date.parse(document.published.publishedAt)) || Date.parse(document.published.publishedAt) > now.getTime()) return [];
    const path = key.startsWith("cmsPosts/") ? metadata.type === "post" ? `/posts/${metadata.slug}/` : null
      : publicPagePath(key.slice("cmsPages/".length), metadata);
    if (!path || typeof metadata.title !== "string") return [];
    const link = contentLink(metadata, path);
    return [{ path, title: metadata.title, noindex: metadata.seo?.noindex === true, text: metadata.summary || metadata.excerpt || metadata.description || metadata.title,
      contentLinkMode: "custom" as const, contentLinkUrl: link.href, contentLinkNewTab: link.newTab }];
  }).sort((a,b) => a.path.localeCompare(b.path));
}

/** A hidden search result can still be a destination in another public item. */
export function contentLinkSearchRecords(documents: ReadonlyMap<string, any>, now: Date): ContentLinkSearchRecord[] {
  return publishedContentLinkRecords(documents, now).filter(record => !record.noindex).map(({ noindex: _noindex, ...record }) => record);
}
