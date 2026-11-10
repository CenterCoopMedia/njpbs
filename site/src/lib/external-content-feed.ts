import { postCardImage } from "../../../packages/content-core/src/post-card-image.ts";
import { renderContentLinks, type ContentLinkEntry } from "./content-link-render";
import { contentLink } from "../../../packages/content-core/src/content-link.ts";
import {
  escapeHtml,
  renderRichText,
  safeHref,
  type RichTextDoc,
  type RichTextNode,
} from "../../../packages/content-core/src/content-model";
import {
  generatedHeadingLevelAt,
  renderBlock,
} from "../../../packages/content-core/src/content-render";
import { authorPublicPath } from "../../../packages/content-core/src/author-profiles";
import type { CmsPostBuildData } from "./cms-posts-loader";
import type { CmsProgramBuildData } from "./cms-programs-loader";
import { resolveRecordCard, type RecordCardPayload } from "./record-card-resolution";
import { renderDatasetFigures } from "./cms-render-context.ts";
import {
  resolvePublicCreditLinks,
  type PublicAuthorLinkInput,
} from "./public-author-links";

export const EXTERNAL_CONTENT_API_VERSION = 1;
export const EXTERNAL_CONTENT_PATH = "/api/v1/content.json";
export const EXTERNAL_CONTENT_PAGE_SIZE = 20;
export const EXTERNAL_NEWS_FEED_PATH = "/feeds/news.xml";
export const EXTERNAL_NEWS_FEED_ITEM_LIMIT = 20;

export interface ExternalContentAuthor {
  name: string;
  url?: string;
}

export interface ExternalContentImage {
  url: string;
  mimeType: string;
  width: number;
  height: number;
  alt: string;
  decorative: boolean;
}

export interface ExternalContentItem {
  id: string;
  type: "post" | "program";
  sourceId: string;
  sourceVersion: number;
  url: string;
  locale: string;
  title: string;
  summary: string;
  contentHtml: string;
  publishedAt: string;
  modifiedAt: string;
  authors: ExternalContentAuthor[];
  categories: string[];
  tags: string[];
  image?: ExternalContentImage;
  memberOnly?: boolean;
}

export interface ExternalContentManifest {
  apiVersion: 1;
  title: "NJ PBS released content";
  homeUrl: string;
  feedUrl: string;
  rssUrl: string;
  items: ExternalContentItem[];
}

export interface ExternalContentPageLink {
  page: number;
  url: string;
  itemCount: number;
}

export interface ExternalContentIndex {
  apiVersion: 1;
  title: "NJ PBS released content";
  homeUrl: string;
  feedUrl: string;
  rssUrl: string;
  pageSize: number;
  totalItems: number;
  pages: ExternalContentPageLink[];
}

export interface ExternalContentPage {
  apiVersion: 1;
  title: "NJ PBS released content";
  indexUrl: string;
  selfUrl: string;
  previousUrl: string | null;
  nextUrl: string | null;
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  items: ExternalContentItem[];
}

export interface ExternalContentStaticFeed {
  index: ExternalContentIndex;
  pages: ExternalContentPage[];
}

interface ExternalContentInput {
  site: URL | string;
  posts: readonly CmsPostBuildData[];
  programs: readonly CmsProgramBuildData[];
  authors: readonly PublicAuthorLinkInput[];
  recordCards?: readonly RecordCardPayload[];
  contentLinks?: readonly ContentLinkEntry[];
}

function siteRoot(value: URL | string): URL {
  const site = new URL(value);
  if (
    site.protocol !== "https:" ||
    site.username !== "" ||
    site.password !== ""
  ) {
    throw new Error("The external content site URL must use HTTPS");
  }
  return new URL("/", site);
}

function publishedInstant(value: string, owner: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${owner} has an invalid publication instant`);
  }
  return date.toISOString();
}

function richTextPlainText(doc: RichTextDoc): string {
  const text = (node: RichTextNode): string =>
    [
      typeof node.text === "string" ? node.text : "",
      ...(node.content ?? []).map(text),
    ]
      .filter(Boolean)
      .join(" ");
  return doc.content.map(text).join(" ").replace(/\s+/g, " ").trim();
}

function decodedHtmlAttribute(value: string): string {
  return value.replace(
    /&(amp|lt|gt|quot|#39);/g,
    (_match, entity: string) =>
      ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[entity] ?? _match,
  );
}

function portableContentHtml(html: string, pageUrl: string): string {
  return html.replace(/\bhref="([^"]+)"/g, (attribute, encodedHref: string) => {
    const href = safeHref(decodedHtmlAttribute(encodedHref));
    if (href === null || /^(?:https?|mailto|tel):/i.test(href)) {
      return attribute;
    }
    return `href="${escapeHtml(new URL(href, pageUrl).toString())}"`;
  });
}

function postContentHtml(post: CmsPostBuildData, pageUrl: string, cards: readonly RecordCardPayload[]): string {
  const resolveDataFigure = renderDatasetFigures(post.datasetFigures);
  const html = post.blocks
    .map((block, index) =>
      block.type === "record_card" ? (() => {
        const card = resolveRecordCard(block, cards);
        if (!card) return "";
        const label = escapeHtml(card.title);
        const href = card.href && safeHref(card.href);
        return href ? `<p><a href="${escapeHtml(href)}">${label}</a></p>` : `<p>${label}</p>`;
      })() : renderBlock(block, {
        generatedHeadingLevel: generatedHeadingLevelAt(post.blocks, index),
        resolveDataFigure,
        resolveAsset: (assetId) => {
          const asset = post.assets[assetId];
          return asset
            ? {
                url: asset.url,
                mimeType: asset.mimeType,
                width: asset.width,
                height: asset.height,
              }
            : null;
        },
      }),
    )
    .filter((html) => html !== "")
    .join("");
  return portableContentHtml(html, pageUrl);
}

function postItem(
  post: CmsPostBuildData,
  site: URL,
  authors: readonly PublicAuthorLinkInput[],
  cards: readonly RecordCardPayload[],
  contentLinks: readonly ContentLinkEntry[],
): ExternalContentItem {
  const modifiedAt = publishedInstant(post.publishedAt, `Post ${post.postId}`);
  const publishedAt = post.firstPublishedAt === null
    ? modifiedAt
    : publishedInstant(post.firstPublishedAt, `Post ${post.postId}`);
  const url = new URL(contentLink(post, post.path).href, site).toString();
  const selectedImage = postCardImage(post);
  return {
    id: `urn:njpbs:content:post:${post.postId}`,
    type: "post",
    sourceId: post.postId,
    sourceVersion: post.sourceVersion,
    url,
    locale: post.locale,
    title: post.title,
    summary: post.summary || post.excerpt || post.title,
    contentHtml: renderContentLinks(postContentHtml(post, new URL(post.path, site).toString(), cards), contentLinks),
    publishedAt,
    modifiedAt,
    authors: resolvePublicCreditLinks(post.credits, authors).map((credit) => ({
      name: credit.name,
      ...(credit.slug
        ? { url: new URL(authorPublicPath(credit.slug), site).toString() }
        : {}),
    })),
    categories: [...post.categories],
    tags: [...post.tags],
    ...(selectedImage
      ? {
          image: {
            url: selectedImage.image.url,
            mimeType: selectedImage.image.mimeType,
            width: selectedImage.image.width,
            height: selectedImage.image.height,
            alt: selectedImage.alt,
            decorative: selectedImage.decorative,
          },
        }
      : {}),
  };
}

function programItem(
  program: CmsProgramBuildData,
  site: URL,
): ExternalContentItem {
  const publishedAt = publishedInstant(
    program.publishedAt,
    `Program ${program.programId}`,
  );
  const url = new URL(program.path, site).toString();
  return {
    id: `urn:njpbs:content:program:${program.programId}`,
    type: "program",
    sourceId: program.programId,
    sourceVersion: program.sourceVersion,
    url,
    locale: program.locale,
    title: program.title,
    summary: richTextPlainText(program.description) || program.title,
    contentHtml: portableContentHtml(renderRichText(program.description), url),
    publishedAt,
    modifiedAt: publishedAt,
    authors: [],
    categories: [],
    tags: program.genre ? [program.genre] : [],
    memberOnly: program.memberOnly,
  };
}

export function createExternalContentManifest(
  input: ExternalContentInput,
): ExternalContentManifest {
  const site = siteRoot(input.site);
  const items = [
    ...input.posts
      .filter((post) => !post.noindex)
      .map((post) => postItem(post, site, input.authors, input.recordCards ?? [], [...input.posts, ...(input.contentLinks ?? [])])),
    ...input.programs.map((program) => programItem(program, site)),
  ].sort((left, right) => {
    const byPublished =
      Date.parse(right.publishedAt) - Date.parse(left.publishedAt);
    return byPublished || left.id.localeCompare(right.id);
  });
  return {
    apiVersion: EXTERNAL_CONTENT_API_VERSION,
    title: "NJ PBS released content",
    homeUrl: site.toString(),
    feedUrl: new URL(EXTERNAL_CONTENT_PATH, site).toString(),
    rssUrl: new URL(EXTERNAL_NEWS_FEED_PATH, site).toString(),
    items,
  };
}

function externalContentPageUrl(feedUrl: string, page: number): string {
  return new URL(`content/${page}.json`, feedUrl).toString();
}

export function createExternalContentStaticFeed(
  manifest: ExternalContentManifest,
): ExternalContentStaticFeed {
  const totalPages = Math.ceil(
    manifest.items.length / EXTERNAL_CONTENT_PAGE_SIZE,
  );
  const pages = Array.from({ length: totalPages }, (_, index) => {
    const page = index + 1;
    const selfUrl = externalContentPageUrl(manifest.feedUrl, page);
    return {
      apiVersion: EXTERNAL_CONTENT_API_VERSION,
      title: manifest.title,
      indexUrl: manifest.feedUrl,
      selfUrl,
      previousUrl:
        page === 1
          ? null
          : externalContentPageUrl(manifest.feedUrl, page - 1),
      nextUrl:
        page === totalPages
          ? null
          : externalContentPageUrl(manifest.feedUrl, page + 1),
      page,
      pageSize: EXTERNAL_CONTENT_PAGE_SIZE,
      totalItems: manifest.items.length,
      totalPages,
      items: manifest.items.slice(
        index * EXTERNAL_CONTENT_PAGE_SIZE,
        page * EXTERNAL_CONTENT_PAGE_SIZE,
      ),
    } satisfies ExternalContentPage;
  });
  return {
    index: {
      apiVersion: EXTERNAL_CONTENT_API_VERSION,
      title: manifest.title,
      homeUrl: manifest.homeUrl,
      feedUrl: manifest.feedUrl,
      rssUrl: manifest.rssUrl,
      pageSize: EXTERNAL_CONTENT_PAGE_SIZE,
      totalItems: manifest.items.length,
      pages: pages.map((page) => ({
        page: page.page,
        url: page.selfUrl,
        itemCount: page.items.length,
      })),
    },
    pages,
  };
}

function xmlSafeText(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint === 0x09 ||
      codePoint === 0x0a ||
      codePoint === 0x0d ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff)
      ? character
      : "�";
  }).join("");
}

function xmlText(value: string): string {
  return xmlSafeText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function cdata(value: string): string {
  return `<![CDATA[${xmlSafeText(value).replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
}

export function renderExternalContentRss(
  manifest: ExternalContentManifest,
): string {
  const recentItems = manifest.items.slice(0, EXTERNAL_NEWS_FEED_ITEM_LIMIT);
  const lastBuildDate = recentItems.reduce<string | null>((latest, item) => {
    if (!latest || Date.parse(item.modifiedAt) > Date.parse(latest)) {
      return item.modifiedAt;
    }
    return latest;
  }, null);
  const items = recentItems
    .map((item) => {
      const authors = item.authors
        .map((author) => `<dc:creator>${xmlText(author.name)}</dc:creator>`)
        .join("");
      const categories = [
        `<category domain="https://njpbs.org/ns/content/1/type">${xmlText(item.type)}</category>`,
        ...item.categories.map(
          (category) => `<category domain="https://njpbs.org/ns/content/1/category">${xmlText(category)}</category>`,
        ),
        ...item.tags.map(
          (tag) => `<category domain="https://njpbs.org/ns/content/1/tag">${xmlText(tag)}</category>`,
        ),
      ].join("");
      const media = item.image
        ? `<media:content url="${xmlText(item.image.url)}" type="${xmlText(item.image.mimeType)}" width="${item.image.width}" height="${item.image.height}"><media:description>${xmlText(item.image.alt)}</media:description></media:content>`
        : "";
      return `<item><guid isPermaLink="false">${xmlText(item.id)}</guid><title>${xmlText(item.title)}</title><link>${xmlText(item.url)}</link><description>${xmlText(item.summary)}</description><content:encoded>${cdata(item.contentHtml)}</content:encoded><pubDate>${new Date(item.publishedAt).toUTCString()}</pubDate>${authors}${categories}${media}<njpbs:type>${item.type}</njpbs:type><njpbs:sourceVersion>${item.sourceVersion}</njpbs:sourceVersion></item>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/" xmlns:njpbs="https://njpbs.org/ns/content/1"><channel><title>${xmlText(manifest.title)}</title><link>${xmlText(manifest.homeUrl)}</link><description>Released NJ PBS posts and programs.</description><language>en-us</language><atom:link href="${xmlText(manifest.rssUrl)}" rel="self" type="application/rss+xml"/>${lastBuildDate ? `<lastBuildDate>${new Date(lastBuildDate).toUTCString()}</lastBuildDate>` : ""}${items}</channel></rss>\n`;
}
