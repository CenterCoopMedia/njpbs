import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Loader } from "astro/loaders";

export const CMS_PREVIEW_EXPORT_COLLECTIONS = [
  "cmsPages", "cmsPosts", "cmsPrograms", "cmsRecordCards", "cmsEvents",
  "cmsAuthorsPublic", "cmsPublicSettings", "cmsSiteNavigation", "cmsPublicSiteChrome",
] as const;
export type CmsPreviewExportCollection = typeof CMS_PREVIEW_EXPORT_COLLECTIONS[number];

/** GitHub's trusted preparation job exports projected data, never executable
 * content or credentials. Astro still applies each collection's schema.
 */
export function cmsPreviewExportLoader(collection: CmsPreviewExportCollection): Loader | null {
  const inputPath = process.env.CMS_PREVIEW_EXPORT_PATH;
  const digest = process.env.CMS_PREVIEW_EXPORT_SHA256;
  if (!inputPath && !digest) return null;
  if (!inputPath || !path.isAbsolute(inputPath) || !digest || !/^[a-f0-9]{64}$/.test(digest) ||
      process.env.CMS_CONTENT_MODE !== "draft") {
    throw new Error("CMS preview export requires an absolute path, digest and draft mode");
  }
  return {
    name: `cms-preview-export-${collection}-${digest}`,
    async load({ store, parseData }) {
      const bytes = await readFile(inputPath);
      if (createHash("sha256").update(bytes).digest("hex") !== digest) {
        throw new Error("CMS preview export digest does not match");
      }
      const input = JSON.parse(bytes.toString());
      if (input.schemaVersion !== 1 || input.queueId !== process.env.CMS_PREVIEW_QUEUE_ID ||
          input.pageId !== process.env.CMS_PREVIEW_PAGE_ID ||
          input.rendererSha !== process.env.CMS_PREVIEW_RENDERER_SHA ||
          !Number.isSafeInteger(input.sourceVersion) || input.sourceVersion < 1 ||
          String(input.sourceVersion) !== process.env.SOURCE_VERSION ||
          !Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= Date.now() ||
          CMS_PREVIEW_EXPORT_COLLECTIONS.some(key => !Array.isArray(input.collections?.[key]))) {
        throw new Error("CMS preview export identity, expiry or collections are invalid");
      }
      const pages = input.collections.cmsPages;
      if (pages.length !== 1 || pages[0].id !== input.pageId ||
          pages[0].data?.pageId !== input.pageId ||
          pages[0].data?.sourceVersion !== input.sourceVersion ||
          pages[0].data?.contentMode !== "draft") {
        throw new Error("CMS preview export does not contain the exact saved draft");
      }
      store.clear();
      const ids = new Set<string>();
      for (const entry of input.collections[collection]) {
        if (typeof entry?.id !== "string" || !entry.id || ids.has(entry.id) ||
            !entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) {
          throw new Error("CMS preview export contains an invalid collection entry");
        }
        ids.add(entry.id);
        store.set({ id: entry.id, data: await parseData({ id: entry.id, data: entry.data }) });
      }
    },
  };
}
