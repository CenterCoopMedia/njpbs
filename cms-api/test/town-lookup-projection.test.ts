import { expect, it } from "vitest";
import { fetchPublicPageProjection, type CmsApiEnv } from "../src/index";

const env: CmsApiEnv = {
  ALLOW_LOCAL_ORIGINS: "false",
  CMS_EDGE_ORIGIN_SECRET: "synthetic-town-edge",
  FIREBASE_PROJECT_ID: "njpbs-site",
  FUNCTIONS_ORIGIN: "https://us-central1-njpbs-site.cloudfunctions.net",
  RATE_LIMITERS: {} as CmsApiEnv["RATE_LIMITERS"],
};
const block = { id: "town", type: "town_lookup", order: 0, visible: true,
  data: { heading: "How your town voted", introduction: "Compare past federal elections.", sourceLine: "NJ Spotlight News" } };

it.each([
  ["watch", "/watch/", "service", "programLanding"],
  ["contact", "/contact/", "article", "genericPage"],
] as const)("preserves the town lookup through the actual %s RPC decoder", async (pageId, path, family, template) => {
  const result = await fetchPublicPageProjection(env, pageId, {
    fetchOrigin: async () => Response.json({ apiVersion: 1, state: "live", page: {
      pageId, path, family, template, title: "Past results", description: "Town election results",
      noindex: false, contentMode: "published", sourceVersion: 1, publishedAt: "2026-11-02T00:00:00.000Z",
      assets: {}, blocks: [block, { ...block, id: "hidden-town", order: 1, visible: false }],
    } }),
  });
  expect(result.state).toBe("live");
  if (result.state !== "live") throw new Error("Expected the published Page");
  expect(result.page.blocks).toEqual([block]);
});

it.each([true, false])("refuses a visible=%s town lookup on Home at the RPC boundary", async visible => {
  await expect(fetchPublicPageProjection(env, "home", {
    fetchOrigin: async () => Response.json({ apiVersion: 1, state: "live", page: {
      pageId: "home", path: "/", family: "home", template: "home", title: "Home", description: "Home",
      noindex: false, contentMode: "published", sourceVersion: 1, publishedAt: "2026-11-02T00:00:00.000Z",
      assets: {}, blocks: [{ ...block, visible }],
    } }),
  })).rejects.toThrow("Invalid projection");
});
