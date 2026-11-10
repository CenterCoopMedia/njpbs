import { defineCollection } from "astro:content";
import { z } from "astro/zod";
import { results } from "./results";

const empty = (name: string) => defineCollection({ schema: z.looseObject({}),
  loader: { name: `social-fixture-${name}`, async load({ store }) { store.clear(); } } });
export const collections = Object.fromEntries([
  "cmsPages", "cmsPosts", "cmsAuthorsPublic", "cmsPublicSettings", "cmsSiteNavigation",
  "cmsPublicSiteChrome", "cmsRecordCards", "pages", "publicDataHubReporting",
].map(name => [name, empty(name)]));
collections.cmsPages = defineCollection({ schema: z.looseObject({}),
  loader: { name: "social-fixture-result-pages", async load({ store }) {
    store.clear();
    for (const id of ["data-hub", "staff"]) store.set({ id, data: { pageId: id, path: `/${id}/`,
      family: id === "staff" ? "staff" : "dataHub", template: "genericPage", title: "Sample results",
      description: "Local metadata fixture", noindex: false, assets: {}, blocks: [results], contentMode: "published",
      sourceVersion: 1, publishedAt: "2026-10-27T12:00:00.000Z" } });
  } } });
