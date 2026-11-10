import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection } from "astro:content";
import {
  createExternalContentManifest,
  createExternalContentStaticFeed,
  type ExternalContentPage,
} from "../../lib/external-content-feed";

interface PageProps {
  contentPage: ExternalContentPage;
}

export const prerender = true;

export const getStaticPaths: GetStaticPaths = async () => {
  const site = import.meta.env.SITE;
  if (!site) throw new Error("The public site URL is not configured");
  const [posts, programs, authors, recordCards, pages] = await Promise.all([
    getCollection("cmsPosts"),
    getCollection("cmsPrograms"),
    getCollection("cmsAuthorsPublic"),
    getCollection("cmsRecordCards"),
    getCollection("cmsPages"),
  ]);
  const manifest = createExternalContentManifest({
    site,
    posts: posts.map((entry) => entry.data),
    contentLinks: pages.map((entry) => entry.data),
    programs: programs.map((entry) => entry.data),
    authors: authors.map((entry) => entry.data),
    recordCards: recordCards.map((entry) => entry.data),
  });
  return createExternalContentStaticFeed(manifest).pages.map((contentPage) => ({
    params: { page: String(contentPage.page) },
    props: { contentPage },
  }));
};

export const GET: APIRoute<PageProps> = ({ props }) =>
  new Response(`${JSON.stringify(props.contentPage)}\n`, {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
