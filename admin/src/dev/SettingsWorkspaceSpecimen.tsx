import { useMemo } from "react";
import { DEFAULT_NJ_DECIDES_SETTINGS, DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS, DEFAULT_PUBLIC_SITE_CHROME_SETTINGS, DEFAULT_SITE_NAVIGATION } from "../../../packages/content-core/src/cms-settings";
import { CoverageLabelsSettings, DEFAULT_COVERAGE_LABELS } from "../components/CoverageLabelsSettings";
import { SettingsWorkspace } from "../components/SettingsWorkspace";
import { PublicHomepageBannerSettings, type PublicHomepageBannerValues } from "../components/PublicHomepageBannerSettings";
import type { NjDecidesValues } from "../components/NjDecidesSettings";
import { PublicSiteChromeSettings, type PublicSiteChromeValues } from "../components/PublicSiteChromeSettings";
import { SiteNavigationSettings } from "../components/SiteNavigationSettings";
import { MediaCategorySettings } from "../components/MediaCategorySettings";
import { AdminSettingsForm, MilestoneSettingsForm, RoutedNjDecidesSettings, type BannerSettingsValues, type MilestoneSettingsValues } from "../routes/AdminSettingsRoute";
import type { CmsSettingsPublishedSnapshot, PublishSettingsRequest, SaveSettingsRequest, SettingsPublicationReceipt } from "../lib/functions";
import type { AdminStatusManifest } from "../lib/admin-status";

/** Synthetic network boundary only; every field and action uses its production owner. */
function transport<T extends object>(id: string, initial: T, schemaVersion = 1, saveDelay = 0) {
  let values = initial;
  let version = 4;
  let published: CmsSettingsPublishedSnapshot<T> | undefined;
  let publication: SettingsPublicationReceipt | undefined;
  const settings = () => ({ schemaVersion, version, values, ...(published ? { published } : {}) });
  return {
    load: async () => ({ success: true as const, found: true as const, id, settings: settings(), ...(publication ? { publication } : {}) }),
    save: async (request: SaveSettingsRequest<T>) => {
      if (saveDelay) await new Promise(resolve => setTimeout(resolve, saveDelay));
      values = request.values as T; version++;
      return { success: true as const, changed: true, id, settings: settings() };
    },
    publish: async (request: PublishSettingsRequest) => {
      published = { schemaVersion, sourceVersion: request.baseVersion, publishedAt: "2026-10-29T13:00:00.000Z", values };
      version++;
      publication = { queueId: `fixture-${id}`, originalOperationId: `fixture-${id}`, transport: "public-context-no-build-v1", sourceVersion: request.baseVersion,
        rendererSha: "a".repeat(40), contextRevision: 1, contextDigest: "b".repeat(64), status: "success", missingConsumers: [] };
      return { success: true as const, changed: true, id, settings: settings(), publication };
    },
  };
}

const loadPages = async () => [];
const loadMedia = async () => ({ success: true as const, records: [], total: 0, allCount: 0, page: 1, pageCount: 1, categoryCounts: {}, kindCounts: {} });
const loadCategories = async () => ({ success: true as const, categories: [] });
const refuseCategoryMutation = async () => { throw new Error("This visual fixture is read-only for media categories."); };
const loadMilestones = async (): Promise<AdminStatusManifest> => ({
  schemaVersion: 2, status: "unavailable", environment: "Local", generatedAt: "2026-10-29T13:00:00.000Z", refreshAfter: "2026-10-29T13:00:00.000Z", build: null, milestone: null, milestones: null,
});

export function SettingsWorkspaceSpecimen() {
  const api = useMemo(() => ({
    banner: transport<PublicHomepageBannerValues>("public-homepage-banner", { ...DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS, enabled: true, njDecides: true, message: "Find voting information for New Jersey.", linkLabel: "NJ Decides 2026", linkHref: "/nj-decides-2026/" }, 2, new URLSearchParams(location.search).has("pending-save") ? 1_000 : 0),
    brand: transport<NjDecidesValues>("nj-decides-brand", DEFAULT_NJ_DECIDES_SETTINGS),
    coverage: transport("coverage-labels", DEFAULT_COVERAGE_LABELS),
    navigation: transport("site-navigation", DEFAULT_SITE_NAVIGATION),
    chrome: transport<PublicSiteChromeValues>("public-site-chrome", DEFAULT_PUBLIC_SITE_CHROME_SETTINGS),
    home: transport<BannerSettingsValues>("newsroom-home", { bannerHeading: "Build and publication details" }),
    milestone: transport<MilestoneSettingsValues>("newsroom-milestone", { milestoneNumber: 1 }),
  }), []);
  return <SettingsWorkspace sections={[
    { id: "public-homepage-banner", label: "Homepage banner", group: "Public website", content: <PublicHomepageBannerSettings {...api.banner} /> },
    { id: "nj-decides-brand", label: "NJ Decides brand", headingId: "nj-decides-settings-heading", group: "Public website", content: <RoutedNjDecidesSettings {...api.brand} loadMedia={loadMedia} /> },
    { id: "coverage-labels", label: "Coverage labels", group: "Public website", content: <CoverageLabelsSettings {...api.coverage} /> },
    { id: "site-navigation", label: "Site navigation", group: "Public website", content: <SiteNavigationSettings {...api.navigation} loadPages={loadPages} /> },
    { id: "public-site-chrome", label: "Header newsletter", group: "Public website", content: <PublicSiteChromeSettings {...api.chrome} /> },
    { id: "media-categories", label: "Media categories", group: "Workspace", content: <MediaCategorySettings load={loadCategories} mutate={refuseCategoryMutation} /> },
    { id: "newsroom-defaults", label: "Newsroom defaults", group: "Workspace", content: <div className="admin-settings-internal-grid"><AdminSettingsForm {...api.home} /><MilestoneSettingsForm loadSettings={api.milestone.load} loadStatus={loadMilestones} save={api.milestone.save} /></div> },
  ]} />;
}
