import { DEFAULT_SITE_NAVIGATION, DEFAULT_PUBLIC_SITE_CHROME_SETTINGS } from "../../../../packages/content-core/src/cms-settings";

export const newsPageId = `page-${"1".repeat(32)}`;
export function chromeSettings(label = "Newsletter") {
  const navigation = structuredClone(DEFAULT_SITE_NAVIGATION);
  const values = { ...navigation, header: [...navigation.header,
    { id: "staff", label: "Staff", external: false, target: { type: "page", pageId: "staff" } },
    { id: "custom-news", label: "News page", external: false, target: { type: "page", pageId: newsPageId } },
  ] };
  return [
    { id: "site-navigation", version: 4, published: { schemaVersion: 1, sourceVersion: 3,
      publishedAt: "2026-10-07T12:00:00.000Z", values } },
    { id: "public-site-chrome", version: 4, published: { schemaVersion: 1, sourceVersion: 3,
      publishedAt: "2026-10-07T12:00:00.000Z", values: { ...DEFAULT_PUBLIC_SITE_CHROME_SETTINGS,
        newsletterLabel: label, newsletterOpensInNewTab: true } } },
  ];
}
