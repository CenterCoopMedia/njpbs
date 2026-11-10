import { createRequire } from "node:module";
import type { Firestore } from "firebase-admin/firestore";
import { parseHomeHero } from "../../packages/content-core/src/home-hero.ts";
import type { CmsPageBuildData } from "../src/lib/cms-loader";

const require = createRequire(import.meta.url);
const { readNoBuildPageProjectionInTransaction } = require("../../functions/lib/no-build-page-source.js");
const { publiclyVisible } = require("../../functions/lib/public-video-references.js");
const { PublicContentProjectionError } = require("../../functions/lib/public-content-projection.js");
const { PublishedMediaSafetyError } = require("../../functions/lib/published-media-safety.js");
const { PublicDeploymentFenceError } = require("../../functions/lib/public-deployment.js");

/** Freeze only current public Page pins. The retained bundle remains unchanged. */
export async function readPreviewHomeHeroPages(firestore: Firestore, config: unknown, now: Date): Promise<CmsPageBuildData[]> {
  const pins = (parseHomeHero(config)?.pins ?? []).filter(pin => pin.source === "cms_pages" &&
    (!pin.endsAt || Date.parse(pin.endsAt) > now.getTime()));
  if (!pins.length) return [];
  return firestore.runTransaction(async transaction => {
    const pages: CmsPageBuildData[] = [];
    for (const pin of pins) {
      const row = await transaction.get(firestore.doc(`cmsPages/${pin.sourceId}`));
      if (!row.exists || row.data()?.deleted === true || !publiclyVisible(row.data())) continue;
      try {
        const result = await readNoBuildPageProjectionInTransaction({ firestore, transaction,
          pageId: pin.sourceId, document: row.data(), now });
        if (result.state === "live") pages.push(result.page);
      } catch (error) {
        // Match public Home: unsafe optional cards disappear; database failures propagate.
        if (!(error instanceof PublicContentProjectionError || error instanceof PublishedMediaSafetyError ||
          error instanceof PublicDeploymentFenceError)) throw error;
      }
    }
    return pages;
  }, { readOnly: true });
}
