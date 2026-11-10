import { currentCmsSettingsSchemaFor, SITE_NAVIGATION_SETTINGS_ID, type SiteNavigationTarget, type SiteNavigationLaunchKey, type SiteNavigationRouteKey, type SiteNavigationSettingsValues } from "../../../packages/content-core/src/cms-settings";
import { navigationLinkOpensInNewTab, SITE_NAVIGATION_LAUNCH_URLS } from "../../../packages/content-core/src/site-navigation";

export function siteNavigationSchema() {
  const schema = currentCmsSettingsSchemaFor(SITE_NAVIGATION_SETTINGS_ID);
  const header = schema?.fields.header;
  const footer = schema?.fields.footer;
  if (
    !schema ||
    header?.kind !== "navigationLinks" ||
    footer?.kind !== "navigationColumns"
  ) {
    throw new Error("The site navigation schema is unavailable.");
  }
  return { schema, header, footer };
}

export const LAUNCH_LABELS: Record<SiteNavigationLaunchKey, string> = {
  pbsVideo: "PBS video portal (watch on demand)",
  donate: "PBS donation form",
  passportLearnMore: "Passport learn more",
};

export const ROUTE_CHOICES: Record<SiteNavigationRouteKey, { label: string; note: string }> = {
  postsIndex: {
    label: "Posts index",
    note: "Links to /posts/. The public site shows it only while it publishes Posts.",
  },
  inTheNews: {
    label: "In the news page",
    note: "Links to /in-the-news/. The public site shows it only while that page is published.",
  },
};

export function siteNavigationTargetSummary(target: SiteNavigationTarget, pageOptions: readonly { id: string; title: string }[]): string {
  switch (target.type) {
    case "page": {
      const page = pageOptions.find(({ id }) => id === target.pageId);
      return page ? `${page.title} page` : "Unpublished page";
    }
    case "route":
      return ROUTE_CHOICES[target.key].label;
    case "launch":
      return LAUNCH_LABELS[target.key];
    case "href":
      return target.href.trim() || "No web address yet";
  }
}

export function siteNavigationLinkOpensInNewTab(link: Pick<SiteNavigationSettingsValues["header"][number], "target" | "external">): boolean {
  const href = link.target.type === "launch" ? SITE_NAVIGATION_LAUNCH_URLS[link.target.key]
    : link.target.type === "href" ? link.target.href.trim() : "";
  return navigationLinkOpensInNewTab(link.external, href);
}

export function siteNavigationLinkSummary(link: Pick<SiteNavigationSettingsValues["header"][number], "target" | "external">, pages: readonly { id: string; title: string }[]): string {
  return siteNavigationTargetSummary(link.target, pages) + (siteNavigationLinkOpensInNewTab(link) ? ", opens in a new tab" : "");
}

export function siteNavigationHeaderNote(count: number, maximum: number): string {
  return `${count} of ${maximum} links. Search, newsletter and the Donate button stay in the header.`;
}

export function siteNavigationFooterNote(count: number, maximum: number, links: number): string {
  return `${count} of ${maximum} columns, each with up to ${links} links.`;
}
