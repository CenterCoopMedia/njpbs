import { getCollection, type CollectionEntry } from "astro:content";
import { contentLink } from "../../../packages/content-core/src/content-link";
import { cmsRoutedContentEnabled } from "./build-target";
import { isSpanishPostSlug } from "./public-content-routes";
import { resolvePublicCreditLinks } from "./public-author-links";

type PostEntry = CollectionEntry<"cmsPosts">;
export type PublicPostProps = { index: true } | {
  entry: PostEntry;
  credits: PostEntry["data"]["credits"];
  redirectFrom?: string;
  alternatePath?: string;
};

export async function postStaticPaths(locale: "en" | "es") {
  if (!cmsRoutedContentEnabled(process.env)) return [];
  const [posts, authors] = await Promise.all([getCollection("cmsPosts"), getCollection("cmsAuthorsPublic")]);
  const originalById = new Map(posts.filter(({ data }) => !data.editionOf).map(({ data }) => [data.postId, data]));
  const editionsByOriginal = new Map(posts.flatMap(({ data }) => data.editionOf ? [[data.editionOf, data] as const] : []));
  const publicAuthors = authors.map(({ data }) => ({
    authorId: data.authorId, displayName: data.displayName, slug: data.slug,
  }));
  const paths: { params: { slug: string | undefined }; props: PublicPostProps }[] =
    locale === "en" ? [{ params: { slug: undefined }, props: { index: true } }] : [];
  for (const entry of posts) {
    const post = entry.data;
    const spanish = isSpanishPostSlug(post.slug);
    if (spanish !== (locale === "es")) continue;
    const alternate = post.editionOf ? originalById.get(post.editionOf) : editionsByOriginal.get(post.postId);
    const alternatePath = alternate && !contentLink(alternate, alternate.path).external ? alternate.path : undefined;
    const credits = resolvePublicCreditLinks(post.credits, publicAuthors);
    const param = (slug: string) => spanish ? slug.slice(3) : slug;
    paths.push({ params: { slug: param(post.slug) }, props: { entry, credits, alternatePath } });
    for (const previous of post.previousSlugs) {
      paths.push({ params: { slug: param(previous) }, props: { entry, credits, redirectFrom: previous } });
    }
  }
  return paths;
}
