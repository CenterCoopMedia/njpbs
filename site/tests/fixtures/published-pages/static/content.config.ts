import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { fileURLToPath } from "node:url";
import { z } from "astro/zod";
import { staticFixtureContent } from "../fixtures";
const content = staticFixtureContent(process.env.CMS_COMPILED_RENDERER_SHA);
const fallback = process.env.CMS_PAGE_FIXTURE_FALLBACK === "1";
const collection = (name: string, records: { id: string; data: object }[]) => defineCollection({
  schema: z.looseObject({}),
  loader: { name: `public-page-parity-${name}`, async load({ store }) {
    store.clear(); for (const record of records) store.set({ id: record.id, data: { ...record.data } });
  } },
});
export const collections = {
  cmsPages: collection("pages", fallback ? [] : content.pages.map(data => ({ id: data.pageId, data }))),
  cmsPosts: collection("posts", content.posts.map(data => ({ id: data.postId, data }))),
  cmsAuthorsPublic: collection("authors", content.authors.map(data => ({ id: data.authorId, data }))),
  cmsPublicSettings: collection("settings", content.settings.map(data => ({ id: data.settingId, data }))),
  cmsSiteNavigation: collection("navigation", content.settings.filter(data => data.settingId === "site-navigation").map(data => ({ id: data.settingId, data }))),
  cmsPublicSiteChrome: collection("chrome", content.settings.filter(data => data.settingId === "public-site-chrome").map(data => ({ id: data.settingId, data }))),
  publicHomeSources: collection("sources", [{ id: "home", data: content.homeSources }]),
  cmsRecordCards: collection("cards", content.recordCards.map(data => ({ id: data.id, data }))),
  cmsPrograms: collection("programs", content.programs.map(data => ({ id: data.programId, data }))),
  cmsEvents: collection("events", []),
  pages: fallback ? defineCollection({ loader: glob({ pattern: "*.md", base: fileURLToPath(new URL("../../../../src/content/pages/", import.meta.url)) }),
    schema: z.object({ title: z.string(), description: z.string(), noindex: z.boolean().default(false) }) }) : collection("legacy", []),
};
