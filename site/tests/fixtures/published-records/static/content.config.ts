import { defineCollection } from "astro:content";
import { z } from "astro/zod";
import { staticRecordContent, recordRead, type RecordScenario, type RecordArtFormat } from "../fixtures";
import { projectChrome } from "../../../../src/lib/published-post-shadow";
const scenario = process.env.RECORD_PARITY_SCENARIO ?? "mixed";
if (!["mixed", "empty", "withdrawn"].includes(scenario)) throw new Error("Invalid record parity scenario");
const format = process.env.RECORD_ART_FORMAT ?? "gif";
if (!["gif", "jpeg", "png", "webp"].includes(format)) throw new Error("Invalid record art format");
const content = staticRecordContent(scenario as RecordScenario, format as RecordArtFormat);
const chrome = projectChrome(recordRead("programs"));
const collection = (name: string, records: { id: string; data: object }[]) => defineCollection({
  schema: z.looseObject({}), loader: { name: `public-record-parity-${name}`, async load({ store }) {
    store.clear(); for (const record of records) store.set({ id: record.id, data: { ...record.data } });
  } },
});
export const collections = {
  cmsPrograms: collection("programs", content.programs.map(data => ({ id: data.programId, data }))),
  cmsEvents: collection("events", content.events.map(data => ({ id: data.eventId, data }))),
  cmsPages: collection("pages", []), cmsPosts: collection("posts", []), cmsAuthorsPublic: collection("authors", []),
  cmsRecordCards: collection("cards", []),
  cmsSiteNavigation: collection("navigation", chrome.settings.filter(data => data.settingId === "site-navigation").map(data => ({ id: data.settingId, data }))),
  cmsPublicSiteChrome: collection("chrome", chrome.settings.filter(data => data.settingId === "public-site-chrome").map(data => ({ id: data.settingId, data }))),
};
