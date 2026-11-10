import { createStudyReferenceFixtures } from "./StudyReferenceFixtures";
import { ControlRolesSpecimen } from "./ControlRolesSpecimen";
import { BrowsingWorkflowSpecimen } from "./BrowsingWorkflowSpecimen";
import { QueueSurface } from "../components/QueueSurface";
import { HomeV2ConversionSpecimen } from "./HomeV2ConversionSpecimen";
import { HomeShelfLayoutsGallery } from "./HomeShelfLayoutsGallery";
import { HomeV2ParitySpecimen } from "./HomeV2ParitySpecimen";
import homeNewsletterCopy from "../../../site/tests/fixtures/home-sources/newsletter-public-copy.json";
import homeNewscastFixture from "../../../site/tests/fixtures/home-sources/newscast-documented-schema.json";
import { adaptLatestHomeNewscast, HOME_NEWSCAST_ASSETS_URL } from "../../../packages/content-core/src/home-newscast-source";
import { createHomeNewsletterSnapshot } from "../../../packages/content-core/src/home-service-sources";
import type { SettingsPublicationReceipt } from "../lib/functions";
import { SettingsPublicationStatus } from "../components/SettingsPublicationStatus";
import { PublishedVersionStatus } from "../components/PublishedVersionStatus";
import { ContextualControlsSpecimen } from "./ContextualControlsSpecimen";
import type { HomeShortcutId } from "../lib/home-shortcuts";
import homeSelectionFixture from "../../../site/tests/fixtures/home-v2-selections.json";
import homeCurrentCatalogFixture from "../../../site/tests/fixtures/home-v2-current-catalog.json";
import { homeCatalogJson, readHomeEditorialSourceReceipt } from "../../../packages/content-core/src/home-source-catalog";
import { commentThreads, threadMatches, type CommentFilter } from "../lib/media-comment-threads";
import { HomeShortcuts } from "../components/HomeShortcuts";
import { EditorStructureSpecimen } from "./EditorStructureSpecimen";
import supportLayoutFixture from "../../tests/fixtures/support-page.json";
import { MediaPreviewHeaderSpecimen } from "./MediaPreviewHeaderSpecimen";
import { SiteNavigationSettings } from "../components/SiteNavigationSettings";
import {
  DEFAULT_NJ_DECIDES_SETTINGS,
  DEFAULT_SITE_NAVIGATION,
  SITE_NAVIGATION_SETTINGS_ID,
} from "../../../packages/content-core/src/cms-settings";
import { AnalyticsSurface } from "../routes/AnalyticsRoute";
import { MediaControlsSpecimen } from "./MediaControlsSpecimen";
import { MediaOverlaysSpecimen } from "./MediaOverlaysSpecimen";
import {
  MediaInspectorBulkSpecimen,
  MediaInspectorDockedSpecimen,
  MediaInspectorSpecimen,
  MediaTokenSuggestionsSpecimen,
  VideoViewerInspectorSpecimen,
} from "./MediaInspectorSpecimen";
import { MediaToolbarSpecimen } from "./MediaToolbarSpecimen";
import { MediaTabsSpecimen } from "./MediaTabsSpecimen";
import { MediaTabs } from "../components/media/MediaTabs";
import { mediaTabs } from "../lib/media-tabs";
import { WorkspaceUploadButton } from "../components/media/WorkspaceUploadButton";
import { MediaToolbarPartsSpecimen } from "./MediaToolbarPartsSpecimen";
import { MediaPagingSpecimen } from "./MediaPagingSpecimen";
import { MediaSurfaceToolbarSpecimen } from "./MediaSurfaceToolbarSpecimen";
import { MediaFilterPopoverSpecimen } from "./MediaFilterPopoverSpecimen";
import { MediaDisplayPopoverSpecimen } from "./MediaDisplayPopoverSpecimen";
import { MediaSavedViewsSpecimen } from "./MediaSavedViewsSpecimen";
import { MediaListRowSpecimen, MediaTileSpecimen } from "./MediaTileSpecimen";
import { MediaContextMenuSpecimen, MediaGridKeyboardSpecimen, MediaListLayoutSpecimen, MediaSelectionBarSpecimen } from "./MediaGridSpecimen";
import { QuickLook, type QuickLookItem } from "../components/media/QuickLook";
import { ImageViewerSpecimen } from "./ImageViewerSpecimen";
import { MediaFullViewerSpecimen } from "./MediaFullViewerSpecimen";
import { MediaRefinementSpecimen } from "./MediaRefinementSpecimen";
import { DropOverlay } from "../components/media/DropOverlay";
import { SelectionBar } from "../components/media/SelectionBar";
import { UploadSheet } from "../components/media/UploadSheet";
import {
  UploadTray,
  UploadTrayRows,
  type UploadTrayRow,
} from "../components/media/UploadTray";
import { ScheduleSurface } from "../routes/ScheduleRoute";
import type { BroadcastSchedule } from "../data/broadcast-schedule";
import { analyticsFixture } from "./analytics-fixture";
const loadAnalyticsFixture = async () => analyticsFixture;
const loadAnalyticsPartial = async () => ({ ...analyticsFixture, ga4: { status: "not_configured" as const, message: "GA4 reporting access is pending.", data: null } });
const loadAnalyticsUnavailable = async () => ({ ...analyticsFixture, ga4: { status: "unavailable" as const, message: "Audience reporting is temporarily unavailable.", data: null } });
const loadAnalyticsLimited = async () => {
  const fixture = structuredClone(analyticsFixture);
  fixture.ga4.data!.hasPreviousBaseline = false;
  const edge = fixture.cloudflare.data!;
  edge.complete = false;
  edge.period.start = "2026-08-25";
  edge.daily = edge.daily.filter(row => row.date >= edge.period.start);
  const requests = edge.daily.reduce((total, row) => total + row.requests, 0);
  const bytes = edge.daily.reduce((total, row) => total + row.bytes, 0);
  const cachedRequests = Math.round(requests * 0.7);
  const missing = Math.round(requests * 0.005);
  edge.totals = { requests, bytes, cachedRequests, cacheHitRate: 0.7, errors: 85 };
  edge.statuses = [
    { name: "200", requests: requests - missing - 85 },
    { name: "404", requests: missing },
    { name: "500", requests: 85 },
  ];
  edge.cache = [
    { name: "hit", requests: cachedRequests },
    { name: "miss", requests: requests - cachedRequests },
  ];
  fixture.mailchimp.data!.truncated = true;
  fixture.mailchimp.data!.totalCampaigns = fixture.mailchimp.data!.campaigns.length + 8;
  fixture.mailchimp.data!.growth = fixture.mailchimp.data!.growth.slice(0, 2);
  return fixture;
};
const loadAnalyticsZero = async () => {
  const fixture = structuredClone(analyticsFixture);
  const audience = fixture.ga4.data!, edge = fixture.cloudflare.data!, email = fixture.mailchimp.data!;
  audience.hasPreviousBaseline = false;
  audience.totals = { activeUsers: 0, newUsers: 0, sessions: 0, views: 0, engagedSessions: 0, engagementRate: 0, averageSessionDuration: 0 };
  audience.daily = []; audience.pages = []; audience.channels = []; audience.sources = [];
  audience.landingPages = []; audience.regions = []; audience.countries = []; audience.devices = []; audience.events = [];
  edge.totals = { requests: 0, bytes: 0, cachedRequests: 0, cacheHitRate: 0, errors: 0 };
  edge.daily = []; edge.statuses = []; edge.cache = [];
  email.audience = { subscribed: 0, unsubscribed: 0, cleaned: 0 };
  email.totals = { sent: 0, delivered: 0, uniqueClicks: 0, clickRate: 0, uniqueOpens: 0, openRate: 0, unsubscribes: 0, bounces: 0 };
  email.campaigns = []; email.totalCampaigns = 0; email.growth = [];
  return fixture;
};
function AnalyticsRecoverySpecimen({ failFirst = false }: { failFirst?: boolean }) {
  const [load] = useState(() => {
    let calls = 0;
    return async (_days: number, signal: AbortSignal) => {
      await new Promise(resolve => setTimeout(resolve, 500));
      if (signal.aborted) throw new Error("Request canceled");
      calls += 1;
      if (calls === (failFirst ? 1 : 2)) throw new Error("Synthetic transport failure");
      return analyticsFixture;
    };
  });
  return <AnalyticsSurface load={load} initialDays={30} fixedPeriod preview />;
}
const scheduleFixture: BroadcastSchedule = {
  source: {
    coverageStart: "2026-10-01",
    coverageEnd: "2026-10-07",
    label: "Local broadcast schedule specimen",
    received: "2026-09-16",
    timezone: "America/New_York",
  },
  airings: [
    {
      date: "2026-10-01",
      detailsStatus: "provided",
      episode: "101",
      premiere: true,
      program: "Program one",
      station: "NJ PBS",
      status: "scheduled",
      time: "7 p.m.",
      title: "Guest details provided",
    },
    {
      date: "2026-10-02",
      detailsStatus: "pending",
      episode: "102",
      premiere: false,
      program: "Program two",
      station: "Thirteen",
      status: "preempted",
      time: "8:30 a.m.",
      title: "Details pending",
    },
  ],
};
import { HomeHeroLayoutPreview } from "../components/HomeHeroLayoutPreview";
import { HomeHeroModal } from "../components/HomeHeroModal";
import { HomePreviewFrame } from "../components/HomePreviewFrame";
import { SinglePreviewGallery } from "./SinglePreviewGallery";
import { ContentBrowseWorkspace } from "../components/ContentBrowseWorkspace";
import { WorkspaceActionsProvider } from "../components/WorkspaceActions";
import { OutlineGallery } from "./OutlineGallery";
import { RecordForm } from "../components/RecordForm";
import { HomeHeroEditor } from "../components/HomeHeroEditor";
import type { HomeHeroConfig } from "../../../packages/content-core/src/home-hero";
import { FocalPointControl } from "../components/FocalPointControl";
import { LeaveGuardDialog } from "../routes/LeaveGuardDialog";
import { PremiereConnectPanel } from "../routes/PremiereConnectRoute";
import guideLandscape from "../../../site/public/brand/spotlight/energy-environment.jpg";
import { ContentShelfSources } from "../components/ContentShelfPicker";
import "./gallery-crypto";
import { AsyncActionButton, Button, Panel } from "../components/ui/Primitives";
import { LoadingIndicator } from "../components/ui/LoadingIndicator";
import { BootstrapView } from "../components/BootstrapView";
// The design gallery: every admin surface and state on one page, rendered from the real
// components with mock props.
//
// Why this exists: the live admin requires a verified and approved Firebase identity,
// and several of its most design-sensitive states only appear when something goes wrong --
// a page read that fails, a save composed against content someone else replaced, a role
// with no capability. Reaching those against a real backend means staging failures. Here
// they are one prop.
//
// It needs no Firebase. Every component below either takes its data as props or is the
// presentational half of a container that does (QueueList under QueueTab, UsersTable under
// UsersTab), which is what makes this cheap.
//
// Dev only. vite serves any root-level .html in dev, but `vite build` only emits the inputs
// in rollupOptions.input -- which vite.config.ts leaves at its default of index.html alone.
// So this never reaches admin/dist and never ships. If that config gains an explicit input
// list, this file has to be kept out of it.

import {
  StrictMode,
  lazy,
  Suspense,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { BrowserRouter, createMemoryRouter, MemoryRouter, RouterProvider, useLocation } from "react-router";
import {
  EditorWorkspace,
  type LoadedRecord,
  type PageContent,
  type Surface,
} from "../components/EditorWorkspace";
import { QueueList, type QueueItem } from "../components/QueueList";
import { AccountSettingsRoute } from "../routes/AccountSettingsRoute";
import { NavigationPreferences } from "../components/NavigationPreferences";
import { ReviewQueueList } from "../components/ReviewQueueList";
import type { ReviewQueueItem } from "../lib/review-queue";
import { NewsroomHome, type NewsroomRecord } from "../components/NewsroomHome";
import { RecordList, type RecordListPage } from "../components/RecordList";
import { UsersTableSkeleton } from "../components/UsersTab";
import { ContentStudioSkeleton } from "../components/EditorSkeleton";
import { eligibleNavDestinations } from "../lib/nav-destinations";
import { NAVIGATION_PREFERENCES_VERSION, type NavigationPreferences as StoredNavigationPreferences } from "../lib/navigation-preferences";
import type { CustomNavItem } from "../lib/custom-navigation";
import type { NavigationShare } from "../lib/navigation-shares";
import { UsersTable, type AdminUserRecord } from "../components/UsersTable";
import {
  AdminSettingsForm,
  AdminSettingsFrame,
  PublicWebsiteSettingsSection,
  type BannerSettingsTransport,
  type BannerSettingsValues,
} from "../routes/AdminSettingsRoute";
import {
  CostLedgerSurface,
  type CostLedgerView,
} from "../routes/CostLedgerRoute";
import costLedgerStyles from "../routes/CostLedgerRoute.css?inline";
import {
  PublicHomepageBannerSettings,
  type PublicHomepageBannerSettingsTransport,
  type PublicHomepageBannerValues,
} from "../components/PublicHomepageBannerSettings";
import {
  PublicSiteChromeSettings,
  type PublicSiteChromeSettingsTransport,
  type PublicSiteChromeValues,
} from "../components/PublicSiteChromeSettings";
import type { MutateSettingsResponse } from "../lib/functions";
import type { AdminBlock } from "../lib/block-factory";
import type { ContentRecordSummary } from "../lib/content-records";
import { installPointerFocusTracking } from "../lib/input-modality";
import { selectLibraryRecords } from "../lib/content-library";
import { DEFAULT_CONTENT_QUERY } from "../lib/content-query";
import type {
  BulkArchiveItem,
  BulkArchiveResponse,
  AuditEntry,
  DeleteMediaResponse,
  ListAuditResponse,
  MediaListQuery,
  ListMediaResponse,
  MediaCategoryDefinition,
  MediaAssetSummary,
  PreviewRequestResponse,
  PreviewStatusResponse,
  UploadMediaMetadata,
  UploadMediaResponse,
  UpdateMediaMetadata,
  UpdateMediaMetadataResponse,
} from "../lib/functions";
import type { EditorLockClient } from "../lib/editor-locks";
import type {
  SavedContentView,
  SavedContentViewMutation,
} from "../lib/saved-content-views";
import { can, type Principal } from "../../../packages/content-core/src/rbac";
import type { PublicPageId } from "../../../packages/content-core/src/public-pages";
import { pageCompositionSeed } from "../../../packages/content-core/src/page-composition-seeds";
import { parseBlocks, type RichTextDoc } from "../../../packages/content-core/src/content-model";
import { ShellLayout } from "../routes/ShellLayout";
import { ShellProvider, type ShellData } from "../routes/ShellContext";
import type { RouteHandle } from "../routes/buildRoutes";
import { MediaLibrarySurface } from "../routes/MediaRoute";
import { galleryMediaCorpusLoader } from "./media-corpus-fixture";
import { MediaInspector } from "../components/media/MediaInspector";
import { clearMediaSessionCache } from "../lib/media-session-cache";
import { MediaFavoritesLibrary } from "../routes/MediaFavoritesLibrary";
import type { MediaFavoritePage } from "../lib/media-favorites";
import { MediaCollectionsLibrary } from "../routes/MediaCollectionsLibrary";
import type {
  MediaCollectionItemPage,
  MediaCollectionPage,
  MediaCollectionSummary,
} from "../lib/media-collections";
import { parseMediaWorkspacePath } from "../lib/routes";
import { SourceMediaLibrary } from "../routes/SourceMediaLibrary";
import type { SourceMediaAssetSummary } from "../lib/source-media";
import { MediaUploadForm } from "../components/MediaUploadForm";
import { cmsListMedia, cmsUploadMedia } from "../lib/functions";
import { invalidateMediaLists } from "../lib/media-session-cache";
import "../routes/VoiceoverLibraryRoute.css";
import type { MediaUploadInitialState } from "../components/MediaUploadForm";
import { ActivitySurface } from "../routes/ActivityRoute";
import { MediaPickerDialog, type MediaPickerLoader } from "../components/MediaPickerDialog";
import { FieldRenderer } from "../components/FieldRenderer";
import { BlockEditor } from "../components/BlockEditor";
import { hasServiceCanvas } from "../components/ServiceCanvas";
import { homeCompositionDefaults } from "../../../packages/content-core/src/home-composition";
import type { HomeSourceSnapshot } from "../../../packages/content-core/src/home-rail-render";
import homePrograms from "../../../site/src/data/launch-media-manager.json";
import homeNews from "../../../site/src/data/spotlight-news.json";
import { RichTextEditor } from "../components/RichTextEditor";
import { ControlPresentationProvider } from "../context/ControlPresentationContext";
import { SuccessNoticeProvider } from "../components/ui/SuccessNoticeRegion";
import {
  CONTROL_PRESENTATIONS,
  type ControlPresentation,
} from "../lib/control-presentation";
import type { GallerySpecimen } from "../lib/visual-specimens";
import { normalizeGeneratedIds } from "../lib/visual-id-normalization";
import type {
  EditorField,
  RecordKind,
  SectionId,
} from "../../../packages/content-core/src/editor-admin";
import "../styles.css";
import "../content-scan-flow.css";
import "../cms-workspace.css";
// The same stylesheets as strings, to copy into each specimen's shadow root. The side-effect
// imports above still run: they put the production rules and token layer on the document, and CSS
// custom properties inherit across the shadow boundary. The copies carry the class rules each
// specimen needs inside its own tree.
import stylesText from "../styles.css?inline";
import mediaRouteStylesText from "../routes/MediaRoute.css?inline";
import contentScanFlowStylesText from "../content-scan-flow.css?inline";
import workspaceStylesText from "../cms-workspace.css?inline";
import dropOverlayStylesText from "../components/media/DropOverlay.css?inline";
import uploadSheetStylesText from "../components/media/UploadSheet.css?inline";
import uploadTrayStylesText from "../components/media/UploadTray.css?inline";

// ---------------------------------------------------------------------------
// Fixtures
//
// The Home specimen uses the same empty fixed-frame seed as the real editor, then supplies one
// stored manual shelf. A visual review therefore exercises the exact Home-owned block without
// presenting the cinematic public frame as ordinary editable content.
// ---------------------------------------------------------------------------

const HOME_COMPOSITION = pageCompositionSeed("home");
if (!HOME_COMPOSITION) throw new Error("Missing Home composition seed");
const HOME_EDITOR_BLOCKS: AdminBlock[] = [
  {
    id: "gallery-home-shelf",
    type: "promotion_playlist",
    order: 0,
    visible: true,
    data: {
      title: "New Jersey favorites",
      placement: "before_featured",
      cards: [
        {
          itemId: "garden-state-stories",
          title: "Garden State Stories",
          summary: "People and places from across New Jersey.",
          imageAssetId: "media-garden-state",
          alt: "Garden State Stories program artwork",
          href: "https://watch.njpbs.org/",
        },
        {
          itemId: "nj-spotlight-news",
          title: "NJ Spotlight News",
          summary: "Reporting on the issues that affect New Jersey.",
          imageAssetId: "media-local-news",
          alt: "NJ Spotlight News program artwork",
          href: "https://www.njspotlightnews.org/",
        },
        {
          itemId: "pbs-passport",
          title: "PBS Passport",
          summary: "Stream more programs with the member benefit.",
          imageAssetId: "media-garden-state",
          alt: "PBS Passport program artwork",
          href: "https://watch.njpbs.org/passport/learn-more/",
        },
      ],
    },
  },
];

// Gallery specimens can rerender their fixture wrapper while EditorWorkspace hydrates. Keep
// the addressed page surface referentially stable so that hydration does not restart merely
// because JSX allocated an equivalent object again (#1140).
const HOME_PAGE_SURFACE: Surface = {
  kind: "page",
  pageId: "home",
  section: "home",
};

const STAFF_PAGE_SURFACE: Surface = {
  kind: "page",
  pageId: "staff",
  section: "genericPage",
};

const superAdmin: Principal = { id: "sa", grants: [{ role: "super_admin" }] };
const editor: Principal = {
  id: "ed",
  grants: [{ role: "editor", sections: ["news"], registeredMediaSections: ["news"] }],
};
const contributor: Principal = {
  id: "co",
  grants: [{ role: "contributor", sections: ["news"], registeredMediaSections: ["news"] }],
};
const readOnly: Principal = { id: "ro", grants: [] };
const CONTRIBUTOR_REQUIRED_NAVIGATION = {
  custom: [],
  version: NAVIGATION_PREFERENCES_VERSION,
  order: eligibleNavDestinations(contributor).map(
    (destination) => destination.id,
  ),
  hidden: eligibleNavDestinations(contributor)
    .filter((destination) => destination.required !== true)
    .map((destination) => destination.id),
};

const STATION_REFERENCE: CustomNavItem = {
  id: "custom:external",
  kind: "link",
  label: "Station reference",
  icon: "link",
  destination: { kind: "url", url: "https://example.test/station" },
};

const CUSTOM_NAVIGATION_FIXTURE: StoredNavigationPreferences = {
  version: 4,
  order: ["home", "custom:external", "custom:post", "custom:section"],
  hidden: [],
  custom: [
    STATION_REFERENCE,
    { id: "custom:post", kind: "link", label: "Sample post", icon: "file", destination: { kind: "post", id: "sample-post" } },
    { id: "custom:section", kind: "section", label: "My desk", icon: "folder", links: [
      { id: "custom:home", kind: "link", label: "Edit home page", destination: { kind: "page", id: "home" } },
      { id: "custom:pages", kind: "link", label: "Page directory", destination: { kind: "url", url: "/content" } },
    ] },
  ],
};

const SHARED_ACCOUNT_NAVIGATION: StoredNavigationPreferences = {
  ...CUSTOM_NAVIGATION_FIXTURE,
  order: [...CUSTOM_NAVIGATION_FIXTURE.order, "custom:handbook"],
  shared: ["custom:handbook", "custom:retired"],
};

const SHARED_ACCOUNT_SHARES: NavigationShare[] = [
  {
    id: "custom:external",
    ownerUid: "sa",
    ownerName: "Jordan Avery",
    status: "active",
    item: STATION_REFERENCE,
  },
  {
    id: "custom:handbook",
    ownerUid: "ed",
    ownerName: "Sample editor",
    status: "active",
    item: { id: "custom:handbook", kind: "link", label: "Newsroom handbook", icon: "link", destination: { kind: "url", url: "https://example.test/handbook" } },
  },
  {
    id: "custom:notes",
    ownerUid: "ed",
    ownerName: "Sample editor",
    status: "active",
    item: { id: "custom:notes", kind: "link", label: "Desk notes", icon: "file", destination: { kind: "url", url: "/resources" } },
  },
  {
    id: "custom:retired",
    ownerUid: "ed",
    ownerName: "Sample editor",
    status: "removed",
    removedReason: "unshared",
    item: { id: "custom:retired", kind: "link", label: "Old bulletin", icon: "file", destination: { kind: "url", url: "https://example.test/bulletin" } },
  },
];

function SharedOwnerRemovalGallery() {
  const [removed, setRemoved] = useState(false);
  const shares = SHARED_ACCOUNT_SHARES.map((share): NavigationShare => (
    removed && share.ownerUid === "ed" && share.status === "active"
      ? { ...share, status: "removed", removedReason: "owner_removed" }
      : share
  ));
  return <>
    <button type="button" disabled={removed} onClick={() => setRemoved(true)}>Simulate owner losing staff access</button>
    <ShellSpecimen initialEntry="/account/settings" navigation={SHARED_ACCOUNT_NAVIGATION} navigationShares={shares} />
  </>;
}

const SERVICE_COMPOSITION_PAGES = [
  { id: "watch", label: "Watch NJ PBS" },
  { id: "live", label: "PBS Livestream" },
  { id: "kids", label: "Kids" },
  { id: "support", label: "Support NJ PBS" },
  { id: "give", label: "Give to NJ PBS" },
  { id: "passport", label: "NJ PBS Passport" },
  { id: "about", label: "About NJ PBS" },
] as const satisfies readonly { id: PublicPageId; label: string }[];

function ServiceCompositionGallery() {
  const [pageId, setPageId] = useState<PublicPageId>("live");
  return (
    <div style={{ display: "grid", gap: "var(--space-4)" }}>
      <label className="field-label" style={{ maxWidth: "20rem" }}>
        Populated service page
        <select
          className="field-control"
          value={pageId}
          onChange={(event) => setPageId(event.target.value as PublicPageId)}
        >
          {SERVICE_COMPOSITION_PAGES.map((page) => (
            <option key={page.id} value={page.id}>
              {page.label}
            </option>
          ))}
        </select>
      </label>
      <EditorWorkspace
        key={pageId}
        principal={superAdmin}
        loadPage={loadServiceComposition}
        savePage={saveOk}
        savePageMetadata={saveMetadataOk}
        loadMedia={loadGalleryMedia}
        newId={galleryIds}
        surface={{ kind: "page", pageId, section: "programLanding" }}
      />
    </div>
  );
}

// Start `npm --prefix site run preview -- --host 127.0.0.1 --port 4321`
// before opening the ready-page specimen, then click Build preview. This keeps
// the gallery on the real PagePreview component and frames a real locally built
// public route without needing Firebase, GitHub, Cloudflare, or a fake renderer.
const requestGalleryPreview = async (
  pageId: string,
): Promise<PreviewRequestResponse> => ({
  success: true,
  queueId: "gallery-preview",
  pageId,
  sourceVersion: 7,
  dispatched: true,
  status: "building",
});

const loadGalleryPreviewStatus = async (): Promise<PreviewStatusResponse> => ({
  success: true,
  queueId: "gallery-preview",
  status: "ready",
  pageId: "home",
  sourceVersion: 7,
  previewUrl: "http://127.0.0.1:4321",
  error: null,
  requestedAt: "2026-07-23T12:00:00.000Z",
  completedAt: "2026-07-23T12:01:00.000Z",
  // Relative, not a fixed date: a hard-coded expiry silently turns this specimen into the
  // expired state once that date passes, and the ready state stops being reviewable at all.
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
});

const LOCKED_EDITOR_CLIENT: EditorLockClient = {
  subscribe: (surfaceKey, onLock) => {
    onLock({
      surfaceKey,
      ownerId: "fixture-editor",
      ownerName: "Jordan Editor",
      sessionId: "gallery-remote-session",
      acquiredAtMs: Date.now() - 60_000,
      heartbeatAtMs: Date.now(),
      observedAtMs: globalThis.performance.now(),
    });
    return () => {};
  },
  claim: async (surfaceKey, actor, sessionId) => ({
    status: "acquired",
    lock: {
      surfaceKey,
      ownerId: actor.id,
      ownerName: actor.name,
      sessionId,
      acquiredAtMs: Date.now(),
      heartbeatAtMs: Date.now(),
      observedAtMs: globalThis.performance.now(),
    },
  }),
  heartbeat: async () => true,
  release: async () => {},
  requestTakeover: async () => true,
  clearRequest: async () => {},
};

const HOME_RECORDS: NewsroomRecord[] = [
  {
    id: "post-transit",
    kind: "post",
    title: "Transit funding explained",
    status: "in_review",
    version: 2,
    updatedAt: "2026-07-20T14:00:00.000Z",
    updatedBy: "sa",
    assignee: "sa",
  },
  {
    id: "event-screening",
    kind: "event",
    title: "Community screening",
    status: "scheduled",
    version: 3,
    updatedAt: "2026-07-20T13:00:00.000Z",
  },
  {
    id: "program-garden-state",
    kind: "program",
    title: "Garden State Stories",
    status: "draft",
    version: 4,
    updatedAt: "2026-07-19T12:00:00.000Z",
    assignee: "ed",
  },
];

const HOME_SELECTION = selectLibraryRecords(
  HOME_RECORDS,
  DEFAULT_CONTENT_QUERY,
  "sa",
);

const LIBRARY_RECORDS: ContentRecordSummary[] = [
  {
    ...HOME_RECORDS[0]!,
    status: "approved",
    version: 12,
    liveSourceVersion: 8,
  },
  ...HOME_RECORDS.slice(1),
  {
    // One retired-kind row (#1039): the library must name a stored Article
    // honestly and refuse to link it to an editor that no longer exists.
    id: "article-water-quality",
    kind: "article",
    title: "What the new water tests show",
    status: "published",
    version: 5,
    updatedAt: "2026-07-18T18:30:00.000Z",
    updatedBy: "ed",
  },
  {
    id: "staff-ada-rivera",
    kind: "staff",
    title: "Ada Rivera",
    status: "published",
    version: 6,
    updatedAt: "2026-07-17T09:15:00.000Z",
    updatedBy: "sa",
  },
  {
    id: "newsletter-weekend",
    kind: "newsletter",
    title: "This weekend on NJ PBS",
    status: "archived",
    version: 7,
    updatedAt: "2026-07-16T17:00:00.000Z",
    updatedBy: "sa",
  },
];

const REVIEW_REQUESTS: ReviewQueueItem[] = [
  {
    requestId: `review_${"a".repeat(64)}`,
    recordId: "post-station-update",
    title: "Station update: what changes on July 1",
    state: "in_review",
    collection: "cmsPosts",
    contentType: "post",
    sourceVersion: 4,
    requestedByLabel: "Blake Sutton",
    requestedAt: "2026-08-18T15:12:00.000Z",
    assigneeLabel: "Jordan Avery",
    recovered: false,
  },
  {
    // A headline at the length newsroom copy actually runs to, so the queue's content column is
    // reviewed against real wrapping rather than against a two-word page name (#1036).
    requestId: `review_${"c".repeat(64)}`,
    recordId: "post-delaney-hall",
    title:
      "What the new water tests show about Delaney Hall and the towns downstream",
    state: "in_review",
    collection: "cmsPosts",
    contentType: "post",
    sourceVersion: 2,
    requestedByLabel: "Sam Morgan",
    requestedAt: "2026-08-18T13:05:00.000Z",
    assigneeLabel: "Blake Sutton",
    recovered: false,
  },
  {
    requestId: `review_${"b".repeat(64)}`,
    recordId: "home",
    title: "Homepage",
    state: "in_review",
    collection: "cmsPages",
    contentType: "page",
    sourceVersion: 11,
    requestedByLabel: "Sam Morgan",
    requestedAt: "2026-08-18T09:40:00.000Z",
    assigneeLabel: null,
    recovered: false,
  },
];

const QUEUE_ITEMS: QueueItem[] = [
  {
    id: "q1",
    status: "success",
    triggeredBy: "account-3@example.org",
    changes: ["Home page"],
    timestamp: new Date("2026-07-16T21:40:00"),
  },
  {
    id: "q2",
    status: "publishing",
    triggeredBy: "account-22@example.org",
    changes: ["Program landing page", "Content page"],
    timestamp: new Date("2026-07-16T21:12:00"),
  },
  {
    id: "q3",
    status: "failed",
    triggeredBy: "account-3@example.org",
    changes: ["Home page"],
    timestamp: new Date("2026-07-16T18:03:00"),
  },
  {
    id: "q4",
    status: "pending",
    triggeredBy: "account-4@example.org",
    changes: ["Content page"],
    timestamp: new Date("2026-07-15T09:30:00"),
  },
];

const USERS: AdminUserRecord[] = [
  {
    id: "u1",
    email: "account-3@example.org",
    displayName: "Jordan Avery",
    role: "super_admin",
    grants: [{ role: "super_admin" }],
  },
  {
    id: "u2",
    email: "account-22@example.org",
    displayName: "Sam Morgan",
    role: "admin",
    grants: [{ role: "admin" }],
  },
  {
    id: "u3",
    email: "account-4@example.org",
    displayName: "Blair Harper",
    role: null,
    grants: [{ role: "editor", sections: ["news"] }],
  },
  {
    id: "u4",
    email: "account-12@example.org",
    displayName: "Parker Reed",
    role: null,
    grants: [],
  },
] as AdminUserRecord[];

// ---------------------------------------------------------------------------
// Mock injections. Each one stages a state that is otherwise awkward to reach.
// ---------------------------------------------------------------------------

const loadReady = async (): Promise<PageContent> => ({
  blocks: HOME_EDITOR_BLOCKS,
  metadata: HOME_COMPOSITION.metadata,
  expectedAbsent: true,
});
const loadSavedDraft = async (pageId: PublicPageId): Promise<PageContent> => {
  const seed = pageCompositionSeed(pageId);
  if (!seed) throw new Error(`Missing ${pageId} composition seed`);
  return {
    blocks: seed.blocks as AdminBlock[],
    metadata: seed.metadata,
    createdBy: "sa",
    status: "draft",
    version: 4,
  };
};
const loadServiceComposition = async (
  pageId: PublicPageId,
): Promise<PageContent> => {
  const seed = pageCompositionSeed(pageId);
  if (!seed) throw new Error(`Missing ${pageId} composition seed`);
  return {
    blocks: seed.blocks as AdminBlock[],
    metadata: seed.metadata,
    expectedAbsent: true,
  };
};
const loadEmpty = async (): Promise<PageContent> => ({
  blocks: [],
  version: 1,
});
const STAFF_AUTHORED_BLOCKS: AdminBlock[] = [
  {
    id: "staff-authored-heading",
    type: "headline",
    visible: true,
    order: 0,
    data: { text: "How to reach the newsroom", level: 2 },
  },
  {
    id: "staff-authored-copy",
    type: "prose",
    visible: true,
    order: 1,
    data: {
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "Use the contact page for viewer questions. Profiles on this page include only public information.",
              },
            ],
          },
        ],
      },
    },
  },
];
function staffPageContent(kind: "empty" | "blocks" | "readonly"): PageContent {
  const seed = pageCompositionSeed("staff")!;
  const longCopy = kind !== "empty";
  return {
    blocks: kind === "empty" ? [] : structuredClone(STAFF_AUTHORED_BLOCKS),
    metadata: {
      ...seed.metadata,
      ...(longCopy
        ? {
            title: "Staff and community partners across New Jersey public media",
            description:
              "Meet the people who make NJ PBS. Each profile includes only the public information the staff member or an authorized editor has chosen to publish, including role, biography, and public contact links.",
          }
        : {}),
    },
    createdBy: "sa",
    status: kind === "readonly" ? "in_review" : "draft",
    version: 4,
  };
}
function StaffPageGallery({ kind }: { kind: "empty" | "blocks" | "readonly" }) {
  return (
    <EditorWorkspace
      principal={superAdmin}
      loadPage={async () => staffPageContent(kind)}
      savePage={saveOk}
      savePageMetadata={saveMetadataOk}
      loadMedia={loadGalleryMedia}
      requestPagePreview={requestGalleryPreview}
      loadPagePreviewStatus={loadGalleryPreviewStatus}
      newId={galleryIds}
      surface={STAFF_PAGE_SURFACE}
    />
  );
}
const loadNever = (): Promise<PageContent> => new Promise(() => {});
const loadFails = async (): Promise<PageContent> => {
  throw new Error("Missing or insufficient permissions.");
};
const saveConflicts = async (): Promise<PageContent> => {
  // A 409 is what the editor reads as "someone replaced this while you had it open"
  // (lib/functions.ts checks error.status === 409).
  throw Object.assign(new Error("This document changed since you opened it."), {
    status: 409,
  });
};
const saveOk = async (
  _pageId: unknown,
  _section: unknown,
  blocks: AdminBlock[],
): Promise<PageContent> => ({
  blocks,
  version: 2,
});
const saveMetadataOk = async (
  _pageId: unknown,
  _section: unknown,
  metadata: Record<string, unknown>,
): Promise<PageContent> => ({
  blocks: HOME_EDITOR_BLOCKS,
  metadata,
  version: 2,
});
// A specimen long enough to show the bounded typed list actually paging (#1066): three
// server-sized pages of sponsors, sliced here the way cmsListContent slices them.
const GALLERY_SPONSOR_PAGE_SIZE = 25;
const GALLERY_SPONSORS = Array.from({ length: 63 }, (_, index) => ({
  id: `sponsor-${index + 1}`,
  title: `${["New Jersey Community Foundation", "Garden State Arts Council", "Delaware River Partners"][index % 3]} ${index + 1}`,
  status: ["published", "in_review", "draft"][index % 3],
  updatedAt: `2026-07-${String(19 - (index % 18)).padStart(2, "0")}T14:30:00.000Z`,
}));
const listSponsors = async (_kind: RecordKind, page: number) => {
  const pageCount = Math.ceil(
    GALLERY_SPONSORS.length / GALLERY_SPONSOR_PAGE_SIZE,
  );
  const safePage = Math.min(Math.max(page, 1), pageCount);
  const start = (safePage - 1) * GALLERY_SPONSOR_PAGE_SIZE;
  return {
    records: GALLERY_SPONSORS.slice(start, start + GALLERY_SPONSOR_PAGE_SIZE),
    page: safePage,
    pageCount,
    total: GALLERY_SPONSORS.length,
  };
};
const loadSponsor = async (): Promise<LoadedRecord> => ({
  status: "ready",
  record: {
    id: "sponsor-nj-foundation",
    type: "sponsor",
    version: 4,
    name: "New Jersey Community Foundation",
    href: "https://example.org/foundation",
    status: "published",
    assignee: "sa",
  },
});
const GALLERY_POST_RECORD: Record<string, unknown> = {
  id: "post-station-update",
  type: "post",
  version: 12,
  title: "Station update",
  summary: "A newsroom update prepared for review.",
  date: "2026-08-19",
  tags: ["newsroom"],
  slug: "station-update",
  previousSlugs: [],
  locale: "en",
  status: "approved",
  publiclyVisible: true,
  published: { sourceVersion: 8 },
  assignee: "ed",
  blocks: [],
};
const loadPost = async (): Promise<LoadedRecord> => ({
  status: "ready",
  record: GALLERY_POST_RECORD,
});
const MOBILE_POST_BLOCKS: AdminBlock[] = [
  {
    id: "mobile-post-image",
    type: "image",
    order: 0,
    visible: true,
    data: {
      assetId: "media-garden-state",
      alt: "Garden State Stories program artwork",
      caption: "A program image with a caption that stays inside the writing canvas.",
    },
  },
  {
    id: "mobile-post-text",
    type: "prose",
    order: 1,
    visible: true,
    data: {
      content: {
        type: "doc",
        content: [{
          type: "paragraph",
          content: [{
            type: "text",
            text: "A newsroom article follows the image. Contact newsroom@example.org for more information.",
          }],
        }],
      },
    },
  },
];
const publishGalleryPost = async () => ({
  document: {
    ...GALLERY_POST_RECORD,
    status: "published",
    version: 13,
    published: { sourceVersion: 13 },
  },
});
const scheduleGalleryPost = async () => ({
  document: {
    ...GALLERY_POST_RECORD,
    status: "scheduled",
    version: 13,
  },
});
const loadArchivedPost = async (): Promise<LoadedRecord> => ({
  status: "ready",
  record: {
    ...GALLERY_POST_RECORD,
    title: "Archived station update",
    status: "archived",
    version: 5,
    publiclyVisible: false,
  },
});
const saveSponsor = async (
  _kind: unknown,
  record: Record<string, unknown>,
) => ({
  ...record,
  version: 5,
});
// A stored event whose end time is a bare calendar day. The date-time control cannot show one,
// and the publish gate cannot read one, so this is the state #850 exists for: the field says
// what it is holding and offers the way out, instead of rendering blank while the value rides
// along through every save.
const loadLegacyEvent = async (): Promise<LoadedRecord> => ({
  status: "ready",
  record: {
    id: "event-screening",
    type: "event",
    version: 3,
    title: "Community screening",
    startsAt: "2026-09-12T23:00:00.000Z",
    endsAt: "2026-09-12",
    location: "Montclair, NJ",
    description: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "A free screening and conversation with the producers, open to the public.",
            },
          ],
        },
      ],
    },
    status: "draft",
  },
});
const saveEvent = async (_kind: unknown, record: Record<string, unknown>) => ({
  ...record,
  version: 4,
});
const loadAssignableStaff = async () => [
  { id: "sa", label: "Sue Super (sue@example.org)" },
  { id: "ed", label: "Evan Editor (evan@example.org)" },
];
const assignSponsor = async (request: {
  id: string;
  baseVersion: number;
  assignee: string | null;
}) => ({
  id: request.id,
  type: "sponsor",
  version: request.baseVersion + 1,
  name: "New Jersey Community Foundation",
  href: "https://example.org/foundation",
  status: "published",
  assignee: request.assignee,
  updatedBy: "sa",
});
const assignPost = async (request: {
  id: string;
  baseVersion: number;
  assignee: string | null;
}) => ({
  ...GALLERY_POST_RECORD,
  id: request.id,
  version: request.baseVersion + 1,
  assignee: request.assignee,
  updatedBy: "sa",
});
const transitionGalleryPost: NonNullable<
  ComponentProps<typeof EditorWorkspace>["transitionContent"]
> = async (request) => ({
  success: true,
  collection: request.collection,
  id: request.id,
  action: request.action,
  fromStatus: "draft",
  toStatus: "in_review",
  version: request.baseVersion + 1,
  document: {
    ...GALLERY_POST_RECORD,
    status: "in_review",
    version: request.baseVersion + 1,
  },
});
const loadSavedLibraryViews = async (): Promise<SavedContentView[]> => [
  {
    id: "review-queue",
    name: "Review queue",
    query: "sort=updatedAt&status=in_review&v=1",
  },
];
const mutateLibraryViews = async (
  mutation: SavedContentViewMutation,
): Promise<SavedContentView[]> => {
  const current = await loadSavedLibraryViews();
  return mutation.type === "add"
    ? [...current, mutation.view]
    : current.filter((view) => view.id !== mutation.id);
};

const saveNever = (): Promise<PageContent> => new Promise(() => {});
const archiveLibraryRecords = async (
  items: BulkArchiveItem[],
): Promise<BulkArchiveResponse> => {
  const outcomes = items.map((item, index) =>
    index === 1
      ? { id: item.id, status: "conflict" as const }
      : {
          id: item.id,
          status: "archived" as const,
          version: item.baseVersion + 1,
        },
  );
  return {
    success: true,
    outcomes,
    counts: {
      archived: outcomes.filter((outcome) => outcome.status === "archived")
        .length,
      already_archived: 0,
      conflict: outcomes.filter((outcome) => outcome.status === "conflict")
        .length,
      missing: 0,
      failed: 0,
    },
  };
};

// Public documentation captures use local artwork and sample account details.
// Keep existing visual-regression fixtures unchanged outside this opt-in mode.
const guideCapture = new URLSearchParams(window.location.search).get("guide") === "1";
const GALLERY_MEDIA: MediaAssetSummary[] = [
  {
    id: "media-garden-state",
    name: "Garden State Stories",
    originalName: "garden-state-stories.jpg",
    category: "programs",
    categories: ["programs"],
    tags: ["program", "New Jersey"],
    description: "Program artwork for Garden State Stories.",
    altText: "Garden State Stories program artwork",
    license: "PBS distribution",
    credit: "PBS",
    mimeType: "image/jpeg",
    kind: "image",
    sizeBytes: 684_221,
    width: 1_920,
    height: 1_080,
    url: guideCapture ? guideLandscape : "https://image.pbs.org/contentchannels/m3L1qFK-show-mezzanine16x9-Uyjvdy5.jpg",
    lifecycle: "active",
    version: 4,
    etag: '"media.bWVkaWEtZ2FyZGVuLXN0YXRl.4"',
    createdAt: "2026-08-10T14:00:00.000Z",
    createdBy: "ed",
    updatedAt: "2026-08-13T12:10:00.000Z",
    updatedBy: "ed",
  },
  {
    id: "media-local-news",
    name: "NJ Spotlight News",
    originalName: "nj-spotlight-news.jpg",
    category: "news",
    categories: ["news", "programs"],
    tags: ["news", "daily"],
    description: "Daily newsroom program artwork.",
    altText: "NJ Spotlight News program artwork",
    license: "PBS distribution",
    credit: "NJ PBS",
    mimeType: "image/jpeg",
    kind: "image",
    sizeBytes: 512_884,
    width: 1_920,
    height: 1_080,
    url: guideCapture ? guideLandscape : "https://image.pbs.org/contentchannels/xU29P1C-show-mezzanine16x9-kJ3DjLB.jpg",
    lifecycle: "active",
    version: 2,
    etag: '"media.bWVkaWEtbG9jYWwtbmV3cw.2"',
    createdAt: "2026-08-11T13:00:00.000Z",
    createdBy: "ed",
    updatedAt: "2026-08-13T11:40:00.000Z",
    updatedBy: "ed",
  },
  {
    id: "media-brand-guide",
    name: "NJ PBS brand guide",
    originalName: "njpbs-brand-guide.pdf",
    category: "brand",
    categories: ["brand"],
    tags: ["brand", "standards"],
    description: "Current station identity and usage guide.",
    altText: null,
    license: "NJ PBS owned",
    credit: "NJ PBS",
    mimeType: "application/pdf",
    kind: "document",
    sizeBytes: 2_862_100,
    width: null,
    height: null,
    url: "https://media.njpbs.org/njpbs-brand-guide.pdf",
    lifecycle: "active",
    version: 1,
    etag: '"media.bWVkaWEtYnJhbmQtZ3VpZGU.1"',
    createdAt: "2026-08-12T16:00:00.000Z",
    createdBy: "sa",
    updatedAt: "2026-08-12T16:00:00.000Z",
    updatedBy: "sa",
  },
];

const GALLERY_MEDIA_CATEGORIES: MediaCategoryDefinition[] = [
  ["news", "News", true],
  ["programs", "Programs", false],
  ["brand", "Brand", false],
].map(([id, label, canUpload], order) => ({
  id: String(id),
  label: String(label),
  description: `${label} media`,
  order: (order + 1) * 10,
  active: true,
  reserved: false,
  version: 1,
  etag: `"media-category.${id}.1"`,
  canUpload: Boolean(canUpload),
  canManage: id === "news",
  createdAt: null,
  createdBy: null,
  updatedAt: null,
  updatedBy: null,
}));

const EDITOR_GALLERY_MEDIA = GALLERY_MEDIA.filter((asset) => {
  const resource = { section: asset.category };
  return (
    can(editor, "media.upload", resource) ||
    can(editor, "media.manage", resource)
  );
});

const GALLERY_ACTIVITY: AuditEntry[] = [
  {
    id: "activity-save",
    actorUid: "ed",
    actorEmail: "account-8@example.org",
    action: "cms.save",
    target: "cmsPages/home",
    before: { status: "draft", version: 6 },
    after: { status: "in_review", version: 7 },
    source: "admin.njpbs.org",
    at: "2026-08-13T16:15:00.000Z",
    resolved: {
      action: { code: "cms.save", label: "Content saved", known: true },
      actor: {
        label: "Sample Editor",
        status: "active",
        email: "account-8@example.org",
        uid: "ed",
      },
      target: {
        label: "Home",
        type: "Page",
        status: "found",
        id: "cmsPages/home",
      },
      source: { label: "Admin app", detail: "admin.njpbs.org" },
    },
  },
  {
    id: "activity-role-grant",
    actorUid: "sa",
    actorEmail: "account-3@example.org",
    action: "roles.grant",
    target: "users/account-8@example.org",
    before: null,
    after: { role: "editor", sections: ["news"] },
    source: "admin.njpbs.org",
    at: "2026-08-13T15:45:00.000Z",
    resolved: {
      action: { code: "roles.grant", label: "Role granted", known: true },
      actor: {
        label: "Jordan Avery",
        status: "active",
        email: "account-3@example.org",
        uid: "sa",
      },
      target: {
        label: "Sample Editor",
        type: "Staff account",
        status: "found",
        id: "users/ed",
      },
      source: { label: "Admin app", detail: "admin.njpbs.org" },
    },
  },
];

const loadGalleryActivity = async (): Promise<ListAuditResponse> => ({
  success: true,
  entries: GALLERY_ACTIVITY,
  nextCursor: null,
});

const loadEmptyGalleryActivity = async (): Promise<ListAuditResponse> => ({
  success: true,
  entries: [],
  nextCursor: null,
});

const loadPendingGalleryActivity = (): Promise<ListAuditResponse> =>
  new Promise(() => {});

const loadFailedGalleryActivity = async (): Promise<ListAuditResponse> => {
  throw new Error("Audit service unavailable");
};

const queryGalleryMedia = async (
  query: MediaListQuery,
  availableMedia: readonly MediaAssetSummary[] = GALLERY_MEDIA,
): Promise<ListMediaResponse> => {
  const search = query.q.toLocaleLowerCase("en-US");
  const records = availableMedia.filter(
    (asset) =>
      asset.kind !== "audio" &&
      (query.kinds.length === 0 || query.kinds.includes(asset.kind)) &&
      (query.categories.length === 0 ||
        query.categories.includes(asset.category)) &&
      (search === "" ||
        [asset.id, asset.name, asset.originalName, asset.credit, ...asset.tags]
          .filter((value): value is string => typeof value === "string")
          .join(" ")
          .toLocaleLowerCase("en-US")
          .includes(search)),
  );
  return {
    success: true,
    records,
    total: records.length,
    allCount: availableMedia.length,
    page: 1,
    pageCount: 1,
    categoryCounts: availableMedia.reduce<Record<string, number>>(
      (counts, asset) => ({
        ...counts,
        [asset.category]: (counts[asset.category] ?? 0) + 1,
      }),
      {},
    ),
    kindCounts: {
      image: availableMedia.filter((asset) => asset.kind === "image").length,
      document: availableMedia.filter((asset) => asset.kind === "document")
        .length,
    },
  };
};

const loadGalleryMedia: MediaPickerLoader = query => queryGalleryMedia(query);

// Cursor response fixtures exercise the production shared surfaces without live credentials.
const loadIndexedGalleryMedia = async (query: MediaListQuery): Promise<ListMediaResponse> => {
  if (query.assetIds) return loadGalleryMedia(query);
  const images = GALLERY_MEDIA.filter(asset => asset.kind === "image");
  const records = Array.from({ length: 3 }, (_, index) => ({
    ...images[index % images.length], id: `indexed-gallery-${index}`, name: `Station image ${index + 1}`,
  }));
  const continuing = !query.cursor;
  const empty = query.q === "empty" || (!continuing && query.q === "tail");
  return {
    success: true, paging: "cursor", records: empty ? [] : continuing ? records.slice(0, 2) : records.slice(2),
    nextCursor: continuing ? "G".repeat(32) : null,
    total: continuing ? null : query.q === "empty" ? 0 : query.q === "tail" ? 2 : 3,
    allCount: null, page: query.page, pageCount: null, categoryCounts: null, kindCounts: null,
  };
};

const loadEditorGalleryMedia = (query: MediaListQuery) =>
  queryGalleryMedia(query, EDITOR_GALLERY_MEDIA);

const GALLERY_CONTAINMENT_BLOCK: AdminBlock = {
  id: "gallery-containment",
  type: "image_gallery",
  order: 0,
  visible: true,
  data: {
    images: Array.from({ length: 12 }, (_, index) => ({
      assetId: GALLERY_MEDIA[index % 2].id,
      alt: `Gallery containment image ${index + 1}`,
      altDecorative: false,
      caption: `Caption ${index + 1}`,
    })),
  },
};

// The same twelve items in the carousel presentation (#1034), so the scrolling row can be
// reviewed at width, at 320 pixels, and at zoom beside the grid it is an alternative to.
const GALLERY_CAROUSEL_BLOCK: AdminBlock = {
  ...GALLERY_CONTAINMENT_BLOCK,
  id: "gallery-carousel",
  data: { ...GALLERY_CONTAINMENT_BLOCK.data, presentation: "carousel" },
};

// The two dynamic blocks (#1046) in a content page's editor. This is where the parity
// claim is checked by eye: the surface below each block's fields is renderBlock's own
// output over the committed catalog, so what is on screen here is what the build
// publishes. The playlist is included precisely because it resolves to nothing today --
// the approved video library ships empty until per-asset rights and caption metadata are
// sourced -- and an empty shelf is a state an editor has to be able to recognize.
const TOPIC_SHELF_BLOCK: AdminBlock = {
  id: "topic-shelf-1",
  type: "topic_shelf",
  order: 0,
  visible: true,
  data: {
    title: "More on Delaney Hall",
    topic: "delaney-hall",
    source: "njpbs_related_index",
    itemLimit: 4,
    sort: "newest",
    pinned: [],
  },
};

const VIDEO_PLAYLIST_BLOCK: AdminBlock = {
  id: "video-playlist-1",
  type: "video_playlist",
  order: 1,
  visible: true,
  data: {
    title: "Watch: immigration",
    topic: "immigration",
    library: "njpbs_watch",
    itemLimit: 4,
    sort: "newest",
    pinned: [],
  },
};

const homeCanvasBlocks = homeCompositionDefaults() as AdminBlock[];
// Committed gallery data, already shaped as public cards. Do not import the
// Astro loader: isolated Admin checks do not install the site's dependencies.
const homeCanvasSources: HomeSourceSnapshot = {
  heroCatalog: [{ id: "gallery-hero-post", source: "cms_posts", title: "Explore the Garden State", summary: "Local gallery fixture",
    image: { url: "https://example.test/hero-artwork.svg", width: 1600, height: 900 },
    href: "/posts/explore-the-garden-state/", categories: [], tags: [], byline: "Gallery reporter" }],
  schemaVersion: 1,
  publication: { buildBatchId: "gallery-home", generation: 1, commitSha: "0".repeat(40) },
  pbs: {
    source: "media-manager", checkedAt: homePrograms.checkedAt,
    featured: homePrograms.cards.slice(0, 8), more: homePrograms.cards.slice(8, 24),
  },
  spotlight: { source: "spotlight-rss", checkedAt: homeNews.checkedAt, cards: homeNews.cards.slice(0, 8) },
};
const loadHomeCanvasSources = async () => homeCanvasSources;
const unavailableHomeCanvasSources = async () => { throw new Error("The published Home cards could not be loaded. Your page edits are still available."); };
const saveHomeCanvas = async () => undefined;

function HomeCanvasGallery({ unavailable = false }: { unavailable?: boolean }) {
  return <BlockEditor section="home" pageId="home" homeCompositionVersion={1}
    initialBlocks={homeCanvasBlocks} commandsInline onSave={saveHomeCanvas}
    allowConflictOverwrite={false} loadMedia={loadGalleryMedia}
    loadHomeSources={unavailable ? unavailableHomeCanvasSources : loadHomeCanvasSources} />;
}

const loadHomeNewsletterGallerySources = async () => {
  const art = new URLSearchParams(window.location.search).get("homeNewsletterArt");
  const unavailable = new URLSearchParams(window.location.search).get("homeNewsletterSource") === "error";
  const newscastState = new URLSearchParams(window.location.search).get("homeNewscastSource");
  const newscast = newscastState ? adaptLatestHomeNewscast(newscastState === "error" ? { status: "error" } : {
    status: "ready", source: "pbs_media_manager", requestUrl: HOME_NEWSCAST_ASSETS_URL,
    checkedAt: homeCurrentCatalogFixture.catalog.cutoffAt, complete: true,
    response: newscastState === "empty" || newscastState === "withdrawn" ? { data: [], links: { next: null } } : homeNewscastFixture,
  }, homeCurrentCatalogFixture.catalog.cutoffAt,
  newscastState === "withdrawn" ? "a22562ab-3442-42e7-a9e4-192c2d0bd190" : undefined) : undefined;
  const catalog = { ...homeCurrentCatalogFixture.catalog, services: { newsletters: unavailable ? { status: "error" as const } : createHomeNewsletterSnapshot([{
    id: "gallery-newsletter", kind: "newsletter", href: null, sourceVersion: 1,
    newsletter: { card: { title: homeNewsletterCopy.title, summary: homeNewsletterCopy.summary, signupUrl: homeNewsletterCopy.signupUrl,
      imageAlt: art === "meaningful" ? 'Approved "Newsletter" artwork' : homeNewsletterCopy.image.alt },
      ...(art === "none" ? {} : { image: { url: homeNewsletterCopy.image.url } }) },
  }], homeCurrentCatalogFixture.catalog.cutoffAt, homeCurrentCatalogFixture.catalog.cutoffAt),
    ...(newscast ? { newscast } : {}),
  } };
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(homeCatalogJson(catalog)))), byte => byte.toString(16).padStart(2, "0")).join("");
  return { ...homeCanvasSources, publication: { ...homeCurrentCatalogFixture.receipt },
    editorial: readHomeEditorialSourceReceipt({ catalog, receipt: { ...homeCurrentCatalogFixture.receipt, digest } }) };
};
function HomeV2ArrangementGallery() {
  const [saved, setSaved] = useState(homeCanvasBlocks);
  const [reopen, setReopen] = useState(0);
  return <>
    <Button onClick={() => setReopen(value => value + 1)}>Reopen saved Home</Button>
    <BlockEditor key={reopen} section="home" pageId="home" homeCompositionVersion={2}
      initialBlocks={saved} commandsInline onSave={async blocks => { setSaved(blocks); }}
      allowConflictOverwrite={false} loadMedia={loadGalleryMedia} loadHomeSources={loadHomeNewsletterGallerySources} allowIncomplete />
    <output hidden data-home-v2-reopen={reopen} data-home-v2-saved={JSON.stringify(saved)} />
  </>;
}

const homeSelectionSources = { ...homeCanvasSources, publication: {
  buildBatchId: homeCurrentCatalogFixture.receipt.buildBatchId, generation: 22, commitSha: "a".repeat(40),
}, editorial: readHomeEditorialSourceReceipt(homeCurrentCatalogFixture) };
const loadHomeSelectionSources = async () => homeSelectionSources;
function HomeV2SelectionGallery() {
  const [saved, setSaved] = useState(homeSelectionFixture.home.blocks as AdminBlock[]);
  const [reopen, setReopen] = useState(0);
  return <>
    <Button onClick={() => setReopen(value => value + 1)}>Reopen saved Home</Button>
    <BlockEditor key={reopen} section="home" pageId="home" homeCompositionVersion={2}
      initialBlocks={saved} commandsInline onSave={async blocks => { setSaved(blocks); }}
      allowConflictOverwrite={false} loadMedia={loadGalleryMedia} loadHomeSources={loadHomeSelectionSources} />
    <output hidden data-home-v2-reopen={reopen} data-home-v2-saved={JSON.stringify(saved)} />
  </>;
}

function HomeHeroGallery() {
  const [value, setValue] = useState<HomeHeroConfig>({ mode: "manual", items: [{
    itemId: "gallery-hero-one", title: "Explore the Garden State",
    summary: "Discover the people and places that make New Jersey home.",
    href: "/posts/explore-the-garden-state/",
  }] });
  return <div className="record-form" style={{ maxWidth: "52rem", padding: "1.5rem" }}>
    <HomeHeroModal value={value} preview={value.presentation === "editorial"
      ? <HomeHeroLayoutPreview value={value} loadSources={loadHomeCanvasSources} loadMedia={loadGalleryMedia} /> : undefined}><HomeHeroEditor value={value} onChange={setValue} loadMedia={loadGalleryMedia} loadSources={loadHomeCanvasSources} /></HomeHeroModal>
  </div>;
}

function HomeHeroSourceGallery() {
  const [value, setValue] = useState<HomeHeroConfig>({ mode: "manual", presentation: "editorial", items: [{
    itemId: "source-hero", source: "cms_posts", sourceId: "gallery-hero-post", title: "Home-only headline",
    summary: "", href: "/support/",
  }] });
  return <div className="record-form" style={{ maxWidth: "52rem", padding: "1.5rem" }}>
    <HomeHeroModal value={value} preview={<HomeHeroLayoutPreview value={value} loadSources={loadHomeCanvasSources} loadMedia={loadGalleryMedia} />}>
      <HomeHeroEditor value={value} onChange={setValue} loadMedia={loadGalleryMedia} loadSources={loadHomeCanvasSources} />
    </HomeHeroModal>
  </div>;
}

function ServiceCanvasGallery({ pageId }: { pageId: PublicPageId }) {
  const requestedPage = new URLSearchParams(window.location.search).get("servicePage") ?? undefined;
  if (hasServiceCanvas(requestedPage)) pageId = requestedPage;
  const seed = pageCompositionSeed(pageId)!;
  return <BlockEditor section="programLanding" pageId={pageId}
    pageTitle={String(seed.metadata.title)} pageDescription={String(seed.metadata.description)}
    initialBlocks={seed.blocks as AdminBlock[]} commandsInline onSave={saveHomeCanvas}
    loadMedia={loadGalleryMedia} />;
}

function DataTableGallery() {
  const query = new URLSearchParams(window.location.search);
  const page = query.get("tableOwner") === "page";
  const row = query.get("tableRow") === "true";
  const table: AdminBlock = { id: "table-gallery", type: "data_table", visible: true, order: row ? 1 : 0,
    ...(row ? { layout: { rowId: "row-gallery", column: 0 } } : {}), data: {
      title: "New Jersey audience by county",
      csv: "County,Households,Weekly viewers,Share\nEssex,322417,521000,12.4%\nMiddlesex,317892,487000,11.6%\nBergen,339021,463000,11.1%",
      source: "Sample audience data", sourceHref: "",
    } };
  const blocks: AdminBlock[] = row ? [
    { id: "row-gallery", type: "row", visible: true, order: 0, data: { columns: [6, 6] } }, table,
    { id: "heading-gallery", type: "headline", visible: true, order: 2, layout: { rowId: "row-gallery", column: 1 }, data: { text: "Audience context", level: 2 } },
  ] : [table];
  return <div className="record-form">
    <BlockEditor section={page ? "genericPage" : "post"} commandsInline initialBlocks={blocks} newId={galleryIds} />
  </div>;
}

function CustomShelfGallery() {
  const [stored, setStored] = useState(() => structuredClone(HOME_EDITOR_BLOCKS));
  const [opened, setOpened] = useState(() => structuredClone(HOME_EDITOR_BLOCKS));
  const [revision, setRevision] = useState(0);
  const save = async (blocks: AdminBlock[]) => {
    const parsed = parseBlocks(blocks);
    if (!parsed.ok) throw new Error(parsed.error);
    setStored(structuredClone(blocks));
  };
  return <ContentShelfSources.Provider value={{
    loadLibrarySelection: async () => ({ records: [{ id: "sample-post", kind: "post", status: "published", liveSourceVersion: 1, title: "A walk along the river" }],
      total: 1, allCount: 1, mineCount: 0, assignedCount: 0, page: 1, pageCount: 1,
      statusCounts: { draft: 0, in_review: 0, approved: 0, scheduled: 0, published: 1, archived: 0 } }),
    loadRecord: async () => ({ status: "ready", record: { status: "published", publiclyVisible: true, publicSourceVersion: 1, published: { sourceVersion: 1, metadata: {
      title: "A walk along the river", slug: "river-walk", summary: "Places to explore along the Delaware River.",
      heroImage: "media-garden-state", heroImageAlt: "Community artwork" } } } }),
  }}>
    <Button onClick={() => { setOpened(structuredClone(stored)); setRevision(value => value + 1); }}>Reopen saved content</Button>
    <BlockEditor key={revision} section="post" initialBlocks={opened} commandsInline
      onSave={save} loadMedia={loadGalleryMedia} newId={galleryIds} />
  </ContentShelfSources.Provider>;
}

function PostPresentationGallery() {
  const [stored, setStored] = useState<Record<string, unknown>>({ title: "A walk along the river", tags: ["New Jersey"], blocks: [] });
  const [opened, setOpened] = useState(stored);
  const [revision, setRevision] = useState(0);
  return <div className="content-studio">
    <Button onClick={() => { setOpened(structuredClone(stored)); setRevision(value => value + 1); }}>Reopen saved post</Button>
    <RecordForm key={revision} kind="post" canSave initial={opened}
      onSave={async record => { setStored(structuredClone(record)); return record; }} loadMedia={loadGalleryMedia} />
  </div>;
}

function HomeConversionGallery() {
  const [transport] = useState(() => {
    let record: PageContent = {
      blocks: structuredClone(HOME_EDITOR_BLOCKS), metadata: { title: "Home" },
      status: "draft", version: 4,
    };
    return {
      load: async () => structuredClone(record),
      convert: async (baseVersion: number) => {
        if (baseVersion !== record.version) throw new Error("Reload Home before converting this draft.");
        await new Promise(resolve => window.setTimeout(resolve, 600));
        record = { ...record, homeCompositionVersion: 1, version: baseVersion + 1,
          blocks: [...homeCompositionDefaults().map((block, index) => ({ ...block, id: `gallery-region-${index}` })),
            ...record.blocks.map(block => ({ ...block, order: 7 }))] as AdminBlock[] };
        return structuredClone(record);
      },
    };
  });
  return <MemoryRouter><EditorWorkspace principal={superAdmin} enforcePublicPageOwnership
    loadPage={transport.load} convertHome={transport.convert} loadHomeSources={loadHomeCanvasSources}
    loadMedia={loadGalleryMedia} savePage={saveOk} savePageMetadata={saveMetadataOk} /></MemoryRouter>;
}

function PageDynamicShelves({
  blocks = [TOPIC_SHELF_BLOCK, VIDEO_PLAYLIST_BLOCK],
  note = "A topic shelf and a video playlist on a content page. Each shows the cards the build will publish, then the bounded choices that produce them.",
}: {
  blocks?: AdminBlock[];
  note?: string;
} = {}) {
  return (
    <div className="record-form">
      <section
        className="post-editor-writing-boundary"
        aria-labelledby="gallery-shelves-heading"
      >
        <div className="post-body-heading">
          <h2 id="gallery-shelves-heading">Page body</h2>
          <p>{note}</p>
        </div>
        <BlockEditor
          section="genericPage"
          initialBlocks={blocks}
          newId={galleryIds}
          commandsInline
          loadMedia={loadGalleryMedia}
        />
      </section>
    </div>
  );
}

function PostGalleryContainment({
  block = GALLERY_CONTAINMENT_BLOCK,
  note = "This visual stress fixture shows twelve items. The paired interaction tests exercise each item count from one through twelve.",
}: {
  block?: AdminBlock;
  note?: string;
} = {}) {
  return (
    <div className="record-form">
      <section
        className="post-editor-writing-boundary"
        aria-labelledby="gallery-body-heading"
      >
        <div className="post-body-heading">
          <h2 id="gallery-body-heading">Post body</h2>
          <p>{note}</p>
        </div>
        <BlockEditor
          section="post"
          initialBlocks={[block]}
          newId={galleryIds}
          commandsInline
          loadMedia={loadGalleryMedia}
        />
      </section>
    </div>
  );
}

const loadEmptyGalleryMedia = async (
  _query: MediaListQuery,
): Promise<ListMediaResponse> => ({
  success: true,
  records: [],
  total: 0,
  allCount: 0,
  page: 1,
  pageCount: 1,
  categoryCounts: {},
  kindCounts: { image: 0, document: 0 },
});

const loadFailedGalleryMedia = async (
  _query: MediaListQuery,
): Promise<ListMediaResponse> => {
  throw new Error("Media service unavailable");
};

const loadPendingGalleryMedia = (
  _query: MediaListQuery,
): Promise<ListMediaResponse> => new Promise(() => {});

const saveGalleryMedia = async (
  asset: MediaAssetSummary,
  metadata: UpdateMediaMetadata,
): Promise<UpdateMediaMetadataResponse> => ({
  success: true,
  changed: true,
  asset: {
    ...asset,
    ...metadata,
    version: asset.version + 1,
    etag: `"media.${asset.id}.${asset.version + 1}"`,
    updatedAt: "2026-08-13T12:30:00.000Z",
    updatedBy: "ed",
  },
});

const deleteGalleryMedia = async (
  asset: MediaAssetSummary,
): Promise<DeleteMediaResponse> => ({
  success: true,
  changed: true,
  deleted: true,
  asset: {
    id: asset.id,
    lifecycle: "tombstoned",
    version: asset.version + 1,
    etag: `"media.${asset.id}.${asset.version + 1}"`,
  },
});

const uploadGalleryMedia = async (
  file: File,
  metadata: UploadMediaMetadata,
): Promise<UploadMediaResponse> => ({
  success: true,
  asset: {
    ...GALLERY_MEDIA[1],
    id: "media-upload-preview",
    name: metadata.name ?? file.name,
    originalName: file.name,
    category: metadata.category,
    categories: metadata.categories ?? [metadata.category],
    tags: metadata.tags ?? [],
    description: metadata.description ?? null,
    altText: metadata.altText ?? null,
    license: metadata.license ?? null,
    credit: metadata.credit ?? null,
    mimeType: file.type,
    kind: file.type === "audio/wav" ? "audio" : file.type === "application/pdf" ? "document" : "image",
    sizeBytes: file.size,
    version: 1,
    etag: '"media.bWVkaWEtdXBsb2FkLXByZXZpZXc.1"',
    createdAt: "2026-08-13T12:30:00.000Z",
    updatedAt: "2026-08-13T12:30:00.000Z",
  },
});

let idCounter = 0;
const galleryIds = () => `gx${++idCounter}`;

const TAG_FIELD: EditorField = {
  key: "tags",
  label: "Tags",
  help: "Group related content with short newsroom terms.",
  kind: "list",
  required: false,
};

function TagControlGallery({
  initialTags = [],
  error,
  focus = false,
}: {
  initialTags?: string[];
  error?: string;
  focus?: boolean;
}) {
  const [tags, setTags] = useState<string[]>(initialTags);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focus) return;
    hostRef.current
      ?.querySelector<HTMLInputElement>(".editor-tag-input")
      ?.focus();
  }, [focus]);

  return (
    <div ref={hostRef} style={{ maxWidth: "32rem" }}>
      <FieldRenderer
        field={TAG_FIELD}
        value={tags}
        onChange={(value) => setTags(value as string[])}
        fieldId="gallery-tags"
        error={error}
      />
    </div>
  );
}

function PagesBrowseSpecimen() {
  const [titleTarget, setTitleTarget] = useState<HTMLDivElement | null>(null);
  return (
    <MemoryRouter initialEntries={["/content"]}>
      <div hidden ref={setTitleTarget} />
      <WorkspaceActionsProvider target={null} titleTarget={titleTarget}>
        <ContentBrowseWorkspace principal={superAdmin} surface={{ kind: "page-list" }} />
      </WorkspaceActionsProvider>
    </MemoryRouter>
  );
}

// Five real browse owners in the actual shell, with local list data. Isolated state
// specimens below still make failure/permission states independently reproducible.
function BrowsingFamilyShellSpecimen() {
  const query = new URLSearchParams(window.location.search);
  const family = query.get("family") ?? "directory";
  const recordKind = query.get("recordKind") === "event" ? "event" : "sponsor";
  const mediaTab = query.get("tab") ?? "images";
  const path = family === "library" ? "/content/library" : family === "record-list" ? `/content/${recordKind}`
    : family === "media" ? `/media/${mediaTab}` : family === "queue" ? "/publish-queue" : "/content";
  const title = family === "directory" ? "Site pages" : family === "record-list" ? recordKind === "event" ? "Events" : "Sponsors"
    : family === "library" ? "All content" : family === "media" ? "Media library" : "Editorial queue";
  const [router] = useState(() => {
    const element = family === "media" ? <BrowsingShellMedia tab={mediaTab} /> : family === "queue" ? <QueueSurface
        reviewRequests={REVIEW_REQUESTS.map(request => ({ ...request, requestedByLabel: "Sample contributor", assigneeLabel: request.assigneeLabel ? "Sample editor" : null }))}
        reviewLoading={false} reviewError={null} onReviewRefresh={() => {}} showPublishActivity
        publishItems={QUEUE_ITEMS} publishLoading={false} publishError={null} onPublishRefresh={() => {}}
      /> : <ContentBrowseWorkspace principal={superAdmin}
        surface={family === "directory" ? { kind: "page-list" } : family === "library" ? { kind: "library" } : { kind: "record-list", record: recordKind }}
        listRecords={recordKind === "event" ? async () => ({ records: [{ id: "event-community", title: "New Jersey community screening and conversation", status: "draft", startsAt: "2026-08-22T14:30:00Z", updatedAt: "2026-07-19T14:30:00Z" }], page: 1, pageCount: 1, total: 1 }) : listSponsors}
        canArchiveLibrary archiveLibraryRecords={archiveLibraryRecords}
        loadLibrarySelection={async query => selectLibraryRecords(LIBRARY_RECORDS, query, superAdmin.id)}
        loadSavedViews={loadSavedLibraryViews} mutateSavedViews={mutateLibraryViews}
      />;
    return createMemoryRouter([{ path: "/", element: <ShellLayout />, children: [{
      path: path.slice(1), element, handle: { title, description: "Local browsing and workflow fixture." } satisfies RouteHandle,
    }] }], { initialEntries: [path] });
  });
  const principal = family === "media" ? editor : superAdmin;
  const shell: ShellData = { principal, user: { uid: principal.id ?? "gallery-user", email: "editor@example.org", displayName: "Sample editor" },
    userDoc: { role: family === "media" ? null : "super_admin", grants: principal.grants,
      displayName: "Sample editor", email: "editor@example.org" }, signOut: () => {}, navigationShares: [] };
  return <ShellProvider value={shell}><RouterProvider router={router} /></ShellProvider>;
}

// The route's real tab strip and real family owners, supplied only with local fixture reads.
function BrowsingShellMedia({ tab }: { tab: string }) {
  const [panelReady, setPanelReady] = useState(() => !new URLSearchParams(window.location.search).has("deferPanel"));
  const getIdToken = useGalleryMediaTransport();
  const source = { id: "video-library", label: "Videos", description: "Private staff video fixture.",
    mediaKind: "video" as const, canBrowse: true as const, canUpload: true, canEditMetadata: true, canRequestProduction: true };
  const panel = tab === "videos" ? <SourceMediaLibrary principal={editor} userId="gallery" source={source} getIdToken={getIdToken} />
    : tab === "favorites" ? <MediaFavoritesLibrary principal={editor} userId="gallery" getIdToken={getIdToken}
      categoryRegistry={{ status: "ready", categories: GALLERY_MEDIA_CATEGORIES }} loadFavorites={galleryFavorites} loadSources={galleryFavoriteSources} />
    : tab === "collections" ? <MediaCollectionsGalleryRoute getIdToken={getIdToken} />
    : <MediaLibrarySurface audioLibrary={tab === "voiceovers"} principal={editor} userId="gallery" getIdToken={getIdToken}
      categories={GALLERY_MEDIA_CATEGORIES} deleteMedia={deleteGalleryMedia}
      loadMedia={tab === "voiceovers" ? async (query, options) => cmsListMedia(await getIdToken(), query, undefined, { counts: Boolean(options?.tabCounts), favorites: Boolean(options?.tabCounts) }) : loadEditorGalleryMedia}
      loadCorpus={galleryMediaCorpusLoader(loadEditorGalleryMedia)} saveMetadata={saveGalleryMedia} uploadMedia={uploadGalleryMedia} />;
  return <div className="media-workspace"><div className="media-workspace-bar"><MediaTabs
    tabs={mediaTabs({ canUseImages: true, sources: [source], counts: { images: 3, voiceovers: 2, favorites: 4 } })}
    currentId={tab === "videos" ? source.id : tab} />
    {tab === "favorites" || tab === "collections" ? <WorkspaceUploadButton secondary={tab === "collections"} /> : null}
    </div>{panelReady ? panel : <Button onClick={() => setPanelReady(true)}>Load media fixture</Button>}</div>;
}

function HomeShortcutsSpecimen({ principal = superAdmin }: { principal?: Principal }) {
  const [stored, setStored] = useState<readonly HomeShortcutId[] | null>(null);
  return <HomeShortcuts principal={principal} stored={stored} onSave={async ids => { setStored(ids); }} />;
}

function PublicBannerSettingsRouteSpecimen({ panel }: { panel: ReactNode }) {
  return <AdminSettingsFrame><PublicWebsiteSettingsSection>{panel}</PublicWebsiteSettingsSection></AdminSettingsFrame>;
}

const LazyNjDecidesBrandSpecimen = lazy(() => import("../routes/AdminSettingsRoute").then(module => ({
  default: module.RoutedNjDecidesSettings,
})));
const loadNjDecidesBrandSpecimen = async () => ({ success: true as const, found: false as const, id: "nj-decides-brand" });
const refuseNjDecidesBrandMutation = async () => { throw new Error("This local fixture does not save or publish settings."); };

function ShellSpecimen({
  adminSettingsPanel,
  reportingTransport,
  loadRevisions, loadRevision,
  requestSavedPreview,
  scheduleContent,
  transitionContent,
  capturePostTemplate,
  duplicatePost,
  listRecords,
  loadLibrarySelection,
  pageDirectoryApi,
  initialEntry = "/",
  loadPage = loadReady,
  loadHomeSources,
  savePageMetadata = saveMetadataOk,
  navigation,
  navigationShares,
  loadRecord,
  loadMedia,
  uploadMedia,
  mediaCategories,
  canUploadCategory,
  pageId = "home",
  principal = superAdmin,
  profileRole = "super_admin",
  publishContent,
  savePage = saveOk,
  saveRecord,
  section = "home",
  surface,
}: {
  adminSettingsPanel?: ReactNode;
  reportingTransport?: ComponentProps<typeof EditorWorkspace>["reportingTransport"];
  loadRevisions?: ComponentProps<typeof EditorWorkspace>["loadRevisions"];
  loadRevision?: ComponentProps<typeof EditorWorkspace>["loadRevision"];
  requestSavedPreview?: ComponentProps<typeof EditorWorkspace>["requestSavedPreview"];
  scheduleContent?: ComponentProps<typeof EditorWorkspace>["scheduleContent"];
  transitionContent?: ComponentProps<typeof EditorWorkspace>["transitionContent"];
  capturePostTemplate?: ComponentProps<typeof EditorWorkspace>["capturePostTemplate"];
  duplicatePost?: ComponentProps<typeof EditorWorkspace>["duplicatePost"];
  listRecords?: ComponentProps<typeof EditorWorkspace>["listRecords"];
  loadLibrarySelection?: ComponentProps<typeof EditorWorkspace>["loadLibrarySelection"];
  pageDirectoryApi?: ComponentProps<typeof EditorWorkspace>["pageDirectoryApi"];
  initialEntry?: string;
  loadPage?: (pageId: PublicPageId, section: SectionId) => Promise<PageContent>;
  loadHomeSources?: ComponentProps<typeof EditorWorkspace>["loadHomeSources"];
  savePageMetadata?: ComponentProps<typeof EditorWorkspace>["savePageMetadata"];
  // A stored per-account navigation arrangement (#1045), exactly as the profile document carries
  // it, so the gallery can show a rail somebody has actually arranged.
  navigation?: unknown;
  navigationShares?: readonly NavigationShare[];
  loadRecord?: ComponentProps<typeof EditorWorkspace>["loadRecord"];
  loadMedia?: ComponentProps<typeof EditorWorkspace>["loadMedia"];
  uploadMedia?: ComponentProps<typeof EditorWorkspace>["uploadMedia"];
  mediaCategories?: ComponentProps<typeof EditorWorkspace>["mediaCategories"];
  canUploadCategory?: ComponentProps<typeof EditorWorkspace>["canUploadCategory"];
  pageId?: PublicPageId;
  principal?: Principal;
  profileRole?: "admin" | "super_admin" | null;
  publishContent?: ComponentProps<typeof EditorWorkspace>["publishContent"];
  savePage?: ComponentProps<typeof EditorWorkspace>["savePage"];
  saveRecord?: ComponentProps<typeof EditorWorkspace>["saveRecord"];
  section?: SectionId;
  surface?: Surface;
}) {
  const [router] = useState(() =>
    createMemoryRouter(
      [
        {
          path: "/",
          element: <ShellLayout />,
          children: [
            {
              index: true,
              element: (
                <NewsroomHome
                  homeActions={<HomeShortcutsSpecimen principal={principal} />}
                  canBrowsePages
                  canEditHomepage
                  canBrowseRecords
                  canCreate
                  canViewEditorialQueue
                  canViewPublishActivity
                  currentUserId="sa"
                  loadRecords={async () => HOME_SELECTION}
                  loadReviewRequestCount={async () => 3}
                  loadPublishActivity={async () => ({
                    activeCount: 1,
                    recoveryCount: 2,
                  })}
                />
              ),
              handle: {
                title: "Newsroom home",
                description:
                  "Recent editorial work and the next task that needs attention.",
              } satisfies RouteHandle,
            },
            {
              path: "content/*",
              element: (
                <EditorWorkspace
                  reportingTransport={reportingTransport}
                  loadRevisions={loadRevisions} loadRevision={loadRevision}
                  requestSavedPreview={requestSavedPreview}
                  capturePostTemplate={capturePostTemplate}
                  duplicatePost={duplicatePost}
                  assignRecord={
                    surface?.kind === "record" && surface.record === "post"
                      ? assignPost
                      : undefined
                  }
                  canAssignRecords={
                    surface?.kind === "record" && surface.record === "post"
                  }
                  loadAssignableUsers={
                    surface?.kind === "record" && surface.record === "post"
                      ? loadAssignableStaff
                      : undefined
                  }
                  publishContent={
                    publishContent ?? (surface?.kind === "record" && surface.record === "post"
                      ? publishGalleryPost
                      : undefined)
                  }
                  principal={principal}
                  loadPage={loadPage}
                  loadHomeSources={loadHomeSources}
                  listRecords={listRecords}
                  loadLibrarySelection={loadLibrarySelection}
                  pageDirectoryApi={pageDirectoryApi}
                  loadRecord={loadRecord}
                  loadMedia={loadMedia}
                  uploadMedia={uploadMedia}
                  mediaCategories={mediaCategories}
                  canUploadCategory={canUploadCategory}
                  savePage={savePage}
                  savePageMetadata={savePageMetadata}
                  saveRecord={saveRecord}
                  scheduleContent={scheduleContent ?? (
                    surface?.kind === "record" && surface.record === "post"
                      ? scheduleGalleryPost
                      : undefined)
                  }
                  transitionContent={transitionContent ?? (
                    surface?.kind === "record" && surface.record === "post"
                      ? transitionGalleryPost
                      : undefined)
                  }
                  requestPagePreview={requestGalleryPreview}
                  loadPagePreviewStatus={loadGalleryPreviewStatus}
                  newId={galleryIds}
                  surface={surface ?? { kind: "page", pageId, section }}
                />
              ),
              handle: {
                title: "Content studio",
                description: "Create and shape site records and pages.",
              } satisfies RouteHandle,
            },
            {
              path: "account/settings",
              element: <AccountSettingsRoute />,
              handle: { title: "Account settings", description: "Arrange your navigation and choose control labels." } satisfies RouteHandle,
            },
            {
              path: "admin/settings",
              element: adminSettingsPanel
                ? <PublicBannerSettingsRouteSpecimen panel={adminSettingsPanel} />
                : null,
              handle: {
                title: "Admin settings",
                description: "Manage public presentation and newsroom defaults.",
              } satisfies RouteHandle,
            },
            {
              path: "media/videos",
              element: <SourceMediaLibrary
                principal={principal}
                userId="gallery"
                source={{
                  id: "video-library", label: "Video library", description: "Browse private staff videos.",
                  mediaKind: "video", canBrowse: true, canUpload: true,
                  canEditMetadata: true, canRequestProduction: true,
                }}
                getIdToken={async () => "local-gallery-fixture"}
              />,
              handle: { title: "Media library", description: "Browse private staff videos." } satisfies RouteHandle,
            },
            {
              path: "analytics",
              element: <AnalyticsSurface load={loadAnalyticsFixture} initialDays={30} fixedPeriod preview />,
              handle: {
                title: "Analytics",
                description: "Review audience, newsletters, and website delivery.",
              } satisfies RouteHandle,
            },
            {
              path: "activity",
              element: <ActivitySurface loadActivity={loadGalleryActivity} />,
              handle: {
                title: "Activity",
                description: "Review administrative changes and evidence.",
              } satisfies RouteHandle,
            },
          ],
        },
      ],
      { initialEntries: [initialEntry] },
    ),
  );
  const shell: ShellData = {
    principal,
    user: {
      uid: principal.id ?? "gallery-user",
      email: guideCapture ? "editor@example.org" : "account-3@example.org",
      displayName: guideCapture ? "Sample editor" : "Jordan Avery",
    },
    userDoc: {
      role: profileRole,
      grants: principal.grants,
      displayName: guideCapture ? "Sample editor" : "Jordan Avery",
      email: guideCapture ? "editor@example.org" : "account-3@example.org",
      preferences: navigation === undefined ? undefined : { navigation },
    },
    signOut: () => {},
    navigationShares,
  };
  return (
    <ShellProvider value={shell}>
      <RouterProvider router={router} />
    </ShellProvider>
  );
}

// Admin settings reads and writes one CMS setting through the signed-in token, which is why it was
// the one #1036 comparison surface with no gallery state. The form now takes that transport as a
// prop, so these fixtures stand in for the back end and every state can be looked at (#1036).
const GALLERY_BANNER_HEADING = "Building the new NJ PBS website";

function bannerDocument(
  heading: string,
  version: number,
): MutateSettingsResponse<BannerSettingsValues> {
  return {
    success: true,
    id: "newsroom-home",
    changed: true,
    settings: { schemaVersion: 1, values: { bannerHeading: heading }, version },
  };
}

function StudyReferenceShell({ kind, homeBlocks }: { kind: "page" | "post"; homeBlocks?: readonly AdminBlock[] }) {
  const [api] = useState(() => createStudyReferenceFixtures({ homeBlocks }));
  const unavailable = async () => { throw Object.assign(new Error("This local design fixture does not connect to publication or preview services."), { status: 503 }); };
  return <ShellSpecimen {...api} requestSavedPreview={kind === "post" ? unavailable : undefined}
    publishContent={unavailable} scheduleContent={unavailable} transitionContent={unavailable} loadRevisions={unavailable} loadRevision={unavailable} initialEntry={kind === "page" ? "/content/pages/home/edit" : "/content/post/study-post/edit"}
    surface={kind === "page" ? { kind: "page", pageId: "home", section: "home" } : { kind: "record", record: "post", id: "study-post" }} />;
}

function bannerTransport(options: {
  heading?: string;
  loadFails?: boolean;
  conflict?: boolean;
}): BannerSettingsTransport {
  return {
    load: async () => {
      if (options.loadFails) throw new Error("Settings read unavailable");
      return {
        success: true,
        found: true,
        id: "newsroom-home",
        settings: {
          schemaVersion: 1,
          values: { bannerHeading: options.heading ?? GALLERY_BANNER_HEADING },
          version: 3,
        },
      };
    },
    save: async (request) => {
      if (options.conflict)
        throw Object.assign(new Error("Conflict"), { status: 409 });
      const heading = String(
        (request.values as { bannerHeading?: unknown }).bannerHeading ?? "",
      );
      return bannerDocument(heading, 4);
    },
  };
}

const COST_LEDGER_SPECIMEN: CostLedgerView = {
  success: true,
  canEdit: true,
  currency: "USD",
  currentPeriod: "2026-09",
  period: "2026-09",
  periodStatus: "open",
  monthlyCents: 163423,
  annualRunRateCents: 1961076,
  yearToDateCents: 1470807,
  yearToDateMonths: 9,
  blankLineCount: 1,
  knownLineCount: 3,
  byCategory: { cloud: 89423, ai: 74000, saas: 0, hardware: 0 },
  byProject: { cms: 89423, spotlight: 0, hosting: 0, tooling: 74000 },
  lines: [
    {
      id: "gcp",
      label: "Google Cloud Platform",
      category: "cloud",
      project: "cms",
      source: "auto",
      cadence: "monthly",
      monthlyCents: 89423,
      standingCents: null,
      vendor: "Google Cloud",
      notes: "The weekly pull updates this automatic line.",
      enabled: true,
      freshnessStatus: "fresh",
      freshnessAt: "2026-09-22T13:00:00.000Z",
      state: "known",
    },
    {
      id: "claude",
      label: "Claude",
      category: "ai",
      project: "tooling",
      source: "manual",
      cadence: "monthly",
      monthlyCents: 74000,
      standingCents: 74000,
      vendor: "Anthropic",
      notes: "A verified manual amount.",
      enabled: true,
      freshnessStatus: "manual",
      freshnessAt: null,
      state: "known",
    },
    {
      id: "domains",
      label: "Domain registrations",
      category: "cloud",
      project: "hosting",
      source: "manual",
      cadence: "annual",
      monthlyCents: null,
      standingCents: null,
      vendor: "Registrar",
      notes: "Blank stays separate from zero.",
      enabled: true,
      freshnessStatus: "blank",
      freshnessAt: null,
      state: "blank",
    },
    {
      id: "airtable",
      label: "Airtable",
      category: "saas",
      project: "spotlight",
      source: "manual",
      cadence: "monthly",
      monthlyCents: 0,
      standingCents: 0,
      vendor: "Airtable",
      notes: "A recorded zero is a real zero.",
      enabled: true,
      freshnessStatus: "manual",
      freshnessAt: null,
      state: "known",
    },
  ],
  comparisons: [
    {
      id: "ghost",
      vendor: "Ghost",
      product: "Ghost(Pro) Business",
      status: "published",
      priceLabel: "$199 per month",
      monthlyCents: 19900,
      annualCents: 238800,
      rangeNote: "Published list price.",
      sourceUrl: "https://ghost.org/pricing/",
      sourceReadOn: "2026-09-25",
      excludes: "labor",
      notes: "Hosting and CMS only.",
    },
    {
      id: "vip",
      vendor: "WordPress VIP",
      product: "WordPress VIP",
      status: "quote-required",
      priceLabel: "",
      monthlyCents: null,
      annualCents: null,
      rangeNote: "The vendor requires a quote.",
      sourceUrl: "https://wpvip.com/pricing/",
      sourceReadOn: "2026-09-25",
      excludes: "labor",
      notes: "Hosting and CMS only.",
    },
  ],
  snapshots: [
    {
      id: "2026-09-15",
      period: "2026-09",
      takenAt: "2026-09-15T13:00:00.000Z",
      monthlyCents: 158400,
      annualRunRateCents: 1900800,
      blankLineCount: 2,
    },
    {
      id: "2026-09-22",
      period: "2026-09",
      takenAt: "2026-09-22T13:00:00.000Z",
      monthlyCents: 163423,
      annualRunRateCents: 1961076,
      blankLineCount: 1,
    },
  ],
  periods: [
    { id: "2026-08", status: "closed" },
    { id: "2026-09", status: "open" },
  ],
  hardware: {
    machines: [
      "node-services",
      "node-compute",
      "node-gpu-a",
      "node-gpu-b",
      "node-offsite",
    ].map((id) => ({
      id,
      label: id,
      purchaseCents: 220000,
      lifeMonths: 48,
      watts: 300,
      hoursPerMonth: 120,
      centsPerKwh: 21,
      internetShareCents: 1200,
    })),
  },
  csv: "Period,Amount\n2026-09,1634.23\n",
};

function CostLedgerGallery({ loading = false }: { loading?: boolean }) {
  const load = loading
    ? () => new Promise<CostLedgerView>(() => {})
    : async () => COST_LEDGER_SPECIMEN;

  return (
    <>
      <style>{costLedgerStyles}</style>
      <CostLedgerSurface
        load={load}
        mutate={async () => ({ success: true })}
      />
    </>
  );
}

const GALLERY_PUBLIC_BANNER_VALUES: PublicHomepageBannerValues = {
  enabled: true,
  message: "Storm coverage starts tonight at 8 p.m.",
  linkLabel: "View the schedule",
  linkHref: "/schedule/",
};

const GALLERY_NJ_DECIDES_BANNER_VALUES: PublicHomepageBannerValues = {
  enabled: true,
  message: "Follow election night coverage and find voting information.",
  linkLabel: "Election hub",
  linkHref: "/election/",
  njDecides: true,
  liveLabel: "Election night",
  startsAt: "2026-11-03T23:00:00.000Z",
  endsAt: "2026-11-04T06:00:00.000Z",
};

function gallerySettingsReceipt(sourceVersion: number): SettingsPublicationReceipt {
  return { queueId: "gallery-settings", originalOperationId: "gallery-settings", transport: "public-context-no-build-v1",
    sourceVersion, rendererSha: "a".repeat(40), contextRevision: 1, contextDigest: "b".repeat(64),
    status: "pending", missingConsumers: ["pages", "posts", "home", "listings", "authors", "feed", "contentApi", "sitemap", "search"] };
}

function publicBannerTransport(
  { election = false }: { election?: boolean } = {},
): PublicHomepageBannerSettingsTransport {
  let schemaVersion = election ? 2 : 1;
  let stored: PublicHomepageBannerValues = election
    ? { ...GALLERY_NJ_DECIDES_BANNER_VALUES }
    : { ...GALLERY_PUBLIC_BANNER_VALUES };
  let version = 3;
  let publication: SettingsPublicationReceipt | undefined;
  let published: { schemaVersion: number; sourceVersion: number; publishedAt: string; values: PublicHomepageBannerValues } | undefined;
  return {
    ...(election
      ? { loadAppearance: async () => DEFAULT_NJ_DECIDES_SETTINGS }
      : {}),
    load: async () => ({
      ...(publication ? { publication: { ...publication, status: "success" as const, missingConsumers: [] } } : {}),
      success: true,
      found: true,
      id: "public-homepage-banner",
      settings: {
        schemaVersion,
        values: stored,
        version,
        ...(published ? { published } : {}),
      },
    }),
    save: async (request) => {
      schemaVersion = 4;
      stored = request.values as PublicHomepageBannerValues;
      version += 1;
      return {
        success: true,
        changed: true,
        id: request.id,
        settings: { schemaVersion, values: stored, version },
      };
    },
    publish: async (request) => {
      const sourceVersion = request.baseVersion;
      version += 1;
      publication = gallerySettingsReceipt(sourceVersion);
      published = { schemaVersion, sourceVersion, publishedAt: "2026-08-31T15:00:00.000Z", values: stored };
      return {
        success: true,
        publication,
        changed: true,
        id: request.id,
        settings: {
          schemaVersion,
          values: stored,
          version,
          published: {
            schemaVersion,
            sourceVersion,
            publishedAt: "2026-08-31T15:00:00.000Z",
            values: stored,
          },
        },
      };
    },
  };
}

const GALLERY_PUBLIC_SITE_CHROME_VALUES: PublicSiteChromeValues = {
  newsletterEnabled: true,
  newsletterLabel: "Newsletter",
  newsletterHref: "/newsletter/",
  newsletterOpensInNewTab: false,
};

function publicSiteChromeTransport(): PublicSiteChromeSettingsTransport {
  let stored = GALLERY_PUBLIC_SITE_CHROME_VALUES;
  let version = 2;
  let publication: SettingsPublicationReceipt | undefined;
  let published: { schemaVersion: number; sourceVersion: number; publishedAt: string; values: typeof stored } | undefined;
  return {
    load: async () => ({
      ...(publication ? { publication: { ...publication, status: "success" as const, missingConsumers: [] } } : {}),
      success: true,
      found: true,
      id: "public-site-chrome",
      settings: { schemaVersion: 1, values: stored, version, ...(published ? { published } : {}) },
    }),
    save: async (request) => {
      stored = request.values as PublicSiteChromeValues;
      version += 1;
      return {
        success: true,
        changed: true,
        id: request.id,
        settings: { schemaVersion: 1, values: stored, version },
      };
    },
    publish: async (request) => {
      const sourceVersion = request.baseVersion;
      version += 1;
      publication = gallerySettingsReceipt(sourceVersion);
      published = { schemaVersion: 1, sourceVersion, publishedAt: "2026-08-31T15:00:00.000Z", values: stored };
      return {
        success: true,
        publication,
        changed: true,
        id: request.id,
        settings: {
          schemaVersion: 1,
          values: stored,
          version,
          published: {
            schemaVersion: 1,
            sourceVersion,
            publishedAt: "2026-08-31T15:00:00.000Z",
            values: stored,
          },
        },
      };
    },
  };
}

// Loading specimens hold their loaders so the skeleton can be judged. With ?delay=<ms> they
// resolve after that wait, so a layout-shift probe can watch the swap to loaded content.
function galleryDelayed<A extends unknown[], T>(load: (...args: A) => Promise<T>): (...args: A) => Promise<T> {
  const delay = new URLSearchParams(window.location.search).get("delay");
  if (delay === null) return () => new Promise<T>(() => {});
  return (...args) =>
    new Promise<void>((resolve) => window.setTimeout(resolve, Number(delay))).then(() => load(...args));
}

const GALLERY_RECORD_PAGE: RecordListPage = {
  records: LIBRARY_RECORDS.map(({ id, status, title, updatedAt }) => ({ id, status, title, updatedAt })),
  page: 1,
  pageCount: 1,
  total: LIBRARY_RECORDS.length,
};

function LoadingUsersGallery() {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    void galleryDelayed(async () => true)().then(setLoaded);
  }, []);
  return loaded ? (
    <UsersTable users={USERS} canManage onDeactivate={() => {}} onGrant={() => {}} onRevoke={() => {}} />
  ) : (
    <UsersTableSkeleton canManage />
  );
}

function ContentLibraryGallery({
  delayed = false,
  posts = false,
}: {
  delayed?: boolean;
  posts?: boolean;
}) {
  const load = async (query: Parameters<typeof selectLibraryRecords>[1]) =>
    selectLibraryRecords(LIBRARY_RECORDS, query, superAdmin.id);
  return (
    <MemoryRouter initialEntries={[posts ? "/content/post" : "/content/library"]}>
      <EditorWorkspace
        principal={superAdmin}
        surface={posts ? { kind: "record-list", record: "post" } : { kind: "library" }}
        canArchiveLibrary
        archiveLibraryRecords={archiveLibraryRecords}
        loadLibrarySelection={delayed ? galleryDelayed(load) : load}
        loadSavedViews={loadSavedLibraryViews}
        mutateSavedViews={mutateLibraryViews}
      />
    </MemoryRouter>
  );
}

function MediaLibraryGallery({
  initialEntry = "/media/images",
  loadMedia = loadEditorGalleryMedia,
  initialUploadState,
  principal = editor,
}: {
  initialEntry?: string;
  loadMedia?: (query: MediaListQuery) => Promise<ListMediaResponse>;
  initialUploadState?: MediaUploadInitialState;
  principal?: Principal;
}) {
  // Each shot is its own fixture under one gallery user, so a list cached by
  // one shot must not answer the next.
  useState(clearMediaSessionCache);
  const [router] = useState(() =>
    createMemoryRouter(
      [
        {
          path: "/media/images",
          element: (
            <MediaLibrarySurface
              principal={principal}
              userId="gallery"
              getIdToken={async () => "local-gallery-fixture"}
              categories={GALLERY_MEDIA_CATEGORIES}
              deleteMedia={deleteGalleryMedia}
              loadMedia={loadMedia}
              loadCorpus={galleryMediaCorpusLoader(loadMedia)}
              saveMetadata={saveGalleryMedia}
              uploadMedia={uploadGalleryMedia}
              initialUploadState={initialUploadState}
            />
          ),
        },
      ],
      { initialEntries: [initialEntry] },
    ),
  );
  // The gallery has no shell header, so the sticky toolbar pins to the top edge as it does
  // under the phone bar, instead of leaving a header-sized gap above it.
  return (
    <div style={{ "--workspace-header-height": "0px" } as CSSProperties}>
      <RouterProvider router={router} />
    </div>
  );
}

function MediaPickerGallery({ loadMedia = loadGalleryMedia, upload = false }: { loadMedia?: (query: MediaListQuery) => Promise<ListMediaResponse>; upload?: boolean }) {
  const [open, setOpen] = useState(false);
  const shell: ShellData = {
    principal: editor,
    user: {
      uid: "gallery",
      email: "editor@example.org",
      displayName: "Sample editor",
    },
    userDoc: null,
    signOut: () => {},
    getIdToken: async () => "local-gallery-fixture",
  };
  return (
    <ShellProvider value={shell}><div>
      <button
        className="button button-primary"
        type="button"
        onClick={() => setOpen(true)}
      >
        Choose image
      </button>
      {open ? (
        <MediaPickerDialog
          currentAssetId="media-garden-state"
          loadMedia={loadMedia}
          uploadMedia={uploadGalleryMedia}
          defaultUploadCategory="general"
          canUploadCategory={() => true}
          categories={upload ? GALLERY_MEDIA_CATEGORIES : undefined}
          onClose={() => setOpen(false)}
          onSelect={() => setOpen(false)}
        />
      ) : null}
    </div></ShellProvider>
  );
}

const LONG_RICH_TEXT_DOC: RichTextDoc = {
  type: "doc",
  content: Array.from({ length: 48 }, (_, index) => ({
    type: "paragraph" as const,
    content: [
      {
        type: "text" as const,
        text: `Paragraph ${index + 1}. New Jersey newsroom copy for contextual formatting checks.`,
      },
    ],
  })),
};

function ContextualRichTextGallery() {
  const [body, setBody] = useState<RichTextDoc>(LONG_RICH_TEXT_DOC);
  const [caption, setCaption] = useState<RichTextDoc>({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Secondary field" }] }],
  });
  return (
    <main style={{ display: "grid", gap: "var(--space-8)", padding: "var(--space-4)" }}>
      <section className="inline-card-grid">
        <div className="card-grid">
          <article className="card-grid__card">
            <RichTextEditor value={body} onChange={setBody} ariaLabel="Long body" />
          </article>
        </div>
      </section>
      <RichTextEditor value={caption} onChange={setCaption} ariaLabel="Caption" />
    </main>
  );
}

// ---------------------------------------------------------------------------
// Gallery chrome. Prefixed `gx-` and styled in gallery.html, so it cannot collide with,
// or quietly restyle, the admin's own class names -- the whole point is to see the admin
// as it really renders.
// ---------------------------------------------------------------------------

function SourceMediaLibraryGallery() {
  const [router] = useState(() => createMemoryRouter([{
    path: "*",
    element: <SourceMediaLibrary principal={superAdmin} userId="gallery" source={{ id: "video-library", label: "Video library", description: "Browse private staff videos.", mediaKind: "video", canBrowse: true, canUpload: true, canEditMetadata: true, canReplace: true, canRequestProduction: true }} getIdToken={async () => "local-gallery-fixture"} />,
  }], { initialEntries: ["/media"] }));
  return <RouterProvider router={router} />;
}

const GALLERY_FAVORITES_PAGE: MediaFavoritePage = {
  success: true,
  records: [
    { ref: { backend: "r2", id: "gallery-image" }, createdAt: "2026-08-20T12:00:00.000Z", available: true,
      asset: { ...GALLERY_MEDIA[0], id: "gallery-image", name: "Station image", thumbnails: [],
        url: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="#123354"/><circle cx="480" cy="270" r="120" fill="#67b7df"/></svg>')}` } },
    { ref: { backend: "r2", id: "gallery-document" }, createdAt: "2026-08-20T11:00:00.000Z", available: true,
      asset: { ...GALLERY_MEDIA.find(asset => asset.kind === "document")!, id: "gallery-document", name: "Brand guide" } },
    { ref: { backend: "s3", sourceId: "archive", id: "gallery-video" }, createdAt: "2026-08-20T10:00:00.000Z", available: true,
      asset: { id: "gallery-video", sourceId: "archive", name: "Archive interview", description: "Local fixture",
        originalName: "interview.mov", mimeType: "video/quicktime", kind: "video", sizeBytes: 9_830_400,
        preview: "download_only", license: "NJ PBS owned", credit: "NJ PBS", tags: ["interview"], rightsStatus: "pending",
        version: 1, createdAt: "2026-08-20T10:00:00.000Z", updatedAt: "2026-08-20T10:00:00.000Z" } },
    { ref: { backend: "s3", sourceId: "archive", id: "missing-video" }, createdAt: "2026-08-20T09:00:00.000Z", available: false },
  ],
  nextCursor: null,
  hasMore: false,
};
const galleryFavorites = async () => GALLERY_FAVORITES_PAGE;
const galleryFavoriteSources = async () => ({ success: true as const, sources: [{ id: "archive", label: "Archive", description: "Local fixture",
  mediaKind: "video" as const, canBrowse: true as const, canUpload: false, canEditMetadata: false, canRequestProduction: false,
  canDelete: false }] });

function MediaFavoritesGallery() {
  const [router] = useState(() => createMemoryRouter([{
    path: "*",
    element: <MediaFavoritesLibrary
      principal={superAdmin}
      userId="gallery"
      getIdToken={async () => "local-gallery-fixture"}
      categoryRegistry={{ status: "ready", categories: GALLERY_MEDIA_CATEGORIES }}
      loadFavorites={galleryFavorites}
      loadSources={galleryFavoriteSources}
    />,
  }], { initialEntries: ["/media"] }));
  return <RouterProvider router={router} />;
}

const GALLERY_COLLECTION_ID = "c".repeat(64);
const GALLERY_COLLECTION_IMAGE: MediaAssetSummary = {
  ...GALLERY_MEDIA[0],
  id: "gallery-collection-image",
  name: "Statehouse newsroom still",
  originalName: "statehouse-newsroom-still.svg",
  category: "news",
  categories: ["news"],
  tags: ["newsroom", "statehouse"],
  description: "A local image fixture in a mixed collection.",
  altText: "Blue circles arranged over a navy field",
  mimeType: "image/svg+xml",
  sizeBytes: 48_210,
  width: 960,
  height: 540,
  url: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="#123354"/><circle cx="360" cy="270" r="116" fill="#67b7df"/><circle cx="600" cy="270" r="116" fill="#ffffff" opacity=".88"/></svg>')}`,
};
const GALLERY_COLLECTION_DOCUMENT: MediaAssetSummary = {
  ...GALLERY_MEDIA.find(asset => asset.kind === "document")!,
  id: "gallery-collection-document",
  name: "Field production guide",
  originalName: "field-production-guide.pdf",
  description: "A local PDF fixture in a mixed collection.",
  url: "#gallery-collection-document",
};
const GALLERY_COLLECTION_VIDEO: SourceMediaAssetSummary = {
  id: "gallery-collection-video",
  sourceId: "archive",
  name: "Archive interview excerpt",
  description: "A local private-video fixture in a mixed collection.",
  originalName: "archive-interview.mov",
  mimeType: "video/quicktime",
  kind: "video",
  sizeBytes: 18_432_000,
  preview: "download_only",
  license: "NJ PBS owned",
  credit: "NJ PBS",
  tags: ["interview", "archive"],
  rightsStatus: "pending",
  version: 2,
  uploadedBy: { name: "Archive team" },
  createdAt: "2026-08-18T14:00:00.000Z",
  updatedAt: "2026-08-20T13:00:00.000Z",
};
const GALLERY_COLLECTION: MediaCollectionSummary = {
  id: GALLERY_COLLECTION_ID,
  scope: "private",
  name: "Statehouse reporting package",
  description: "Images, documents and private video for the reporting team.",
  color: "blue",
  lifecycle: "active",
  version: 4,
  membershipVersion: 7,
  cover: GALLERY_COLLECTION_IMAGE,
  canEdit: true,
  createdAt: "2026-08-15T14:00:00.000Z",
  updatedAt: "2026-08-20T14:00:00.000Z",
  itemCount: 4,
};
const GALLERY_COLLECTIONS: readonly MediaCollectionSummary[] = [
  GALLERY_COLLECTION,
  { ...GALLERY_COLLECTION, id: "1".repeat(64), scope: "all_staff", name: "Reporting team selects", description: "An all-staff active package.", color: "purple", itemCount: undefined },
  { ...GALLERY_COLLECTION, id: "2".repeat(64), scope: "all_staff", lifecycle: "archived", name: "Archived pledge drive", description: "Shared stills and clips from the spring drive.", color: "gold", itemCount: undefined },
  { ...GALLERY_COLLECTION, id: "3".repeat(64), scope: "all_staff", lifecycle: "archived", name: "Retired station IDs", description: "Older station identity files kept for reference.", color: "slate", itemCount: undefined },
  { ...GALLERY_COLLECTION, id: "4".repeat(64), scope: "private", lifecycle: "archived", name: "Old draft package", description: "A private archived package.", color: "red", itemCount: 2 },
];
const GALLERY_COLLECTION_ITEMS_PAGE: MediaCollectionItemPage = {
  success: true,
  collection: GALLERY_COLLECTION,
  items: [
    { ref: { backend: "r2", id: GALLERY_COLLECTION_IMAGE.id }, addedAt: "2026-08-20T12:00:00.000Z", available: true, asset: GALLERY_COLLECTION_IMAGE },
    { ref: { backend: "s3", sourceId: GALLERY_COLLECTION_VIDEO.sourceId, id: GALLERY_COLLECTION_VIDEO.id }, addedAt: "2026-08-20T11:00:00.000Z", available: true, asset: GALLERY_COLLECTION_VIDEO },
    { ref: { backend: "r2", id: GALLERY_COLLECTION_DOCUMENT.id }, addedAt: "2026-08-20T10:00:00.000Z", available: true, asset: GALLERY_COLLECTION_DOCUMENT },
    { ref: { backend: "s3", sourceId: "archive", id: "missing-collection-video" }, addedAt: "2026-08-20T09:00:00.000Z", available: false },
  ],
  nextCursor: null,
  hasMore: false,
};

function galleryJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function galleryWavBytes(): Uint8Array {
  const sampleRate = 48_000;
  const channels = 1;
  const bytesPerSample = 2;
  const dataBytes = sampleRate * channels * bytesPerSample;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  for (const [offset, value] of [[0, "RIFF"], [8, "WAVE"], [12, "fmt "], [36, "data"]] as const) {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
  }
  view.setUint32(4, bytes.length - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);
  view.setUint32(40, dataBytes, true);
  return bytes;
}

function useGalleryMediaTransport(): () => Promise<string> {
  const [transport] = useState(() => {
    const originalFetch = window.fetch;
    let installed = false;
    const privateWav = galleryWavBytes();
    const favoriteIds = new Set<string>(["voiceover-soft-spoken-station-id-01"]);
    let voiceoverReview = {
      favorite: true,
      moreLikeThis: false,
      notes: "Use this warm station identification.",
      version: 1,
      updatedAt: "2026-09-12T12:00:00.000Z",
    };
    const mediaReviews = new Map<string, { moreLikeThis: boolean; notes: string; version: number; updatedAt: string | null }>();
    const commentsByRef = new Map<string, Array<{
      id: string; authorUid: string; authorName: string; text: string; version: number;
      createdAt: string; updatedAt: string; canEdit: boolean;
    }>>();
    const commentIdsByRequest = new Map<string, string>();
    let createdCommentCount = 0;
    const feedbackKey = (ref: unknown) => JSON.stringify(ref);
    const commentsFor = (ref: unknown) => {
      const key = feedbackKey(ref);
      const existing = commentsByRef.get(key);
      if (existing) return existing;
      const seeded = [
        { id: "a".repeat(64), authorUid: "gallery-audio", authorName: "Alex Rivera",
          text: "The clean opening works well for promos.", version: 1,
          createdAt: "2026-10-04T14:30:00.000Z", updatedAt: "2026-10-04T14:30:00.000Z", canEdit: true },
        { id: "b".repeat(64), authorUid: "producer", authorName: "Riley Chen",
          text: "Keep the room tone at the end for a smoother edit.", version: 1,
          createdAt: "2026-10-04T15:05:00.000Z", updatedAt: "2026-10-04T15:05:00.000Z", canEdit: false },
      ];
      commentsByRef.set(key, seeded);
      return seeded;
    };
    const audioRecords: MediaAssetSummary[] = [{ ...GALLERY_COLLECTION_DOCUMENT,
      id: "station-interview", name: "Station interview", originalName: "station-interview.wav",
      category: "news", categories: ["news"], tags: ["interview"], altText: null,
      mimeType: "audio/wav", kind: "audio", source: "upload", license: null, credit: null,
      url: "https://media.example.test/station-interview.wav", sizeBytes: 96_044,
      etag: '"media.station-interview.1"', description: "A station interview uploaded by staff." },
    { ...GALLERY_COLLECTION_DOCUMENT,
      id: "voiceover-soft-spoken-station-id-01", name: "Station identification",
      originalName: "soft-spoken-station-id-01.wav", category: "news", categories: ["news"],
      tags: ["voiceover", "soft-spoken"], description: "You're watching NJ PBS.", altText: null,
      mimeType: "audio/wav", kind: "audio", source: "voiceover", license: null,
      credit: "Jordan Avery", sizeBytes: privateWav.byteLength,
      url: "https://admin.njpbs.org/media/voiceovers?asset=voiceover-soft-spoken-station-id-01",
      etag: '"media.voiceover-soft-spoken-station-id-01.1"',
      voiceoverTakeId: "soft-spoken-station-id-01",
      voiceover: { manifestVersion: 1, id: "soft-spoken-station-id-01",
        family_id: "station-id", family: "Station identification", take: 1,
        style: "soft-spoken", performer_id: "jordan-avery", performer_name: "Jordan Avery",
        text: "You're watching NJ PBS.", display_text: "You're watching NJ PBS.",
        complete: true, flags: [], duration_seconds: 1 } }];
    const fixtureFetch: typeof window.fetch = async (input, init) => {
      const rawUrl = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      const url = new URL(rawUrl, window.location.href);
      const endpoint = url.pathname.split("/").pop();
      let request: Record<string, unknown> = {};
      if (typeof init?.body === "string") {
        try {
          request = JSON.parse(init.body) as Record<string, unknown>;
        } catch {
          return galleryJsonResponse({ error: "Invalid gallery fixture request." }, 400);
        }
      }
      if (endpoint === "cmsSourceMediaOriginal") return galleryJsonResponse({ success: true,
        original: { state: "available", archiveTier: null, checkedAt: "2026-08-20T19:00:00.000Z" }, notices: [] });
      if (endpoint === "cmsListMedia") {
        const availableRecords = [GALLERY_COLLECTION_IMAGE, GALLERY_COLLECTION_DOCUMENT, ...audioRecords];
        const requestedIds = Array.isArray(request.assetIds)
          ? new Set(request.assetIds.filter((id): id is string => typeof id === "string"))
          : null;
        const requestedKinds = Array.isArray(request.kinds)
          ? new Set(request.kinds.filter((kind): kind is MediaAssetSummary["kind"] =>
            kind === "image" || kind === "audio" || kind === "document"))
          : null;
        const records = requestedIds
          ? availableRecords.filter((asset) => requestedIds.has(asset.id))
          : requestedKinds
            ? availableRecords.filter((asset) => requestedKinds.has(asset.kind))
            : availableRecords;
        return galleryJsonResponse({
          success: true, records, paging: "cursor", nextCursor: null, total: records.length,
          allCount: records.length, categoryCounts: null, kindCounts: null, page: 1,
          pageCount: null,
          ...(request.counts === true ? { counts: {
            images: 1, audio: audioRecords.length, favorites: favoriteIds.size, sources: {},
          } } : {}),
          ...(request.favorites === true ? { favoriteStates: records.map(asset => ({
            ref: { backend: "r2", id: asset.id }, favorite: favoriteIds.has(asset.id),
          })) } : {}),
        });
      }
      if (endpoint === "cmsListSourceMedia") return galleryJsonResponse({
        success: true, records: [{ ...GALLERY_COLLECTION_VIDEO, sourceId: request.sourceId ?? "video-library" }],
        nextCursor: null, hasMore: false, total: 1,
      });
      if (endpoint === "cmsUploadMedia" && init?.body instanceof FormData) {
        const file = init.body.get("file") as File;
        const uploaded: MediaAssetSummary = { ...audioRecords[0], id: `uploaded-${audioRecords.length}`,
          name: String(init.body.get("name") ?? file.name), originalName: file.name, sizeBytes: file.size,
          category: String(init.body.get("category")), license: null,
          etag: `"media.uploaded-${audioRecords.length}.1"`,
          url: "https://media.example.test/uploaded.wav" };
        audioRecords.push(uploaded);
        return galleryJsonResponse({ success: true, asset: uploaded }, 201);
      }
      if (endpoint === "cmsListMediaFavorites") {
        const refs = Array.isArray(request.refs) ? request.refs : [];
        return galleryJsonResponse({ success: true, states: refs.map(ref => {
          const id = typeof ref === "object" && ref !== null && "id" in ref
            ? String(ref.id)
            : "";
          return { ref, favorite: favoriteIds.has(id) };
        }) });
      }
      if (endpoint === "cmsSetMediaFavorite") {
        const ref = request.ref as { backend: "r2"; id: string };
        const favorite = request.favorite === true;
        const changed = favoriteIds.has(ref.id) !== favorite;
        if (favorite) favoriteIds.add(ref.id); else favoriteIds.delete(ref.id);
        return galleryJsonResponse({ success: true, ref, favorite, changed });
      }
      if (endpoint === "cmsSetMediaFavorites") {
        const refs = request.refs as { backend: "r2"; id: string }[];
        const favorite = request.favorite === true;
        const results = refs.map(ref => {
          const changed = favoriteIds.has(ref.id) !== favorite;
          if (favorite) favoriteIds.add(ref.id); else favoriteIds.delete(ref.id);
          return { ref, favorite, changed };
        });
        return galleryJsonResponse({ success: true, favorite, results });
      }
      if (endpoint === "cmsGetMediaReview") {
        const key = feedbackKey(request.ref);
        const current = mediaReviews.get(key) ?? {
          moreLikeThis: false,
          notes: "Use this warm station identification.",
          version: 1,
          updatedAt: "2026-09-12T12:00:00.000Z",
        };
        mediaReviews.set(key, current);
        return galleryJsonResponse({ success: true, review: current });
      }
      if (endpoint === "cmsSaveMediaReview") {
        const key = feedbackKey(request.ref);
        const prior = mediaReviews.get(key);
        const current = {
          moreLikeThis: request.moreLikeThis === true,
          notes: String(request.notes ?? ""),
          version: (prior?.version ?? 0) + 1,
          updatedAt: "2026-10-05T14:00:00.000Z",
        };
        mediaReviews.set(key, current);
        return galleryJsonResponse({ success: true, review: current });
      }
      if (endpoint === "cmsListMediaComments") {
        if (typeof request.export === "string") {
          const comments = commentThreads(commentsFor(request.ref))
            .filter(thread => threadMatches(thread, request.export as CommentFilter))
            .flatMap(thread => [thread.comment, ...thread.replies]);
          return galleryJsonResponse({ success: true, exported: true, comments });
        }
        return galleryJsonResponse({ success: true, comments: commentsFor(request.ref), nextCursor: null });
      }
      if (endpoint === "cmsMutateMediaComment") {
        const comments = commentsFor(request.ref);
        if (request.action === "create") {
          const requestKey = `${feedbackKey(request.ref)}:${String(request.requestId)}`;
          const priorId = commentIdsByRequest.get(requestKey);
          if (priorId) {
            return galleryJsonResponse({
              success: true,
              comment: comments.find(comment => comment.id === priorId) ?? null,
            });
          }
          createdCommentCount += 1;
          const id = createdCommentCount.toString(16).padStart(64, "0");
          commentIdsByRequest.set(requestKey, id);
          const comment = { id, authorUid: "gallery-audio", authorName: "Alex Rivera",
            text: String(request.text ?? ""), version: 1, createdAt: "2026-10-05T14:15:00.000Z",
            updatedAt: "2026-10-05T14:15:00.000Z", canEdit: true };
          comments.push(comment);
          return galleryJsonResponse({ success: true, comment });
        }
        const index = comments.findIndex(comment => comment.id === request.commentId);
        if (request.action === "edit" && index >= 0) {
          const comment = { ...comments[index], text: String(request.text ?? ""),
            version: comments[index].version + 1, updatedAt: "2026-10-05T14:20:00.000Z" };
          comments[index] = comment;
          return galleryJsonResponse({ success: true, comment });
        }
        if (request.action === "delete" && index >= 0) comments.splice(index, 1);
        return galleryJsonResponse({ success: true, comment: null });
      }
      if (endpoint === "cmsVoiceoverReview" && request.action === "get-media") {
        return galleryJsonResponse({ success: true, review: voiceoverReview });
      }
      if (endpoint === "cmsVoiceoverReview" && request.action === "save-media") {
        voiceoverReview = { ...voiceoverReview,
          moreLikeThis: request.moreLikeThis === true, notes: String(request.notes ?? ""),
          version: voiceoverReview.version + 1, updatedAt: "2026-10-04T16:00:00.000Z" };
        return galleryJsonResponse({ success: true, review: voiceoverReview });
      }
      if (endpoint === "cmsGetVoiceoverAudio") {
        return new Response(new Uint8Array(privateWav).buffer, { status: 200, headers: {
          "Content-Type": "audio/wav", "Content-Length": String(privateWav.byteLength),
        } });
      }
      if (endpoint === "cmsListMediaCollections") {
        const page: MediaCollectionPage = {
          success: true,
          collections: GALLERY_COLLECTIONS.filter(collection =>
            collection.scope === request.scope && collection.lifecycle === request.lifecycle),
          nextCursor: null,
          hasMore: false,
        };
        return galleryJsonResponse(page);
      }
      if (endpoint === "cmsListMediaCollectionItems") return galleryJsonResponse(GALLERY_COLLECTION_ITEMS_PAGE);
      if (endpoint === "cmsListMediaSources") return galleryJsonResponse({
        success: true,
        sources: [{ id: "archive", label: "Archive", description: "Local gallery fixture", mediaKind: "video",
          canBrowse: true, canUpload: false, canEditMetadata: false, canRequestProduction: false, canDelete: false }],
      });
      if (url.hostname === "127.0.0.1" && url.port === "5001") {
        return galleryJsonResponse({ error: `No gallery fixture for ${endpoint ?? "this request"}.` }, 501);
      }
      return originalFetch(input, init);
    };
    return {
      getIdToken: async () => {
        if (!installed) {
          window.fetch = fixtureFetch;
          installed = true;
        }
        return "local-gallery-fixture";
      },
      restore: () => {
        if (window.fetch === fixtureFetch) window.fetch = originalFetch;
        installed = false;
      },
    };
  });
  useEffect(() => transport.restore, [transport]);
  return transport.getIdToken;
}

function AudioLibraryGallery() {
  const getIdToken = useGalleryMediaTransport();
  useState(clearMediaSessionCache);
  const [router] = useState(() => createMemoryRouter([{
    path: "/media/voiceovers", element: <MediaLibrarySurface audioLibrary principal={editor} userId="gallery-audio"
      getIdToken={getIdToken} categories={GALLERY_MEDIA_CATEGORIES}
      loadMedia={async (query, options) => cmsListMedia(await getIdToken(), query, undefined,
        { counts: Boolean(options?.tabCounts), favorites: Boolean(options?.tabCounts) })}
      loadCorpus={async () => ({success:true, records:[], nextCursor:null})}
      saveMetadata={saveGalleryMedia} deleteMedia={deleteGalleryMedia}
      uploadMedia={async (file, metadata, signal) => cmsUploadMedia(await getIdToken(), file, metadata, signal)} />,
  }], { initialEntries: ["/media/voiceovers"] }));
  return <div style={{ "--workspace-header-height": "0px" } as CSSProperties}><RouterProvider router={router} /></div>;
}

function VideoViewerInspectorGallery() {
  const getIdToken = useGalleryMediaTransport();
  return <VideoViewerInspectorSpecimen getIdToken={getIdToken} />;
}

function MediaCollectionsGallery({ initialEntry = "/media/collections" }: { initialEntry?: string }) {
  const getIdToken = useGalleryMediaTransport();
  const [router] = useState(() => createMemoryRouter([{
    path: "*",
    element: <MediaCollectionsGalleryRoute getIdToken={getIdToken} />,
  }], { initialEntries: [initialEntry] }));
  return <RouterProvider router={router} />;
}

function MediaCollectionsGalleryRoute({ getIdToken }: { getIdToken: () => Promise<string> }) {
  const location = useLocation();
  const route = parseMediaWorkspacePath(location.pathname);
  return <SuccessNoticeProvider routeKey={location.key}><MediaCollectionsLibrary
    collectionId={route.kind === "collections" ? route.collectionId : null}
    userId="gallery"
    userDoc={null}
    principal={{ id: "gallery", grants: [{ role: "super_admin" }] }}
    categories={GALLERY_MEDIA_CATEGORIES}
    canBrowseImages
    getIdToken={getIdToken}
  /></SuccessNoticeProvider>;
}

// Staff guide fixture for the Premiere connection page. Only the approval endpoint is
// answered, in the browser; every other request keeps the normal fetch. The code WXYZ-2345
// returns the expired-code response so the guide can show that recovery state.
const PREMIERE_EXPIRED_CODE = "WXYZ2345";

function PremiereConnectGallery() {
  const [transport] = useState(() => {
    const originalFetch = window.fetch;
    let installed = false;
    const fixtureFetch: typeof window.fetch = async (input, init) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(rawUrl, window.location.href);
      // Answer only the local Functions approval endpoint that PremiereConnectPanel calls in dev.
      if (url.hostname !== "127.0.0.1" || url.port !== "5001" || url.pathname.split("/").pop() !== "cmsApprovePremierePairing") {
        return originalFetch(input, init);
      }
      const request = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { action?: string; userCode?: string };
      if (String(request.userCode).replaceAll("-", "") === PREMIERE_EXPIRED_CODE) {
        return galleryJsonResponse({ error: "This sign-in code expired. Start again in Premiere.", code: "expired_token" }, 410);
      }
      const status = request.action === "approve" ? "approved" : request.action === "deny" ? "denied" : "pending";
      return galleryJsonResponse({ success: true, pairing: {
        deviceName: "Premiere Pro", hostVersion: "26.5.2", expiresAt: "2026-08-20T19:10:00.000Z", status,
      } });
    };
    return {
      getIdToken: async () => {
        if (!installed) { window.fetch = fixtureFetch; installed = true; }
        return "local-gallery-fixture";
      },
      restore: () => {
        if (window.fetch === fixtureFetch) window.fetch = originalFetch;
        installed = false;
      },
    };
  });
  useEffect(() => transport.restore, [transport]);
  return <section style={{ maxWidth: "44rem", margin: "2rem auto", padding: "1.5rem" }}>
    <BrowserRouter><PremiereConnectPanel getIdToken={transport.getIdToken} localTestMode={false} /></BrowserRouter>
  </section>;
}

interface Shot {
  id: string;
  title: string;
  note: string;
  width?: number;
  isolateDocument?: boolean;
  render: () => React.ReactNode;
}

function GuideFocalPoint() {
  const [position, setPosition] = useState({ x: 0.5, y: 0.5 });
  return <section style={{ maxWidth: "60rem", margin: "2rem auto", padding: "1.5rem" }}>
    <h2>Choose the crop</h2>
    <FocalPointControl src={guideLandscape} value={position} onChange={setPosition} />
  </section>;
}

const QUICK_LOOK_SPECIMEN_ITEMS: readonly QuickLookItem[] = [
  {
    id: "quick-look-statehouse",
    name: "Statehouse dome at dusk",
    kind: "image",
    previewUrl: guideLandscape,
  },
  {
    id: "quick-look-brand-guide",
    name: "NJ PBS brand guide",
    kind: "document",
    originalUrl: "#quick-look-original",
  },
  {
    id: "quick-look-forum",
    name: "Community forum: Housing and rent in Newark",
    kind: "video",
    previewUrl: guideLandscape,
  },
];

function MediaQuickLookSpecimen() {
  const [open, setOpen] = useState(true);
  const [position, setPosition] = useState(1);
  const item = QUICK_LOOK_SPECIMEN_ITEMS[position - 1];
  if (!open) {
    return <section aria-label="Quick Look gallery state">
      <p role="status">Quick Look closed.</p>
      <Button onClick={() => setOpen(true)}>Open Quick Look</Button>
    </section>;
  }
  return <QuickLook item={item} position={position} count={QUICK_LOOK_SPECIMEN_ITEMS.length}
    onStep={direction => setPosition(current => direction === "previous" ? Math.max(1, current - 1)
      : Math.min(QUICK_LOOK_SPECIMEN_ITEMS.length, current + 1))}
    onClose={() => setOpen(false)} />;
}

const UPLOAD_TRAY_ROWS: readonly UploadTrayRow[] = [
  { id: "active", name: "news-desk.png", status: "uploading", progress: 62 },
  { id: "complete", name: "station-id.png", status: "succeeded" },
  { id: "failed", name: "field-briefing.pdf", status: "failed", message: "The upload did not finish." },
  { id: "video", name: "studio-interview.mp4", status: "paused", progress: 41, message: "Paused. Resume with the original file." },
];

function MediaUploadTrayGallery() {
  const [collapsed, setCollapsed] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [rows, setRows] = useState(UPLOAD_TRAY_ROWS);
  const [announcement, setAnnouncement] = useState("news-desk.png is uploading.");
  const change = (id: string, next: Partial<UploadTrayRow>) => {
    setRows(current => current.map(row => row.id === id ? { ...row, ...next } : row));
  };
  const remove = (id: string) => setRows(current => current.filter(row => row.id !== id));
  const controlled = rows.map(row => ({
    ...row,
    ...(row.status === "uploading" && row.id !== "video" ? { onStop: () => {
      change(row.id, { status: "failed", progress: undefined, message: "The upload was stopped." });
      setAnnouncement(`${row.name} was stopped.`);
    } } : {}),
    ...(row.status === "uploading" && row.id === "video" ? { onPause: () => {
      change(row.id, { status: "paused", message: "Paused. Resume with the original file." });
      setAnnouncement(`${row.name} was paused.`);
    }, onCancel: () => {
      remove(row.id);
      setAnnouncement(`${row.name} was canceled.`);
    } } : {}),
    ...(row.status === "paused" && row.id === "video" ? { onResume: () => {
      change(row.id, { status: "uploading", message: undefined });
      setAnnouncement(`${row.name} is uploading again.`);
    }, onCancel: () => {
      remove(row.id);
      setAnnouncement(`${row.name} was canceled.`);
    } } : {}),
    ...(row.status === "failed" ? { onRetry: () => {
      change(row.id, { status: "uploading", progress: 0, message: undefined });
      setAnnouncement(`${row.name} is uploading again.`);
    } } : {}),
    ...(row.status === "succeeded" ? { onViewAsset: () => setAnnouncement(`Opening ${row.name}.`) } : {}),
    ...(row.status !== "uploading" && row.id !== "video" ? { onClear: () => {
      remove(row.id);
      setAnnouncement(`${row.name} was cleared.`);
    } } : {}),
  }));
  return (
    <main className="media-upload-gallery-canvas media-library">
      <div className="media-library-layout">
        <div className="media-results">
          <div className="panel media-upload-gallery-results">
            <strong>Media results remain available</strong>
            <span>The tray reads only the supplied local fixture.</span>
            <div className="media-upload-gallery-actions">
              <Button onClick={() => setSheetOpen(true)}>Open upload</Button>
              <Button variant="ghost" onClick={() => undefined}>Focus result control</Button>
            </div>
          </div>
          <SelectionBar
            actions={[]}
            count={3}
            error="Add to collection accepts no more than 30 items at a time. Clear part of the selection and try again."
            label="Collection selection"
            offPage={0}
            onAction={() => undefined}
            onClear={() => undefined}
            onPageChange={() => undefined}
            pageState="some"
          />
          <UploadTray
            announcement={announcement}
            collapsed={collapsed}
            onCollapsedChange={setCollapsed}
            onOpen={() => setSheetOpen(true)}
            rows={controlled}
            summary={`Uploading ${controlled.filter(row => row.status === "uploading").length} of ${controlled.length}`}
          />
        </div>
        <UploadSheet heading="Upload images and documents" onRequestClose={() => setSheetOpen(false)} open={sheetOpen}>
          <div className="media-upload-gallery-form">
            <p>The route-owned upload draft remains mounted while this sheet is closed.</p>
            <label>Batch name<input className="field-control" defaultValue="News desk batch" /></label>
            <UploadTrayRows label="Current uploads" rows={controlled} />
          </div>
        </UploadSheet>
      </div>
    </main>
  );
}

function MediaUploadSheetGallery() {
  const [open, setOpen] = useState(true);
  const [rows, setRows] = useState<readonly UploadTrayRow[]>([
    { id: "video-sheet", name: "studio-interview.mp4", status: "paused", progress: 41, message: "Paused. Resume with the original file." },
  ]);
  const controlled = rows.map(row => ({
    ...row,
    ...(row.status === "paused" ? { onResume: () => setRows(current => current.map(item => item.id === row.id ? { ...item, status: "uploading", message: undefined } : item)) } : {}),
    onCancel: () => setRows(current => current.filter(item => item.id !== row.id)),
  }));
  return (
    <main className="media-upload-gallery-canvas media-library">
      <Button onClick={() => setOpen(true)}>Open upload</Button>
      {!open ? <p role="status">The upload sheet is closed. Its transfer owner remains available.</p> : null}
      <div className="media-library-layout">
        <div className="media-results">
          <div className="panel media-upload-gallery-results">
            <strong>Media results</strong>
            <span>The fixed sheet uses the shared inspector column.</span>
          </div>
        </div>
        <UploadSheet
          heading="Upload to Video library"
          onRequestClose={() => setOpen(false)}
          open={open}
        >
          <div className="media-upload-gallery-form">
            <div className="media-upload-gallery-actions">
              <Button variant="danger-quiet" onClick={() => setRows([])}>Clear queue</Button>
              <Button variant="primary" onClick={() => undefined}>Upload media</Button>
            </div>
            <p>Choose images, PDFs, or videos. Each file goes to the matching library. After reopening Boardwalk, select the original video to resume a transfer.</p>
            <UploadTrayRows label="Video transfers" rows={controlled} />
          </div>
        </UploadSheet>
      </div>
    </main>
  );
}

function GalleryDropOverlay({ blocked = false }: { blocked?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = host.current?.querySelector(".media-drop-target");
    if (!target) return;
    const event = new Event("dragenter", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { types: ["Files"], files: [] },
    });
    target.dispatchEvent(event);
  }, []);
  return (
    <div ref={host}>
      <DropOverlay blocked={blocked} canUpload destination="Images" onFiles={() => undefined}>
        <div className="panel media-upload-gallery-results">
          <strong>{blocked ? "Unsaved image details" : "Image library results"}</strong>
          <span>Drag files over this region.</span>
        </div>
      </DropOverlay>
    </div>
  );
}

function MediaDropOverlayGallery() {
  return (
    <main className="media-upload-gallery-canvas media-upload-overlay-gallery">
      <GalleryDropOverlay />
      <GalleryDropOverlay blocked />
    </main>
  );
}

export const SHOTS: Shot[] = [
  {
    id: "scheduled-home-list",
    title: "Scheduled publication in Home",
    note: "Stored schedule and an unscheduled draft in the real Home list; local fixtures only.",
    render: () => <MemoryRouter><NewsroomHome
      canBrowsePages canBrowseRecords canCreate canViewEditorialQueue={false} canViewPublishActivity={false}
      currentUserId="sa"
      loadAdminStatus={async () => ({ schemaVersion: 2, status: "current", environment: "Local gallery",
        generatedAt: "2026-10-13T16:00:00.000Z", refreshAfter: "2026-10-14T16:00:00.000Z",
        build: { revision: "a".repeat(40), builtAt: "2026-10-13T16:00:00.000Z" },
        milestone: { number: 4, title: "Publishing", state: "open", openIssues: 1, closedIssues: 1,
          updatedAt: "2026-10-13T16:00:00.000Z", url: "https://github.com/CenterCoopMedia/njpbs/milestone/4" }, milestones: [] })}
      loadRecords={async () => selectLibraryRecords([
        { id: "scheduled-story", kind: "post", title: "Scheduled station update", status: "scheduled", version: 1,
          publishAt: "2026-10-14T10:00:00.000Z", updatedAt: "2026-10-13T15:00:00.000Z" },
        { id: "draft-story", kind: "post", title: "Draft station update", status: "draft", version: 1,
          updatedAt: "2026-10-13T14:00:00.000Z" },
      ], DEFAULT_CONTENT_QUERY, "sa")}
    /></MemoryRouter>,
  },
  {
    id: "scheduled-pages-list",
    title: "Scheduled publication in Pages",
    note: "Home and a custom Page carry the same stored schedule; local fixtures only.",
    render: () => <ShellSpecimen initialEntry="/content" surface={{ kind: "page-list" }}
      pageDirectoryApi={{ sections: [{ id: "home", label: "Home" }], canCreate: false, canOpenBuiltIn: id => id === "home",
        load: async () => [
          { id: "home", title: "Home", path: "/", section: "home", status: "scheduled", version: 1, published: false,
            publishAt: "2026-10-14T10:00:00.000Z" },
          { id: `page-${"a".repeat(32)}`, title: "Community guide", path: "/community/", section: "home", status: "scheduled",
            version: 1, published: false, publishAt: "2026-10-14T10:00:00.000Z" },
        ], create: async () => ({ id: `page-${"b".repeat(32)}` }) }}
    />,
  },
  {
    id: "scheduled-posts-list",
    title: "Scheduled publication in Posts",
    note: "Stored schedule and an unscheduled draft in the real Posts list; local fixtures only.",
    render: () => <ShellSpecimen initialEntry="/content/post" surface={{ kind: "record-list", record: "post" }}
      loadLibrarySelection={async query => selectLibraryRecords([
        { id: "scheduled-story", kind: "post", title: "Scheduled station update", status: "scheduled", version: 1,
          publishAt: "2026-10-14T10:00:00.000Z", updatedAt: "2026-10-13T15:00:00.000Z" },
        { id: "draft-story", kind: "post", title: "Draft station update", status: "draft", version: 1,
          updatedAt: "2026-10-13T14:00:00.000Z" },
      ], query, "sa")}
    />,
  },
  {
    id: "scheduled-post-editor",
    title: "Scheduled publication in the editor",
    note: "Stored schedule beside the shared publish controls; local fixtures only.",
    render: () => <ShellSpecimen initialEntry="/content/post/scheduled-story/edit"
      surface={{ kind: "record", record: "post", id: "scheduled-story" }}
      loadRecord={async () => ({ status: "ready", record: { ...GALLERY_POST_RECORD, id: "scheduled-story",
        title: "Scheduled station update", status: "scheduled", publishAt: "2026-10-14T10:00:00.000Z" } })}
    />,
  },
  {
    id: "home-editor-recovery",
    title: "Home editor recovery",
    note: "The complete committed Home selection fixture for draft recovery and local save checks.",
    render: () => <StudyReferenceShell kind="page" homeBlocks={homeSelectionFixture.home.blocks as AdminBlock[]} />,
  },
  {
    id: "study-reference-page",
    title: "Study reference — Home",
    note: "The supplied Home configuration in the real editor. Local fixture saves only; no feed, video or rights facts are invented.",
    render: () => <StudyReferenceShell kind="page" />,
  },
  {
    id: "study-reference-post",
    title: "Study reference — Post",
    note: "The supplied Post text, 8/4 row, images and metadata in the real editor. Unknown captured fields stay unspecified.",
    render: () => <StudyReferenceShell kind="post" />,
  },
  {
    id: "control-roles",
    title: "Control roles and states",
    note: "Shared controls with local-only state: idle, hover, focus, selected, busy, disabled and error.",
    render: () => <ControlRolesSpecimen />,
  },
  {
    id: "contextual-controls",
    title: "Contextual list controls",
    note: "Shared add/remove actions, useful ordered tag pills, and explicit text presentation across real field owners.",
    isolateDocument: true,
    render: () => <ContextualControlsSpecimen />,
  },
  {
    id: "editor-structure-post",
    title: "Post editor — unequal columns",
    note: "An 8/4 span, selected text, a hidden plank, an image gallery and buttons. Edits and saves stay local.",
    isolateDocument: true,
    render: () => <EditorStructureSpecimen kind="post" />,
  },
  {
    id: "editor-structure-page",
    title: "Page editor — multiple spans",
    note: "Unequal and equal columns, a hidden plank and an empty column. Edits and saves stay local.",
    isolateDocument: true,
    render: () => <EditorStructureSpecimen kind="page" />,
  },
  {
    id: "editor-structure-validation",
    title: "Post editor — required content",
    note: "Normal publication validation opens the incomplete text plank and its field messages.",
    isolateDocument: true,
    render: () => <EditorStructureSpecimen state="validation" />,
  },
  {
    id: "editor-structure-readonly",
    title: "Page editor — in review",
    note: "The same spans and controls under the existing read-only boundary.",
    isolateDocument: true,
    render: () => <EditorStructureSpecimen kind="page" state="readonly" />,
  },
  {
    id: "broadcast-schedule",
    title: "Broadcast schedule",
    note: "A local synthetic one-week schedule specimen using the production weekly surface.",
    render: () => (
      <MemoryRouter initialEntries={["/schedule?week=2026-09-28"]}>
        <ScheduleSurface schedule={scheduleFixture} today="2026-09-16" />
      </MemoryRouter>
    ),
  },
  {
    id: "premiere-connect",
    title: "Connect Premiere",
    note: "The real Premiere connection panel with a browser-local approval fixture. Enter any valid code to review the Premiere Pro 26.5.2 request, then approve or deny it. WXYZ-2345 shows the expired-code error. No CMS request leaves the page.",
    render: () => <PremiereConnectGallery />,
  },
  { id: "analytics", title: "Analytics", note: "Synthetic 30-day journalism audience and delivery data.", render: () => <AnalyticsSurface load={loadAnalyticsFixture} initialDays={30} fixedPeriod preview /> },
  { id: "analytics-partial", title: "Analytics with GA4 pending", note: "Cloudflare remains usable while audience reporting is unavailable.", render: () => <AnalyticsSurface load={loadAnalyticsPartial} initialDays={30} fixedPeriod preview /> },
  { id: "analytics-unavailable", title: "Analytics with GA4 unavailable", note: "Other providers remain visible during a temporary audience failure.", render: () => <AnalyticsSurface load={loadAnalyticsUnavailable} initialDays={30} fixedPeriod preview /> },
  { id: "analytics-limited", title: "Analytics with limited coverage", note: "Synthetic missing baseline, partial delivery, and truncated campaign data.", render: () => <AnalyticsSurface load={loadAnalyticsLimited} initialDays={30} fixedPeriod preview /> },
  { id: "analytics-zero", title: "Analytics with zero and empty data", note: "Reported zero totals and empty tables are separate from missing sources.", render: () => <AnalyticsSurface load={loadAnalyticsZero} initialDays={30} fixedPeriod preview /> },
  { id: "analytics-initial-error", title: "Analytics initial load failure", note: "Delayed local load fails once, then Retry recovers.", render: () => <AnalyticsRecoverySpecimen failFirst /> },
  { id: "analytics-refresh-error", title: "Analytics refresh failure", note: "Refresh fails once while the same-period report remains visible, then Retry recovers.", render: () => <AnalyticsRecoverySpecimen /> },
  { id: "analytics-shell", title: "Analytics in the admin shell", note: "The real shell with a local synthetic analytics report, including sidebar and account controls.", render: () => <ShellSpecimen initialEntry="/analytics" /> },
  {
    id: "guide-focal-point",
    title: "Guide — image crop control",
    note: "The real crop control with committed station artwork. Local state only; no upload or profile write.",
    render: () => <GuideFocalPoint />,
  },
  {
    id: "guide-unsaved-changes",
    title: "Guide — unsaved work choices",
    note: "The real leave warning, isolated for a staff guide screenshot. It contains no staff record and cannot save or discard CMS data.",
    render: () => <LeaveGuardDialog onCancel={() => {}} onConfirm={() => {}} onSave={async () => ({ status: "saved" })} />,
  },
  {
    id: "rich-text-context-menu",
    title: "Rich text — contextual formatting",
    note: "Two rich-text fields and a body longer than two viewports for caret, selection, scroll, resize, and reflow checks.",
    isolateDocument: true,
    render: () => <ContextualRichTextGallery />,
  },
  {
    id: "auth-loading",
    title: "Bootstrap — confirming staff access",
    note: "The screen everyone sees between opening admin.njpbs.org and the workspace. The checklist tracks the real admission phase from the auth state and the indicator shows approved Boardwalk tips outside the real status announcement; the broadcast-rings glyph is the one waiting mark used across the CMS.",
    render: () => <BootstrapView stage="admission" />,
  },
  {
    id: "loading-newsroom-home",
    title: "Loading — newsroom home",
    note: "Recent work while its records load: eight rows in the loaded list's thumbnail, title, metadata and state columns. Add ?delay=<ms> to watch the swap to loaded rows.",
    render: () => (
      <MemoryRouter>
        <NewsroomHome
          homeActions={<HomeShortcutsSpecimen />}
          canBrowsePages
          canBrowseRecords
          canCreate
          canViewEditorialQueue
          canViewPublishActivity={false}
          currentUserId="sa"
          loadRecords={galleryDelayed(async () => HOME_SELECTION)}
          loadReviewRequestCount={galleryDelayed(async () => 3)}
        />
      </MemoryRouter>
    ),
  },
  {
    id: "loading-posts",
    title: "Loading — Posts",
    note: "The Posts library while its records load: quick views, tools, the result count and the table header in their loaded places.",
    render: () => <ContentLibraryGallery delayed posts />,
  },
  {
    id: "loading-record-list",
    title: "Loading — typed record list",
    note: "A typed list such as Events: the table's real header over skeleton rows, with the New button's place held.",
    render: () => (
      <MemoryRouter initialEntries={["/content/event"]}>
        <RecordList canCreate kind="event" label="Event" loadRecords={galleryDelayed(async () => GALLERY_RECORD_PAGE)} />
      </MemoryRouter>
    ),
  },
  {
    id: "loading-content-library",
    title: "Loading — All content",
    note: "Quick views, the tools row, the result count and the table header in their loaded places while records load.",
    render: () => <ContentLibraryGallery delayed />,
  },
  {
    id: "loading-users",
    title: "Loading — staff access",
    note: "The directory search row and the directory table's header over skeleton rows while the staff snapshot loads.",
    render: () => <LoadingUsersGallery />,
  },
  {
    id: "loading-admin-settings",
    title: "Loading — Admin settings",
    note: "The newsroom banner panel with its real heading while the saved value loads.",
    render: () => {
      const transport = bannerTransport({});
      return <AdminSettingsForm {...transport} load={galleryDelayed(transport.load)} />;
    },
  },
  {
    id: "loading-site-navigation",
    title: "Loading site navigation",
    note: "The navigation editor's header rows, footer columns and actions while its saved menu loads. Use delay to inspect the swap to the default menu.",
    render: () => (
      <SiteNavigationSettings
        load={galleryDelayed(async () => ({
          success: true as const,
          found: true,
          id: SITE_NAVIGATION_SETTINGS_ID,
          settings: { schemaVersion: 1, values: DEFAULT_SITE_NAVIGATION, version: 4 },
        }))}
        loadPages={async () => []}
        save={async () => { throw new Error("Read-only specimen"); }}
        publish={async () => { throw new Error("Read-only specimen"); }}
      />
    ),
  },
  {
    id: "loading-editor",
    title: "Loading — editor workspace code",
    note: "The content studio canvas and editor fields while the editor workspace chunk downloads.",
    render: () => (
      <ContentStudioSkeleton surface={{ kind: "record", record: "post", id: "post-station-update" }} label="Opening the editor." />
    ),
  },
  {
    id: "loading-indicator",
    title: "Loading indicator — row, stack, inline and control",
    note: "The shared waiting state at each layout. Decorative Boardwalk tips rotate while a wait has no known progress; publish progress keeps the real queue stage. The control uses the same glyph at label size.",
    render: () => (
      <div className="panel" style={{ display: "grid", gap: "1.5rem", maxWidth: "40rem", padding: "2rem" }}>
        <section style={{ display: "grid", gap: "0.75rem" }}>
          <h2 style={{ margin: 0, fontSize: "var(--font-size-sm)", color: "var(--color-text-muted)", fontWeight: 600 }}>
            Row: a list or panel that is filling
          </h2>
          <LoadingIndicator
            label="Loading administrative activity"
            stages={["Asking the CMS for the audit log", "Applying your filters"]}
          />
        </section>
        <section style={{ display: "grid", gap: "0.75rem" }}>
          <h2 style={{ margin: 0, fontSize: "var(--font-size-sm)", color: "var(--color-text-muted)", fontWeight: 600 }}>
            Stack: an empty surface waiting for its code or record
          </h2>
          <div className="empty-state" style={{ minHeight: "12rem" }}>
            <LoadingIndicator
              label="Opening the editor"
              layout="stack"
              stages={["Loading the editor workspace", "Loading the rich-text editor and block tools"]}
            />
          </div>
        </section>
        <section style={{ display: "grid", gap: "0.75rem" }}>
          <h2 style={{ margin: 0, fontSize: "var(--font-size-sm)", color: "var(--color-text-muted)", fontWeight: 600 }}>
            Inline: progress inside a sentence
          </h2>
          <p style={{ margin: 0 }}>
            Public site: <LoadingIndicator label="Version 12 is publishing" layout="inline" />
          </p>
        </section>
        <section style={{ display: "grid", gap: "0.75rem" }}>
          <h2 style={{ margin: 0, fontSize: "var(--font-size-sm)", color: "var(--color-text-muted)", fontWeight: 600 }}>
            Control: a busy action
          </h2>
          <div style={{ display: "flex", gap: "0.75rem" }}>
            <AsyncActionButton label="Save" pending pendingLabel="Saving…" variant="primary" />
            <AsyncActionButton label="Publish" pending pendingLabel="Publishing…" />
          </div>
        </section>
      </div>
    ),
  },
  {
    id: "shell-video-library",
    title: "Video library in the admin shell",
    note: "The real video toolbar and signed-in rail together for mobile navigation checks.",
    render: () => <ShellSpecimen initialEntry="/media/videos" />,
  },
  {
    id: "shell-home",
    title: "Admin shell — newsroom home",
    note: "The real signed-in shell with official branding, first-class Pages, Posts, and All content destinations, and the work-oriented landing page. At a 390px browser viewport, use the one Menu disclosure and choose a content destination to see it close.",
    render: () => <ShellSpecimen />,
  },
  {
    id: "shell-home-required-nav",
    title: "Admin shell — contributor required navigation",
    note: "A contributor who hides every optional destination keeps Home and Broadcast schedule in the rail, so the short mobile footer and account panel can be checked against the smallest real navigation configuration.",
    render: () => (
      <ShellSpecimen
        navigation={CONTRIBUTOR_REQUIRED_NAVIGATION}
        principal={contributor}
        profileRole={null}
      />
    ),
  },
  {
    id: "shell-editor",
    title: "Admin shell — compact page editor",
    note: "The complete Content Studio frame: compact route bar, edge-to-edge working canvas, persistent view controls, and the nested page editor at its real available width. Change a field and choose Update to hold the shared pending state for inspection.",
    render: () => (
      <ShellSpecimen
        initialEntry="/content/pages/home/edit"
        savePage={saveNever}
      />
    ),
  },
  {
    id: "shell-nj-decides-page",
    title: "NJ Decides in the Boardwalk Page editor",
    note: "The real ShellLayout and EditorWorkspace with local Page metadata. No authentication, CMS writes or publication service is connected.",
    render: () => <ShellSpecimen initialEntry="/content/pages/page-11111111111111111111111111111111/edit"
      adminSettingsPanel={<Suspense fallback={<p>Loading NJ Decides brand settings…</p>}>
        <LazyNjDecidesBrandSpecimen load={loadNjDecidesBrandSpecimen}
          save={refuseNjDecidesBrandMutation} publish={refuseNjDecidesBrandMutation} />
      </Suspense>}
      pageId="page-11111111111111111111111111111111" section="genericPage" loadMedia={loadGalleryMedia}
      loadPage={async () => ({ blocks: [{ id: "election-heading", type: "headline", order: 0, visible: true,
        data: { text: "Election night coverage", level: 2 } }], metadata: { title: "NJ Decides 2026", slug: "election",
        description: "Follow election night coverage and find voting information.", pageTheme: "nj-decides" },
        createdBy: "sa", status: "draft", version: 3 })} />,
  },
  {
    id: "shell-data-hub-editor",
    title: "Data Hub in the Page editor",
    note: "Local public-content fixture: standard Page sections, arrangement and per-figure reporting. No live CMS writes.",
    render: () => <ShellSpecimen initialEntry="/content/pages/data-hub/edit" pageId="data-hub" section="genericPage"
      loadPage={loadSavedDraft} reportingTransport={{
        preview: async () => ({ stories: [], checkedAt: null, failed: false, cutoffAt: "2026-10-23T12:00:00.000Z" }),
        vocabulary: async () => ({ tags: ["wages"], categories: [] }), terms: async () => [],
      }} />,
  },
  {
    id: "shell-data-hub-retained",
    title: "Data Hub with retained legacy content",
    note: "Local migration fixture: compiled sections precede retained ordinary content. Opening makes no write.",
    render: () => <ShellSpecimen initialEntry="/content/pages/data-hub/edit" pageId="data-hub" section="genericPage"
      loadPage={async () => ({ ...await loadSavedDraft("data-hub"), blocks: [{ id: "retained-link", type: "link_card", order: 0, visible: true,
        data: { title: "Retained link", url: "https://example.org/", summary: "Legacy Page copy stays intact." } }] })} />,
  },
  {
    id: "shell-editor-saved",
    title: "Admin shell — saved long-title page editor",
    note: "A saved FCC page proves the compact shell with a long canonical title, a lifecycle action, and every persistent editor action.",
    render: () => (
      <ShellSpecimen
        initialEntry="/content/pages/public-file/edit"
        loadPage={loadSavedDraft}
        pageId="public-file"
        section="genericPage"
      />
    ),
  },
  {
    id: "shell-record-saved",
    title: "Admin shell — saved record editor",
    note: "A stored sponsor proves that Status, Lifecycle, Save, View, and account identity keep the same visual and source order at narrow widths.",
    render: () => (
      <ShellSpecimen
        initialEntry="/content/sponsor/sponsor-nj-foundation/edit"
        loadRecord={loadSponsor}
        saveRecord={saveSponsor}
        surface={{
          kind: "record",
          record: "sponsor",
          id: "sponsor-nj-foundation",
        }}
      />
    ),
  },
  {
    id: "shell-post-saved",
    title: "Admin shell — saved post editor",
    note: "An approved working Post with an older live snapshot keeps Edit, Preview, and the receipt-backed View live post action together, with Publish and Schedule in Publishing while the inspector names both versions.",
    render: () => (
      <ShellSpecimen
        initialEntry="/content/post/post-station-update/edit"
        loadRecord={loadPost}
        saveRecord={saveSponsor}
        surface={{
          kind: "record",
          record: "post",
          id: "post-station-update",
        }}
      />
    ),
  },
  {
    id: "shell-post-publish-failure",
    title: "Post editor — publication refused",
    note: "The publish error stays next to the toolbar when Post settings is closed.",
    render: () => (
      <ShellSpecimen
        initialEntry="/content/post/post-station-update/edit"
        loadRecord={loadPost}
        publishContent={async () => { throw new Error("Image publication is paused. The current public version is unchanged."); }}
        surface={{ kind: "record", record: "post", id: "post-station-update" }}
      />
    ),
  },
  {
    id: "shell-post-mobile-actions",
    title: "Post editor — grouped publication actions",
    note: "The production editing model groups Edit and Preview, puts publication controls in Publishing, and separates Unpublish from routine Post actions.",
    render: () => (
      <ShellSpecimen
        initialEntry="/content/post/post-station-update/edit"
        loadRecord={loadPost}
        saveRecord={saveSponsor}
        surface={{ kind: "record", record: "post", id: "post-station-update" }}
      />
    ),
  },
  {
    id: "shell-post-mobile-draft",
    title: "Post editor — draft actions",
    note: "Save draft stays in the editing group, with Publish in the Publishing menu. A saved draft remains separate from the public version.",
    render: () => (
      <ShellSpecimen
        initialEntry="/content/post/post-station-update/edit"
        loadRecord={async () => ({ status: "ready", record: { ...GALLERY_POST_RECORD, status: "draft", blocks: MOBILE_POST_BLOCKS } })}
        loadMedia={loadGalleryMedia}
        uploadMedia={uploadGalleryMedia}
        mediaCategories={GALLERY_MEDIA_CATEGORIES}
        canUploadCategory={() => true}
        saveRecord={saveSponsor}
        surface={{ kind: "record", record: "post", id: "post-station-update" }}
      />
    ),
  },
  {
    id: "shell-post-actions",
    title: "Post editor — post actions",
    note: "Duplicate and template actions stay inside the viewport when opened.",
    render: () => (
      <ShellSpecimen
        initialEntry="/content/post/post-station-update/edit"
        loadRecord={async () => ({ status: "ready", record: { ...GALLERY_POST_RECORD, status: "draft" } })}
        saveRecord={saveSponsor}
        capturePostTemplate={async () => { throw new Error("Template capture is unavailable in this visual fixture."); }}
        duplicatePost={async () => ({ ...GALLERY_POST_RECORD, id: "post-copy", version: 1, status: "draft" })}
        surface={{ kind: "record", record: "post", id: "post-station-update" }}
      />
    ),
  },
  {
    id: "shell-post-mobile-published",
    title: "Post editor — published actions",
    note: "Unpublish remains separate from Edit and keeps its confirmation and cancel path.",
    render: () => (
      <ShellSpecimen
        initialEntry="/content/post/post-station-update/edit"
        loadRecord={async () => ({ status: "ready", record: { ...GALLERY_POST_RECORD, status: "published" } })}
        saveRecord={saveSponsor}
        surface={{ kind: "record", record: "post", id: "post-station-update" }}
      />
    ),
  },
  {
    id: "shell-restore-confirmation",
    title: "Admin shell — restore confirmation",
    note: "An archived Post shows Restore to draft in the persistent lifecycle actions. The visual harness opens the required in-flow confirmation before capture.",
    render: () => (
      <ShellSpecimen
        initialEntry="/content/post/post-station-update/edit"
        loadRecord={loadArchivedPost}
        saveRecord={saveSponsor}
        surface={{
          kind: "record",
          record: "post",
          id: "post-station-update",
        }}
      />
    ),
  },
  {
    id: "newsroom-home",
    title: "Newsroom home — recent work",
    note: "The signed-in landing surface. Real record and publish states drive its resumable queues and immutable links; account permissions and billing are intentionally absent.",
    render: () => (
      <MemoryRouter>
        <NewsroomHome
          homeActions={<HomeShortcutsSpecimen />}
          canBrowsePages
          canEditHomepage
          canBrowseRecords
          canCreate
          canUseMediaLibrary
          canViewActivity
          canViewEditorialQueue
          canViewPublishActivity
          currentUserId="sa"
          loadReviewRequestCount={async () => 3}
          loadAdminStatus={async () => ({
            schemaVersion: 2,
            status: "current",
            environment: "Production",
            generatedAt: "2026-08-17T18:00:00.000Z",
            refreshAfter: "2026-08-20T18:00:00.000Z",
            build: {
              revision: "d805028221a24448055bf0adcce344d1921547b7",
              builtAt: "2026-08-17T18:00:00.000Z",
            },
            milestone: {
              number: 16,
              title: "M14: Admin interface + UX",
              state: "open",
              openIssues: 104,
              closedIssues: 226,
              updatedAt: "2026-08-17T17:30:00.000Z",
              url: "https://github.com/CenterCoopMedia/njpbs/milestone/16",
            },
            milestones: [
              {
                number: 16,
                title: "M14: Admin interface + UX",
                state: "open",
                openIssues: 104,
                closedIssues: 226,
                updatedAt: "2026-08-17T17:30:00.000Z",
                url: "https://github.com/CenterCoopMedia/njpbs/milestone/16",
              },
            ],
          })}
          loadRecords={async () => HOME_SELECTION}
          loadPublishActivity={async () => ({ activeCount: 1, recoveryCount: 2 })}
        />
      </MemoryRouter>
    ),
  },
  {
    id: "shell-posts-list",
    title: "Posts list in the admin shell",
    note: "Titles, workflow, public status, and dates with visible row actions.",
    render: () => <ShellSpecimen
      initialEntry="/content/post"
      surface={{ kind: "record-list", record: "post" }}
      listRecords={async () => ({ records: [
        { id: "post-station-update", title: "NJ PBS announces six staff appointments", status: "published", updatedAt: "2026-08-19T14:30:00Z" },
        { id: "post-community", title: "Community stories from across New Jersey", status: "draft", updatedAt: "2026-08-18T14:30:00Z" },
        { id: "post-fall", title: "This fall on NJ PBS", status: "in_review", updatedAt: "2026-08-17T14:30:00Z" },
      ], page: 1, pageCount: 1, total: 3 })}
    />,
  },
  {
    id: "shell-pages-list",
    title: "Pages list in the admin shell",
    note: "Canonical pages with section context and public status.",
    render: () => <ShellSpecimen initialEntry="/content" surface={{ kind: "page-list" }} />,
  },
  {
    id: "page-publication-status",
    title: "Page publication status",
    note: "Local confirmed Page fixture with a newer private draft. No CMS or public inventory request.",
    render: () => <div className="gallery-stack">
      <h2>Contact page</h2>
      <PublishedVersionStatus collection="cmsPages" documentId="contact" workingVersion={12} contentVersion={3}
        publishedSourceVersion={10} publishedContentVersion={2} loadPublicationMetadata={false} watchPublicReceipts={false}
        publicationTransport="page-no-build-v1" pageReceipt={{ operationId: "A".repeat(20), sourceVersion: 10, visible: true }} />
    </div>,
  },
  {
    id: "page-directory",
    title: "Content studio — live-page directory",
    note: "The page-first /content surface. Every canonical public page has its own actionable draft-editor row and address; the directory keeps publishing separate and uses page type and editorial area for scan context. Reusable records live in the All content destination.",
    render: () => <PagesBrowseSpecimen />,
  },
  {
    id: "page-directory-create",
    title: "Content studio: add page dialog",
    note: "Fixture pages and a reserved URL response show the complete add-page flow without a live CMS connection.",
    render: () => (
      <MemoryRouter initialEntries={["/content"]}>
        <EditorWorkspace
          principal={superAdmin}
          surface={{ kind: "page-list" }}
          pageDirectoryApi={{
            sections: [
              { id: "station", label: "Station" },
              { id: "watch", label: "Watch" },
            ],
            canCreate: true,
            load: async () => [
              {
                id: "page-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                title: "Community guide draft",
                path: "/community-guide-draft/",
                section: "station",
                status: "draft",
                published: false,
              },
              {
                id: "page-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                title: "Viewer guide",
                path: "/viewer-guide-draft/",
                livePath: "/viewer-guide/",
                section: "watch",
                status: "published",
                published: true,
              },
            ],
            create: async ({ slug }) => {
              if (slug === "posts") {
                throw new Error("This URL is reserved. Choose a different URL.");
              }
              return { id: "page-cccccccccccccccccccccccccccccccc" };
            },
          }}
        />
      </MemoryRouter>
    ),
  },
  {
    id: "support-page-layout",
    title: "Support page layout",
    note: "The real Boardwalk page editor with local support blocks. Moves and saves stay in this fixture.",
    isolateDocument: true,
    render: () => <EditorWorkspace principal={superAdmin}
      surface={{ kind: "page", pageId: "support", section: "programLanding" }}
      loadPage={async () => ({ blocks: structuredClone(supportLayoutFixture.blocks) as AdminBlock[],
        metadata: { title: supportLayoutFixture.title, description: supportLayoutFixture.description, serviceCompositionVersion: 1 },
        status: "draft", version: 8 })}
      savePage={saveOk} savePageMetadata={saveMetadataOk} loadMedia={loadGalleryMedia} newId={galleryIds} />,
  },
  {
    id: "page-service-compositions",
    title: "Content studio — populated service compositions",
    note: "The seven completed #817 service slices. Choose a page to inspect its real metadata, actions, copy, named sections, cards, imagery, and honest fixed-integration context as editable blocks in public order.",
    render: () => <ServiceCompositionGallery />,
  },
  {
    id: "page-ready",
    isolateDocument: true,
    title: "Content studio — page, hydrated",
    note: "The Home editor with its one public-owned manual shelf and explicit Text presentation. The fixed cinematic frame stays out of the block list. Compare it with the icon-first state that follows.",
    render: () => (
      <ControlPresentationProvider value="text">
        <EditorWorkspace
          principal={superAdmin}
          enforcePublicPageOwnership
          loadHomeSources={loadHomeCanvasSources}
          loadPage={loadReady}
          savePage={saveOk}
          savePageMetadata={saveMetadataOk}
          loadMedia={loadGalleryMedia}
          requestPagePreview={requestGalleryPreview}
          loadPagePreviewStatus={loadGalleryPreviewStatus}
          newId={galleryIds}
          surface={HOME_PAGE_SURFACE}
        />
      </ControlPresentationProvider>
    ),
  },
  {
    id: "page-ready-icons",
    isolateDocument: true,
    title: "Content studio — icon controls",
    note: "The same shelf-only Home editor with the account icon preference. Only registered low-risk controls become icons; save, preview, lifecycle, and remove actions keep visible text.",
    render: () => (
      <ControlPresentationProvider value="icons">
        <EditorWorkspace
          principal={superAdmin}
          enforcePublicPageOwnership
          loadHomeSources={loadHomeCanvasSources}
          loadPage={loadReady}
          savePage={saveOk}
          savePageMetadata={saveMetadataOk}
          loadMedia={loadGalleryMedia}
          requestPagePreview={requestGalleryPreview}
          loadPagePreviewStatus={loadGalleryPreviewStatus}
          newId={galleryIds}
          surface={HOME_PAGE_SURFACE}
        />
      </ControlPresentationProvider>
    ),
  },
  {
    id: "page-empty",
    title: "Content studio — page, empty",
    note: "What a page with no stored blocks shows. This is what greeted the first look at the editor before the home page was seeded.",
    render: () => (
      <EditorWorkspace
        principal={superAdmin}
        loadPage={loadEmpty}
        savePage={saveOk}
        newId={galleryIds}
        surface={HOME_PAGE_SURFACE}
      />
    ),
  },
  {
    id: "staff-page",
    isolateDocument: true,
    title: "Content studio — Staff page, empty authored blocks",
    note: "The generic Page editor for Staff: metadata-owned hero labels, locked generated roster, empty authored blocks, outline, and the shared save/preview/lifecycle controls. Local fixture; no production save.",
    render: () => <StaffPageGallery kind="empty" />,
  },
  {
    id: "staff-page-blocks",
    isolateDocument: true,
    title: "Content studio — Staff page, authored blocks",
    note: "The same Staff Page editor with a long title and summary, a heading, and a text block after the locked roster. Local fixture; no production save.",
    render: () => <StaffPageGallery kind="blocks" />,
  },
  {
    id: "staff-page-readonly",
    isolateDocument: true,
    title: "Content studio — Staff page, in review",
    note: "The Staff Page editor in the in-review lifecycle, with authored blocks visible and editing disabled. Local fixture; no production save.",
    render: () => <StaffPageGallery kind="readonly" />,
  },
  {
    id: "page-loading",
    title: "Content studio — page, loading",
    note: "The read is in flight. Now on the arrival path, since the studio opens on a page and hydrates on mount.",
    render: () => (
      <EditorWorkspace
        principal={superAdmin}
        loadPage={loadNever}
        newId={galleryIds}
        surface={HOME_PAGE_SURFACE}
      />
    ),
  },
  {
    id: "page-error",
    title: "Content studio — page, read failed",
    note: "Editing is disabled on purpose: a blank editor would overwrite the stored page on save. The retry is the only way back (#574).",
    render: () => (
      <EditorWorkspace
        principal={superAdmin}
        loadPage={loadFails}
        newId={galleryIds}
        surface={HOME_PAGE_SURFACE}
      />
    ),
  },
  {
    id: "page-conflict",
    title: "Content studio — save conflict",
    note: "Change a field and choose Update. Someone replaced this saved page while it was open (#530/#563). The overwrite answer then stays pending so its progress state can be inspected.",
    render: () => {
      let saveAttempt = 0;
      const saveConflictThenWait: NonNullable<
        ComponentProps<typeof EditorWorkspace>["savePage"]
      > = async () => {
        saveAttempt += 1;
        if (saveAttempt === 1) return saveConflicts();
        return new Promise<PageContent>(() => {});
      };
      return (
        <ShellSpecimen
          initialEntry="/content/pages/home/edit"
          loadPage={loadSavedDraft}
          savePage={saveConflictThenWait}
        />
      );
    },
  },
  {
    id: "page-editor-locked",
    title: "Content studio — another editor is active",
    note: "The named courtesy gate appears before editing begins. An administrator can take over explicitly or back out; optimistic version checks still protect the eventual save.",
    render: () => (
      <MemoryRouter>
        <EditorWorkspace
          principal={superAdmin}
          editorLockActor={{ id: "sa", name: "Sue Super" }}
          editorLockClient={LOCKED_EDITOR_CLIENT}
          loadPage={loadReady}
          savePage={saveOk}
          newId={galleryIds}
          surface={HOME_PAGE_SURFACE}
        />
      </MemoryRouter>
    ),
  },
  {
    id: "record",
    title: "Content studio — record surface",
    note: "A create route for a program: structured fields, no blocks. The shell's Programs destination opens the list first; its New program action reaches this canvas.",
    render: () => (
      <EditorWorkspace
        principal={superAdmin}
        surface={{ kind: "record", record: "program", id: null }}
        newId={galleryIds}
      />
    ),
  },
  {
    id: "post-metadata",
    title: "Content studio — stored post",
    note: "An approved working Post with an older live snapshot: the editor names both versions, states that approval does not publish, and keeps Publish as the primary next action.",
    render: () => (
      <MemoryRouter>
        <EditorWorkspace
          assignRecord={assignPost}
          canAssignRecords
          loadAssignableUsers={loadAssignableStaff}
          loadMedia={loadGalleryMedia}
          loadRecord={loadPost}
          newId={galleryIds}
          principal={superAdmin}
          publishContent={publishGalleryPost}
          scheduleContent={scheduleGalleryPost}
          saveRecord={saveSponsor}
          surface={{
            kind: "record",
            record: "post",
            id: "post-station-update",
          }}
          transitionContent={transitionGalleryPost}
        />
      </MemoryRouter>
    ),
  },
  {
    id: "post-gallery-containment",
    title: "Content studio — twelve-image gallery containment",
    note: "A Post gallery at the review maximum for this layout slice. The fixture checks nested desktop width, narrow reflow, zoom, and keyboard targets without defining a saved gallery maximum or a new public presentation mode.",
    isolateDocument: true,
    render: () => <PostGalleryContainment />,
  },
  {
    id: "post-gallery-carousel",
    title: "Content studio — gallery in carousel presentation",
    note: "The same twelve items in the carousel mode an editor can now choose (#1034). The editing row scrolls sideways exactly as the published row does, each item keeps its stacked controls, and the block's settings state what a visitor's click does: nothing, because a gallery image is not a link and the site has no lightbox.",
    isolateDocument: true,
    render: () => (
      <PostGalleryContainment
        block={GALLERY_CAROUSEL_BLOCK}
        note="The carousel presentation at the review maximum of twelve items. Only the row scrolls; the canvas does not."
      />
    ),
  },
  {
    id: "page-dynamic-shelves",
    title: "Content studio — dynamic topic shelf and video playlist",
    note: "The two blocks from #1046 in one page body. The topic shelf resolves the approved related-story index at build time and previews the exact cards the page will carry; the video playlist resolves the approved video library, which ships empty until per-asset rights, caption, runtime, thumbnail, and access metadata are sourced, so it previews the empty state a visitor would see. Every choice under each block is a picker over an approved list -- there is no free-text query field.",
    isolateDocument: true,
    render: () => <PageDynamicShelves />,
  },
  {
    id: "data-table-files",
    title: "Data table file editing",
    note: "Shared Post and Page modal with CSV upload, export and parsed preview. Use tableOwner=page for the Page palette.",
    render: () => <DataTableGallery />,
  },
  {
    id: "component-video-preview",
    title: "Component editor: Video phone preview",
    note: "Local video draft using the public player renderer and the shared phone preview. No CMS data is changed.",
    render: () => <BlockEditor section="genericPage" commandsInline newId={galleryIds} initialBlocks={[
      { id: "video-preview-gallery", type: "embed", visible: true, order: 0,
        data: { url: "https://www.youtube.com/watch?v=od8NMua_mEw&t=268", caption: "Latest newscast" } },
    ]} />,
  },
  {
    id: "page-preview-frame",
    title: "Page preview frame",
    note: "Shared page canvas frame. Player scripts stay inactive outside the phone preview.",
    render: () => <HomePreviewFrame title="Page canvas preview" html="<h2>Page preview</h2>" />,
  },
  {
    id: "post-presentations",
    title: "Post presentations",
    note: "Local Post format selection and draft save/reopen.",
    isolateDocument: true,
    render: () => <PostPresentationGallery />,
  },
  {
    id: "single-preview-workspace",
    title: "One Preview action",
    note: "Real Page/Post workspace with isolated in-memory saves, addressed preview receipts and a real new-tab handoff. No CMS or public data is changed.",
    isolateDocument: true,
    render: () => <SinglePreviewGallery />,
  },
  {
    id: "outline-workspace",
    title: "Page outline hierarchy",
    note: "The two-row handoff fixture in the real Post editor. Saving and reopening are local to this fixture.",
    isolateDocument: true,
    render: () => <OutlineGallery />,
  },
  {
    id: "custom-shelves",
    title: "Custom shelves",
    note: "Local cards in a Post body, with layout controls and a save/reopen fixture.",
    isolateDocument: true,
    render: () => <CustomShelfGallery />,
  },
  {
    id: "home-canvas",
    title: "Home page editor",
    note: "The marked Home draft as compact section cards and the shared component dialog. Saved Preview remains the public-look check.",
    isolateDocument: true,
    render: () => <HomeCanvasGallery />,
  },
  {
    id: "home-v2-conversion",
    title: "Editorial Home conversion",
    note: "A real Station editor workspace with a local published v1 fixture and an unpublished v2 conversion. No CMS write or publication.",
    isolateDocument: true,
    render: () => <HomeV2ConversionSpecimen loadHomeSources={loadHomeCanvasSources} />,
  },
  {
    id: "home-v2-arrangement",
    title: "Home section arrangement",
    note: "The real v2 editor with atomic Passport arrangement and local save/reopen. No CMS write or publication.",
    isolateDocument: true,
    render: () => <HomeV2ArrangementGallery />,
  },
  {
    id: "home-shelf-layouts",
    title: "Home shelf layouts and story buttons",
    note: "Curated shelf and editorial hero controls. Local fixtures only; no CMS write.",
    isolateDocument: true,
    render: () => <HomeShelfLayoutsGallery />,
  },
  {
    id: "home-v2-parity",
    title: "Saved Home parity",
    note: "One saved snapshot and captured sources supplied by the local parity probe. No CMS access.",
    isolateDocument: true,
    render: () => <HomeV2ParitySpecimen />,
  },
  {
    id: "home-v2-selections",
    title: "Home source selections",
    note: "The saved v2 selection with current published corrections and one withdrawn Post. Local save and reopen only.",
    isolateDocument: true,
    render: () => <HomeV2SelectionGallery />,
  },
  {
    id: "home-hero-source",
    title: "Home source hero overrides",
    note: "Published Post identity, per-field Home overrides and resets using the canonical resolver. Local fixture only.",
    isolateDocument: true,
    render: () => <HomeHeroSourceGallery />,
  },
  {
    id: "home-hero",
    title: "Home hero slides",
    note: "The real Home hero metadata controls with local sample content. Edits stay in the fixture.",
    isolateDocument: true,
    render: () => <HomeHeroGallery />,
  },
  {
    id: "service-canvas",
    title: "Watch page editor",
    note: "Saved Watch regions as compact cards. Select a section to open the shared component dialog; save and undo are local gallery actions.",
    isolateDocument: true,
    render: () => <ServiceCanvasGallery pageId="watch" />,
  },
  {
    id: "service-canvas-about",
    title: "About page editor",
    note: "About named regions as compact cards with local draft editing.",
    isolateDocument: true,
    render: () => <ServiceCanvasGallery pageId="about" />,
  },
  {
    id: "home-conversion",
    title: "Enable Home editing",
    note: "A saved legacy Home draft shows its real section defaults and preserved manual shelf before explicit conversion. The gallery uses local state and committed source cards; it performs no CMS write or publication.",
    isolateDocument: true,
    render: () => <HomeConversionGallery />,
  },
  {
    id: "home-canvas-unavailable",
    title: "Home page editor without published cards",
    note: "Home section cards stay editable when published card sources are unavailable. Saved Preview remains the public-look check.",
    isolateDocument: true,
    render: () => <HomeCanvasGallery unavailable />,
  },
  {
    id: "tags-empty",
    title: "Tag control — empty",
    note: "The shared page and post token input before the first tag is added.",
    render: () => <TagControlGallery />,
  },
  {
    id: "tags-filled",
    title: "Tag control — filled",
    note: "Three short newsroom tags fit on one normal row and keep their full-size accessible remove targets.",
    render: () => (
      <TagControlGallery initialTags={["news", "elections", "community"]} />
    ),
  },
  {
    id: "tags-overflow",
    title: "Tag control — narrow overflow",
    note: "Long tags wrap without separating the visible label from its accessible remove action.",
    width: 320,
    render: () => (
      <TagControlGallery
        initialTags={[
          "New Jersey public affairs and community reporting",
          "elections",
          "arts and culture",
        ]}
      />
    ),
  },
  {
    id: "tags-focus",
    title: "Tag control — entry focus",
    note: "The real text entry focus state after one tag has been added.",
    render: () => <TagControlGallery initialTags={["news"]} focus />,
  },
  {
    id: "tags-validation",
    title: "Tag control — validation",
    note: "The shared required-field relationship connects the group, entry control, help, and visible error.",
    render: () => <TagControlGallery error="Add at least one tag." />,
  },
  {
    id: "content-library",
    title: "Content studio — All content",
    note: "The All content surface at /content/library: shareable URL filters, distinct Assigned to me and My recent edits queues, status counts, saved views, server-selected paging, and version-guarded current-page bulk archive with explicit partial outcomes.",
    render: () => <ContentLibraryGallery />,
  },
  {
    id: "content-library-narrow",
    title: "Content studio — All content at 320px",
    note: "The real All content toolbar and record cards at the narrow proof width. Quick views use a stable two-column rhythm, search keeps the normal control height, and related actions retain clear spacing without horizontal page scrolling.",
    width: 320,
    render: () => <ContentLibraryGallery />,
  },
  {
    id: "browsing-posts",
    title: "Posts — shared browsing controls",
    note: "The real Posts list and New post split control with the same local records as All content. No backend read or write.",
    render: () => <ContentLibraryGallery posts />,
  },
  {
    id: "activity-populated",
    title: "Activity — populated stream",
    note: "The real administrative Activity surface with server-shaped content and access events, newest first.",
    render: () => <ActivitySurface loadActivity={loadGalleryActivity} />,
  },
  {
    id: "activity-empty",
    title: "Activity — no recorded events",
    note: "The real first-use Activity state after a successful read returns no administrative events.",
    render: () => <ActivitySurface loadActivity={loadEmptyGalleryActivity} />,
  },
  {
    id: "activity-loading",
    title: "Activity — loading",
    note: "The Activity read is still in progress and announces its status without exposing an empty result.",
    render: () => <ActivitySurface loadActivity={loadPendingGalleryActivity} />,
  },
  {
    id: "activity-error",
    title: "Activity — read failed",
    note: "A failed administrative read stays explicit and recoverable through the real retry action.",
    render: () => <ActivitySurface loadActivity={loadFailedGalleryActivity} />,
  },
  {
    id: "activity-filtered",
    title: "Activity — action filter",
    note: "The real Activity filter starts on content saves so the reduced result and current filter are visible together.",
    render: () => (
      <ActivitySurface
        loadActivity={loadGalleryActivity}
        initialAction="cms.save"
      />
    ),
  },
  {
    id: "activity-evidence",
    title: "Activity — change evidence at 320px",
    note: "The real before-and-after evidence is open at the 320px reflow proof width. Long paths and JSON remain in their semantic sections.",
    width: 320,
    render: () => (
      <ActivitySurface
        loadActivity={loadGalleryActivity}
        initialExpandedEntryIds={["activity-save"]}
      />
    ),
  },
  {
    id: "video-library",
    title: "Video library",
    note: "Private source browser on the shared media grid: video tiles with lazy posters, the selection bar, card menus with the uploader filter, and hover cards. The View select's Compact list shows the same page as shared list rows, with the same selection, menus and hover cards. Local browser checks supply synthetic API responses; this specimen has no staff credentials and stays uncaptured.",
    render: () => <SourceMediaLibraryGallery />,
  },
  {
    id: "audio-library",
    title: "Audio library",
    note: "The shared Audio grid and inspector with staff WAV upload, private voiceover playback, private review details, staff comments, and shared favorites. Browser-local API fixtures only; no production data or writes.",
    render: () => <AudioLibraryGallery />,
  },
  {
    id: "media-library",
    title: "Media library — compact asset browser",
    note: "The images page: the sticky toolbar (Filter, Sort, search, Display, More and Upload), URL-backed chips, a closed Related results disclosure at the top of the results, site-wide media asset cards with Display's card fields, one result bar after the grid, and the selected asset inspector with version-guarded edits.",
    render: () => (
      <MediaLibraryGallery initialEntry="/media/images?selected=media-local-news" />
    ),
  },
  {
    id: "media-indexed-library",
    title: "Media library — indexed cursor pages",
    note: "Private discovery response states on the real Images surface: unknown counts, continuation, search reset, and terminal pages. Synthetic records only.",
    isolateDocument: true,
    render: () => <MediaLibraryGallery loadMedia={loadIndexedGalleryMedia} />,
  },
  {
    id: "media-indexed-picker",
    title: "Image picker — indexed cursor pages",
    note: "The shared picker with synthetic private cursor response states and no live reads or writes.",
    isolateDocument: true,
    render: () => <MediaPickerGallery loadMedia={loadIndexedGalleryMedia} />,
  },
  {
    id: "media-favorites",
    title: "Media library — favorites",
    note: "A deterministic mixed page of images, documents and private videos, including an unavailable reference. Local records only.",
    render: () => <MediaFavoritesGallery />,
  },
  ...(["grid", "list", "selection", "viewer-image", "viewer-document", "viewer-video"] as const).map(state => ({
    id: `media-favorites-${state}`,
    title: `Media library — Favorites ${state}`,
    note: "The same local mixed Favorites page with one shared grid and full viewer. No staff account or live records.",
    render: () => <MediaFavoritesGallery />,
  })),
  {
    id: "media-collections",
    title: "Media library — collections",
    note: "Private and all-staff media packages from the local collection fixture. This specimen has no staff credentials or live records.",
    isolateDocument: true,
    render: () => <MediaCollectionsGallery />,
  },
  {
    id: "media-collections-list",
    title: "Media library — collections list filters",
    note: "The deterministic archived list has Status and Scope chips applied. Status selects the loaded lifecycle; Scope filters the two loaded scope pages. Local records only.",
    isolateDocument: true,
    render: () => <MediaCollectionsGallery initialEntry="/media/collections?show=archived&scope=all_staff" />,
  },
  {
    id: "media-collections-detail",
    title: "Media library — mixed collection detail",
    note: "One shared collection contains a local image, private video, PDF and unavailable reference in the shared grid. Local records only.",
    isolateDocument: true,
    render: () => <MediaCollectionsGallery initialEntry={`/media/collections/${GALLERY_COLLECTION_ID}`} />,
  },
  {
    id: "media-collections-viewer-image",
    title: "Media library — collection image viewer",
    note: "The mixed collection opens its local image in the shared full viewer. The same open shell can step to the video and PDF bodies.",
    isolateDocument: true,
    render: () => <MediaCollectionsGallery initialEntry={`/media/collections/${GALLERY_COLLECTION_ID}?asset=r2:${GALLERY_COLLECTION_IMAGE.id}`} />,
  },
  {
    id: "media-collections-viewer-video",
    title: "Media library — collection video viewer",
    note: "The same mixed collection viewer shows the private video body and its backend-owned tools and access label. Local records only.",
    isolateDocument: true,
    render: () => <MediaCollectionsGallery initialEntry={`/media/collections/${GALLERY_COLLECTION_ID}?asset=s3:${GALLERY_COLLECTION_VIDEO.sourceId}:${GALLERY_COLLECTION_VIDEO.id}`} />,
  },
  {
    id: "media-collections-viewer-document",
    title: "Media library — collection document viewer",
    note: "The same mixed collection viewer shows the PDF fallback body and image-library tools. Local records only.",
    isolateDocument: true,
    render: () => <MediaCollectionsGallery initialEntry={`/media/collections/${GALLERY_COLLECTION_ID}?asset=r2:${GALLERY_COLLECTION_DOCUMENT.id}`} />,
  },
  {
    id: "media-browsing",
    title: "Media library — browsing",
    note: "The real unselected library under the images toolbar: search, Filter with counts on its options, Sort, Display, the shared tile grid and one result bar after it, with only the assets visible to the news-scoped editor. Each tile has a selection mark, Favorite, Add to collection and More, a right-click menu with the same items, and hover facts after a 600 ms pause. Selecting shows the floating selection bar. Uncaptured: the favorites call and the meaning-search model are not deterministic in CI.",
    render: () => <MediaLibraryGallery />,
  },
  {
    id: "media-filtered",
    title: "Media library — filtered with chips",
    note: "The images page with Type and Category applied from the URL, so the chip row and the Filter count show under the toolbar. Uncaptured; the media-filter responsive spec checks its geometry.",
    render: () => <MediaLibraryGallery initialEntry="/media/images?kind=image&category=news" />,
  },
  {
    id: "media-selection",
    title: "Media library — selected asset",
    note: "A news asset is opened in the shared details inspector for the news-scoped editor, matching the site-wide capability authorization applied by the real media-list endpoint. Its sections and pinned Save details footer sit beside the tile grid under the sticky toolbar, and the opened tile keeps its own mark apart from the selection ring. Uncaptured.",
    render: () => (
      <MediaLibraryGallery initialEntry="/media/images?selected=media-local-news" />
    ),
  },
  {
    id: "media-metadata",
    title: "Media library — editable metadata at 320px",
    note: "A news asset opens in the shared modal details sheet at the 320px reflow proof width. Its sections, tag tokens, focus scope, version guard and pinned footer are the production parts.",
    width: 320,
    render: () => (
      <MediaLibraryGallery initialEntry="/media/images?selected=media-local-news" />
    ),
  },
  {
    id: "media-upload-running",
    title: "Media library — active upload queue",
    note: "The real Images surface and upload form with a local file in the uploading state. No transfer or staff data is used.",
    isolateDocument: true,
    render: () => <MediaLibraryGallery initialUploadState={{
      file: new File([Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII="), char => char.charCodeAt(0))], "news-desk.png", { type: "image/png" }),
      name: "News desk",
      license: "NJ PBS owned",
      uploading: true,
    }} />,
  },
  {
    id: "media-upload-progress",
    title: "Media library — upload tray",
    note: "The controlled tray shows active image, completed, failed and paused video rows. Image Stop, Retry, Clear and View asset plus video Resume and Cancel call only the local fixture owner. Under 62rem it becomes the upload summary pill.",
    isolateDocument: true,
    render: () => <MediaUploadTrayGallery />,
  },
  {
    id: "media-upload-sheet",
    title: "Media library — upload sheet",
    note: "The shared fixed-width Inspector hosts a controlled paused video row. Closing hides the sheet while preserving its transfer owner and returns focus through the shared Inspector behavior. The fixture acquires no lock and makes no request.",
    isolateDocument: true,
    render: () => <MediaUploadSheetGallery />,
  },
  {
    id: "media-drop-overlay",
    title: "Media library — file drop overlays",
    note: "Allowed and blocked file drags use the real overlay. The blocked state names the unsaved-details reason. Both are deterministic local events with no file intake or request.",
    isolateDocument: true,
    render: () => <MediaDropOverlayGallery />,
  },
  {
    id: "media-empty",
    title: "Media library — empty",
    note: "The real library after a successful first-use read returns no approved assets. The toolbar stays, and the result bar reads 0 results under the empty state. Uncaptured.",
    render: () => <MediaLibraryGallery loadMedia={loadEmptyGalleryMedia} />,
  },
  {
    id: "media-loading",
    title: "Media library — loading",
    note: "The Media read is still in progress. The toolbar is ready and the shared loading indicator waits without showing an empty result. Uncaptured.",
    render: () => <MediaLibraryGallery loadMedia={loadPendingGalleryMedia} />,
  },
  {
    id: "media-error",
    title: "Media library — read failed",
    note: "A failed media read is announced as an error and keeps the real retry action available. Chips and search still work while it fails. Uncaptured.",
    render: () => <MediaLibraryGallery loadMedia={loadFailedGalleryMedia} />,
  },
  {
    id: "media-controls",
    title: "Media library — shared controls",
    note: "The checkbox, filter and tag chips, and segmented control that the redesigned media library shares across tabs. Local state only.",
    render: () => <MediaControlsSpecimen />,
  },
  {
    id: "media-overlays",
    title: "Media library — popover, menus and hover card",
    note: "The Display popover opens over the page and becomes a bottom sheet on phones. The More menu, right-click menu and hover card open on use. Local state only.",
    render: () => <MediaOverlaysSpecimen />,
  },
  {
    id: "media-toolbar",
    title: "Media library — toolbar with More overflow",
    note: "The shared media toolbar. At narrow widths its center controls move into the More menu instead of wrapping, and arrow keys move between controls. Local state only.",
    render: () => <MediaToolbarSpecimen />,
  },
  {
    id: "media-tabs",
    title: "Media library — source tabs and upload",
    note: "One row of links for each media page, with Favorites current and the shared Upload control beside it. Collections has no count. On phones counts hide, the strip scrolls with an edge fade, and Upload takes the next line. Local routing only.",
    render: () => <MediaTabsSpecimen />,
  },
  {
    id: "media-toolbar-parts",
    title: "Media library — search, sort, chips and result bar",
    note: "The search field in the toolbar's search slot with / and Escape, the Sort popover, a three-chip applied-filter row with Clear all, and the result bar with paging. Local state only.",
    isolateDocument: true,
    render: () => <MediaToolbarPartsSpecimen />,
  },
  {
    id: "media-paging-numbered",
    title: "Media library — numbered paging",
    note: "Shared numbered paging with one status and local page state. No request.",
    render: () => <MediaPagingSpecimen mode="numbered" />,
  },
  {
    id: "media-paging-cursor",
    title: "Media library — cursor paging",
    note: "Shared cursor paging with first, previous and next actions. Local page state only.",
    render: () => <MediaPagingSpecimen mode="cursor" />,
  },
  {
    id: "media-paging-load-more",
    title: "Media library — load more",
    note: "Shared load-more paging with a local count and no request.",
    render: () => <MediaPagingSpecimen mode="load-more" />,
  },
  {
    id: "media-video-toolbar",
    title: "Media library — video toolbar",
    note: "The shared toolbar with a video name-prefix search, locked sort and one structured filter chip. Local state only.",
    render: () => <MediaSurfaceToolbarSpecimen surface="video" />,
  },
  {
    id: "media-video-filter",
    title: "Media library — video filter",
    note: "The video filter offers Tag, Rights review and Uploader without image-only choices. Local state only.",
    isolateDocument: true,
    render: () => <MediaSurfaceToolbarSpecimen surface="video" popover="filter" />,
  },
  {
    id: "media-video-sort",
    title: "Media library: Video sort",
    note: "The video sort offers name, update time and both file-size directions. Local state only.",
    isolateDocument: true,
    render: () => <MediaSurfaceToolbarSpecimen surface="video" popover="sort" />,
  },
  {
    id: "media-video-display",
    title: "Media library — video display",
    note: "The video Display rows include 24, 48 and 96 per page and a locked search sort. Local state only.",
    isolateDocument: true,
    render: () => <MediaSurfaceToolbarSpecimen surface="video" popover="display" />,
  },
  {
    id: "media-favorites-toolbar",
    title: "Media library — Favorites toolbar",
    note: "Favorites offers Type and labels its client filter On this page. Local state only.",
    render: () => <MediaSurfaceToolbarSpecimen surface="favorites" />,
  },
  {
    id: "media-collections-filter",
    title: "Media library — Collections filters",
    note: "Collections offers Status and Scope through the shared Filter popover. Local state only.",
    isolateDocument: true,
    render: () => <MediaSurfaceToolbarSpecimen surface="collections" popover="filter" />,
  },
  {
    id: "media-voiceovers-toolbar",
    title: "Media library — Audio toolbar",
    note: "Audio uses shared search, Filter and applied chips while keeping its fixed table. Local state only.",
    isolateDocument: true,
    render: () => <MediaSurfaceToolbarSpecimen surface="voiceovers" />,
  },
  {
    id: "media-voiceovers-filter",
    title: "Media library — Audio filters",
    note: "Audio offers five filters and keeps its table without Display. Local state only.",
    isolateDocument: true,
    render: () => <MediaSurfaceToolbarSpecimen surface="voiceovers" popover="filter" />,
  },
  {
    id: "media-saved-views",
    title: "Media library — personal saved views",
    note: "Filter shows two validated personal views. Loaded, empty, save and validation controls switch deterministic local states. Display can save a name or show a duplicate error. No Firestore request runs.",
    isolateDocument: true,
    render: () => <MediaSavedViewsSpecimen />,
  },
  {
    id: "media-filter-popover",
    title: "Media library — filter popover",
    note: "The composed images toolbar: Filter with its count and Sort lead, then search, Display, More (Select this page and Keyboard shortcuts) and Upload, with the applied-filter chips under it. The Filter popover is open at Category with counts; All filters returns to the property list. Under 48rem Filter, Sort and the chips move to a second row, More shows only when Display folds, and the popover is a bottom sheet. Local state only.",
    isolateDocument: true,
    render: () => <MediaFilterPopoverSpecimen />,
  },
  {
    id: "media-display-popover",
    title: "Media library — display popover",
    note: "The composed images toolbar with the Display popover open: layout (Grid or List), thumbnail size, density, sort, the fields shown on cards and in list columns, and Reset to default. Each change saves in this browser at once and the popover stays open. Shift+V opens it. Local state only.",
    isolateDocument: true,
    render: () => <MediaDisplayPopoverSpecimen />,
  },
  {
    id: "media-tile",
    title: "Media library — media card",
    note: "The shared card for images and video, in the gallery only. The mark shows on hover, focus and selection and always on phones. Favorite, Add to collection and More sit on the chrome layer and hide in selection mode; a narrow card keeps only More. Badges use words and a glyph. Hover facts open after 600 ms. Local state only.",
    isolateDocument: true,
    render: () => <MediaTileSpecimen />,
  },
  {
    id: "media-list-row",
    title: "Media library — list row",
    note: "The shared images list row, in the gallery only: mark, thumbnail, name, the Display fields plus Updated, then Favorite and More. Under 70rem the wide columns move into the name's meta line; under 43rem the row is mark, thumbnail, name with meta, and More. Local state only.",
    isolateDocument: true,
    render: () => <MediaListRowSpecimen />,
  },
  {
    id: "media-grid-keyboard",
    title: "Media library — grid keyboard",
    note: "The shared grid in the gallery only, with the selection bar and the card context menu. One tab stop: the focused card's name, then its checkbox and quick actions. Arrows, Home, End and Page keys move; Space selects; Shift+Arrow extends; Enter opens; Cmd or Ctrl+A selects this page; Escape clears the selection, then details, then search. Focus returns to the last card, else to search. Uncaptured; for headed keyboard checks.",
    isolateDocument: true,
    render: () => <MediaGridKeyboardSpecimen />,
  },
  {
    id: "media-list-layout",
    title: "Media library — images list layout",
    note: "The images list as Display's List layout shows it: a header row with Select this page and sortable Name, Size and Updated headings (a second click reverses; only the sorted heading shows an arrow), then one row per item. Right-click, Shift+F10 or the Menu key opens a row's menu, which wraps the row's cells so the row stays the grid's row. Up and Down move; the grid keyboard is otherwise the same. The images page sends a sort as its one list request; the gallery sorts its page locally. Uncaptured; for headed checks.",
    isolateDocument: true,
    render: () => <MediaListLayoutSpecimen />,
  },
  {
    id: "media-selection-bar",
    title: "Media library — selection bar",
    note: "The shared selection bar in the gallery only: the images bar with its info tooltip, the video bar with the 100-video cap and the off-page count, Add to collection disabled past 30, and results under 21rem. Local state only.",
    isolateDocument: true,
    render: () => <MediaSelectionBarSpecimen />,
  },
  {
    id: "media-context-menu",
    title: "Media library — card context menu",
    note: "The card's context menu, opened as a right-click opens it: one card's menu in the card menu's order with Delete last, and a selected card's menu titled 5 items. It opens with no request. Local state only.",
    isolateDocument: true,
    render: () => <MediaContextMenuSpecimen />,
  },
  {
    id: "media-quick-look",
    title: "Media library — Quick Look",
    note: "The real nonmodal Quick Look over local loaded-page fixtures. It starts on an image, steps through a PDF and a video, closes without a form, and makes no request or prefetch. Local fixture only.",
    isolateDocument: true,
    render: () => <MediaQuickLookSpecimen />,
  },
  {
    id: "media-preview-header",
    title: "Media preview header",
    note: "Shared video and image header controls with responsive overflow. Local fixture only.",
    isolateDocument: true,
    render: () => <MediaPreviewHeaderSpecimen />,
  },
  {
    id: "image-viewer",
    title: "Media library — full-size image viewer",
    note: "The real full-size image viewer on the second item in a fixed three-item order, with Previous, Next, the page counter and the shared inspector docked beside the original. Under 62rem the inspector stacks below the image. The default is a local fixture with no remote request or prefetch. Optional download-test mode uses a stable dummy token and local API requests intercepted by browser tests.",
    isolateDocument: true,
    render: () => <ImageViewerSpecimen />,
  },
  {
    id: "media-full-viewer-image",
    title: "Media library — mixed full viewer image",
    note: "One controlled viewer shell on the image in a three-item mixed page. Local body and tools only.",
    isolateDocument: true,
    render: () => <MediaFullViewerSpecimen initialKind="image" />,
  },
  {
    id: "media-full-viewer-document",
    title: "Media library — mixed full viewer document",
    note: "The same shell on the PDF fallback in a three-item mixed page. Local body and tools only.",
    isolateDocument: true,
    render: () => <MediaFullViewerSpecimen initialKind="document" />,
  },
  {
    id: "media-full-viewer-video",
    title: "Media library — mixed full viewer video",
    note: "The same shell on the video in a three-item mixed page. Local poster and tools only.",
    isolateDocument: true,
    render: () => <MediaFullViewerSpecimen initialKind="video" />,
  },
  {
    id: "media-refinement-frame",
    title: "Media refinement — real video frame",
    note: "Actual media shell, source-video body, metadata and production owners with synthetic API fixtures supplied by browser checks. The 90-minute transcript is a layout fixture; the short local preview does not prove recording sync.",
    isolateDocument: true,
    render: () => <MediaRefinementSpecimen />,
  },
  {
    id: "media-inspector",
    title: "Media library — details inspector",
    note: "The details panel at the right of the results. Drag or use arrow keys on its left edge to resize it between 18 and 28rem; sections collapse, remember their state and show counts, and Save stays pinned at the bottom. Under 62rem it becomes a modal full-height sheet over a scrim: the page behind it is inert, Tab stays inside, and Escape or Close returns focus to the opener. Local state only.",
    isolateDocument: true,
    render: () => <MediaInspectorSpecimen />,
  },
  {
    id: "media-inspector-bulk",
    title: "Media library — bulk details",
    note: "Bulk mode built from the shared inspector parts: 5 items, a 2 × 2 preview stack, Mixed fields with Leave unchanged, Set the same value and Clear this field menus, and dashed mixed tags with a Replace or clear menu beside the Tags heading, never inside its disclosure button. Typing a mixed tag puts it on every item. Local state only.",
    isolateDocument: true,
    render: () => <MediaInspectorBulkSpecimen />,
  },
  {
    id: "media-token-suggestions",
    title: "Media library — tag suggestions",
    note: "The tag field's suggestion list, open. It sits on the floating layer, so the details panel's scrolling body cannot clip it, options wrap, and its last line says the suggestions come from this page and recent tags. It is not an option. No request.",
    isolateDocument: true,
    render: () => <MediaTokenSuggestionsSpecimen />,
  },
  {
    id: "media-inspector-docked",
    title: "Media library — docked details",
    note: "The inspector docked in a viewer dialog, as the video viewer will use it. It has no close control or resize handle and does not take focus when it opens; the viewer owns Escape and closing. Under 62rem it stacks under the player instead of becoming a sheet. Local state only.",
    isolateDocument: true,
    render: () => <MediaInspectorDockedSpecimen />,
  },
  {
    id: "video-viewer-inspector",
    title: "Media library — video viewer details",
    note: "The video viewer uses the shared media header for result navigation, Favorite, Save details and Download, with the real inspector docked beside it. Unsaved changes and pending saves guard Close and stepping. Rights, Tags, private review and staff comments use the real shared controls. File information and Delete from library start closed. Production tools stay under the player. Under 62rem the inspector stacks below the player. Browser-local API fixture only.",
    isolateDocument: true,
    render: () => <VideoViewerInspectorGallery />,
  },
  {
    id: "media-picker",
    title: "Post editor — image picker",
    note: "The compact station-image picker used by image and gallery blocks. An authorized Post editor can upload a local image here; selection still returns an asset id while alt text stays contextual to the Post.",
    render: () => <MediaPickerGallery />,
  },
  {
    id: "media-picker-upload",
    title: "Image picker — upload metadata",
    note: "Managed local categories enable the picker upload flow; fixture saves only.",
    render: () => <MediaPickerGallery upload />,
  },
  {
    id: "record-list",
    title: "Content studio — sponsor list",
    note: "A fast type-specific browse surface that complements All content: active records by immutable id, with status, last update, and an explicit create action.",
    render: () => (
      <MemoryRouter>
        <EditorWorkspace
          principal={superAdmin}
          surface={{ kind: "record-list", record: "sponsor" }}
          listRecords={listSponsors}
          onNavigateSurface={() => {}}
        />
      </MemoryRouter>
    ),
  },
  {
    id: "browsing-workflow-states",
    title: "Browsing and workflow — local read states",
    note: "Real directory, record-list, library and queue owners. family and state query parameters select deterministic ready, loading, empty, error or browse-only fixtures; no backend operation.",
    isolateDocument: true,
    render: () => <BrowsingWorkflowSpecimen records={LIBRARY_RECORDS} recordPage={{ records: GALLERY_SPONSORS.slice(0, 3), page: 1, pageCount: 1, total: 3 }} requests={REVIEW_REQUESTS} jobs={QUEUE_ITEMS} />,
  },
  {
    id: "browsing-family-shell",
    title: "Browsing and workflow — route families in the shell",
    note: "family selects the real directory, record list, library, media browser or queue owner in ShellLayout. Local list fixtures and synthetic staff identity only; no backend writes.",
    isolateDocument: true,
    render: () => <BrowsingFamilyShellSpecimen />,
  },
  {
    id: "media-browse-only",
    title: "Images — browse-only details",
    note: "The real Images surface with an authorized Viewer tier and local media. Metadata is read-only; the account cannot upload or manage assets.",
    isolateDocument: true,
    render: () => <MediaLibraryGallery initialEntry="/media/images?selected=media-local-news" principal={{ id: "gallery-viewer", grants: [{ role: "staff", tier: "viewer" }] }} />,
  },
  {
    id: "record-edit",
    title: "Content studio — stored sponsor",
    note: "A reload-safe edit surface seeded from storage at version 4, with a staged persisted assignment that stays separate from last-editor metadata. Assignment adopts the returned version before the next content save; unsaved form work disables it.",
    render: () => (
      <MemoryRouter>
        <EditorWorkspace
          principal={superAdmin}
          surface={{
            kind: "record",
            record: "sponsor",
            id: "sponsor-nj-foundation",
          }}
          assignRecord={assignSponsor}
          canAssignRecords
          loadAssignableUsers={loadAssignableStaff}
          loadRecord={loadSponsor}
          saveRecord={saveSponsor}
          onNavigateSurface={() => {}}
        />
      </MemoryRouter>
    ),
  },
  {
    id: "record-datetime-unreadable",
    title: "Content studio — event holding an unreadable end time",
    note: "A stored event whose end time is a bare calendar day. The control cannot show one, so the field quotes what the record is holding and offers to clear it; before this the control rendered blank and the value survived every save unmentioned (#850).",
    render: () => (
      <MemoryRouter>
        <EditorWorkspace
          principal={superAdmin}
          surface={{ kind: "record", record: "event", id: "event-screening" }}
          loadRecord={loadLegacyEvent}
          saveRecord={saveEvent}
          onNavigateSurface={() => {}}
        />
      </MemoryRouter>
    ),
  },
  {
    id: "rbac-contributor",
    title: "Content studio — contributor",
    note: "Can save drafts, cannot publish. The save label and the permission copy both change.",
    render: () => (
      <EditorWorkspace
        principal={contributor}
        loadPage={loadReady}
        savePage={saveOk}
        newId={galleryIds}
        surface={HOME_PAGE_SURFACE}
      />
    ),
  },
  {
    id: "rbac-readonly",
    title: "Content studio — no capability",
    note: "Read-only. Save is disabled by the handler, not just the button.",
    render: () => (
      <EditorWorkspace
        principal={readOnly}
        loadPage={loadReady}
        savePage={saveOk}
        newId={galleryIds}
        surface={HOME_PAGE_SURFACE}
      />
    ),
  },
  {
    id: "rbac-editor",
    title: "Content studio — editor",
    note: "Section-scoped editor grant. Can save and publish.",
    render: () => (
      <EditorWorkspace
        principal={editor}
        loadPage={loadReady}
        savePage={saveOk}
        newId={galleryIds}
        surface={HOME_PAGE_SURFACE}
      />
    ),
  },
  {
    id: "review-queue",
    title: "Editorial queue — review requests",
    note: "The list a reviewer works through. The content title carries the row: it takes the table's width and its primary type, because it is what a reviewer scans first. The waiting column reports a bounded age from the exact submitted time instead of repeating that every row is in review. Each row's own title opens the record or page, and carries the queue with it, so the editor's Back action returns here rather than to a content list nobody chose.",
    render: () => (
      <MemoryRouter initialEntries={["/publish-queue"]}>
        <ReviewQueueList requests={guideCapture ? REVIEW_REQUESTS.map((request) => ({ ...request, requestedByLabel: "Sample contributor", assigneeLabel: request.assigneeLabel ? "Sample editor" : null })) : REVIEW_REQUESTS} />
      </MemoryRouter>
    ),
  },
  {
    id: "review-queue-narrow",
    title: "Editorial queue — review requests at 320px",
    note: "The same requests as stacked cards at the narrow proof width. Every label and value pair reads from one left edge.",
    width: 320,
    render: () => (
      <MemoryRouter initialEntries={["/publish-queue"]}>
        <ReviewQueueList requests={guideCapture ? REVIEW_REQUESTS.map((request) => ({ ...request, requestedByLabel: "Sample contributor", assigneeLabel: request.assigneeLabel ? "Sample editor" : null })) : REVIEW_REQUESTS} />
      </MemoryRouter>
    ),
  },
  {
    id: "queue",
    title: "Publish queue — populated",
    note: "Every status the list knows: success, publishing, failed, pending.",
    render: () => <QueueList items={QUEUE_ITEMS} />,
  },
  {
    id: "queue-empty",
    title: "Publish queue — empty",
    note: "The state every new install starts in, and the one nobody designs.",
    render: () => <QueueList items={[]} />,
  },
  {
    id: "users",
    title: "Staff access — manageable",
    note: "Super admin view: roles, section grants, and a role-less account waiting on a grant. Confirm a change to inspect the in-row success state.",
    render: () => (
      <UsersTable
        users={USERS}
        canManage
        onDeactivate={() => {}}
        onGrant={() => {}}
        onRevoke={() => {}}
      />
    ),
  },
  {
    id: "users-levels",
    title: "Staff access — six whole-site levels",
    note: "Activated access levels with retained legacy access, an Owner, and an inactive account.",
    render: () => (
      <UsersTable tiersActive canManage currentUserId="level-owner"
        users={[
          { id: "level-owner", displayName: "Current owner", email: "owner@example.test", accessTier: "owner", role: null, grants: [], active: true },
          { id: "level-legacy", displayName: "Existing staff member with a long name", email: "existing.staff@example.test", role: null, grants: [{ role: "editor", sections: ["watch"] }], active: true },
          { id: "level-editor", displayName: "Content editor", email: "editor@example.test", accessTier: "editor", role: null, grants: [], active: true },
          { id: "level-inactive", displayName: "Inactive staff member", email: "inactive@example.test", role: null, grants: [], active: false, offboarding: { id: "complete", step: "complete" } },
          { id: "level-shutdown", displayName: "Unfinished shutdown", email: "shutdown@example.test", role: null, grants: [], active: false, offboarding: { id: "unfinished", step: "sign_in_and_sessions" } },
        ]}
        onSetLevel={async () => {}} onDeactivate={async () => {}} onReactivate={async () => {}} onGrant={() => {}} onRevoke={() => {}} />
    ),
  },
  {
    id: "users-mutation-states",
    title: "Staff access — progress and failure",
    note: "Granting stays in progress; revoking returns an error and keeps the confirmed change ready to retry.",
    render: () => (
      <UsersTable
        users={USERS}
        canManage
        onDeactivate={() =>
          Promise.reject(new Error("Session revocation unavailable"))
        }
        onGrant={() => new Promise<void>(() => {})}
        onRevoke={() => Promise.reject(new Error("Role service unavailable"))}
      />
    ),
  },
  {
    id: "users-readonly",
    title: "Staff access — read-only",
    note: "The same table for someone who cannot grant. Controls are absent, not disabled.",
    render: () => (
      <UsersTable
        users={USERS}
        canManage={false}
        onGrant={() => {}}
        onRevoke={() => {}}
      />
    ),
  },
  {
    id: "users-empty",
    title: "Staff access — empty",
    note: "No staff yet.",
    render: () => (
      <UsersTable users={[]} canManage onGrant={() => {}} onRevoke={() => {}} />
    ),
  },
  {
    id: "admin-settings",
    title: "Admin settings — newsroom banner",
    note: "The only settings form staff can edit, rendered from its own transport rather than a live back end. Judge the same hierarchy the other surfaces are judged on: the heading of the panel, the field, the byte budget, the live preview of what the newsroom home will say, and one consequential action that stays a text label.",
    render: () => <AdminSettingsForm {...bannerTransport({})} />,
  },
  {
    id: "admin-settings-public-banner",
    title: "Admin settings — public homepage banner",
    note: "The public banner has separate draft and publication controls. Edit it to inspect the immediate preview, save the draft without changing the public site, or publish the exact saved version to update the public site.",
    render: () => (
      <PublicHomepageBannerSettings {...publicBannerTransport()} />
    ),
  },
  {
    id: "admin-settings-public-banner-shell",
    title: "Admin settings — NJ Decides banner in the admin shell",
    note: "The production public banner panel in the real Admin settings shell. The synthetic schema-v2 transport keeps save and publish local to this fixture.",
    render: () => (
      <ShellSpecimen
        adminSettingsPanel={
          <PublicHomepageBannerSettings {...publicBannerTransport({ election: true })} />
        }
        initialEntry="/admin/settings"
      />
    ),
  },
  {
    id: "admin-settings-public-site-chrome",
    title: "Admin settings — header newsletter action",
    note: "The header newsletter action has its own draft and publication controls. Change the label or link to inspect the preview and the field errors, then save the draft or publish the exact saved version.",
    render: () => (
      <PublicSiteChromeSettings {...publicSiteChromeTransport()} />
    ),
  },
  {
    id: "settings-publication-recovery",
    title: "Settings — site update recovery",
    note: "Shared publication status for all three public settings forms. Synthetic overdue, changed-publication and completion receipts; no CMS requests.",
    render: () => <Panel>
      <h2>Public settings site update</h2>
      <SettingsPublicationStatus publication={{ ...gallerySettingsReceipt(4),
        warning: "The site update is taking longer than expected. Retry publication." }}
        retry={async () => {}} retrying={false} disabled={false} refresh={async () => {}} needsRefresh={false} />
      <SettingsPublicationStatus publication={{ ...gallerySettingsReceipt(4),
        warning: "This publication changed. Refresh the site update to check its status. Your draft will stay as it is." }}
        retry={async () => {}} retrying={false} disabled={false} refresh={async () => {}} needsRefresh />
      <SettingsPublicationStatus publication={{ ...gallerySettingsReceipt(4), status: "success", missingConsumers: [] }}
        retry={async () => {}} retrying={false} disabled={false} refresh={async () => {}} needsRefresh={false} />
    </Panel>,
  },
  {
    id: "admin-settings-over-limit",
    title: "Admin settings — heading past its budget",
    note: "A stored heading longer than the 160-byte limit. The counter, the error and the disabled save have to agree with each other without the person having to work out which one is telling the truth.",
    render: () => (
      <AdminSettingsForm
        {...bannerTransport({
          heading:
            "Montclair State University's College of Communication and Media is rebuilding the NJ PBS website, its newsroom tools, and the way the station publishes to the public every day",
        })}
      />
    ),
  },
  {
    id: "admin-settings-conflict",
    title: "Admin settings — someone else saved first",
    note: "Change the heading and save. The setting moved under this person, so the reply offers the only safe next step: reload what is stored.",
    render: () => (
      <AdminSettingsForm {...bannerTransport({ conflict: true })} />
    ),
  },
  {
    id: "admin-settings-error",
    title: "Admin settings — setting unreadable",
    note: "The read failed, so there is no form to show. What is left has to say so plainly and offer the retry.",
    render: () => (
      <AdminSettingsForm {...bannerTransport({ loadFails: true })} />
    ),
  },
  {
    id: "cost-ledger-wide",
    title: "Costs at 1280 px",
    note: "A local ledger fixture with totals, blank and zero states, snapshot history, comparisons, source dates, export, and super-admin controls. Wide tables retain their own horizontal scroll area.",
    width: 1280,
    render: () => <CostLedgerGallery />,
  },
  {
    id: "cost-ledger-narrow",
    title: "Costs at 390 px",
    note: "The same local ledger at a phone viewport. Cards and actions stack while each wide table scrolls within its own frame instead of widening the page.",
    width: 390,
    render: () => <CostLedgerGallery />,
  },
  {
    id: "cost-ledger-loading-narrow",
    title: "Costs loading at 390 px",
    note: "The same phone viewport before the ledger view arrives. Its skeleton preserves table frames so loading cannot widen the page.",
    width: 390,
    render: () => <CostLedgerGallery loading />,
  },
  {
    id: "shell-arranged-rail",
    title: "Admin shell — an arranged rail",
    note: "The same signed-in shell for an account that moved Media library to the top and took Activity and Staff profiles out of its own rail. Both destinations stay authorized and open at their addresses; only the rail is shorter. Collapse the rail from its header to see the arrangement hold in the icon-only width.",
    render: () => (
      <ShellSpecimen
        navigation={{
          version: NAVIGATION_PREFERENCES_VERSION,
          order: [
            "media",
            "home",
            "pages",
            "posts",
            "library",
            "admin-settings",
            "activity",
            "editorial-queue",
            "staff-access",
            "staff-profiles",
          ],
          hidden: ["activity", "staff-profiles"],
        }}
      />
    ),
  },
  {
    id: "navigation-preferences-account",
    title: "Your rail — account settings",
    note: "The real account settings route inside the Boardwalk shell, including Control presentation and the full-width navigation panel. Synthetic profile only; do not save the display preference from this fixture.",
    render: () => <ShellSpecimen initialEntry="/account/settings" />,
  },
  {
    id: "navigation-preferences-account-custom",
    title: "Your custom navigation — account settings",
    note: "The real account settings route and Boardwalk rail with synthetic planks, a span with two planks, and shared planks. Do not save account preferences from this fixture.",
    render: () => <ShellSpecimen initialEntry="/account/settings" navigation={SHARED_ACCOUNT_NAVIGATION} navigationShares={SHARED_ACCOUNT_SHARES} />,
  },
  {
    id: "navigation-preferences-owner-removal",
    title: "Shared owner removal — account settings",
    note: "Synthetic live share removal in the real rail and account settings. The fixture control replaces active shares with owner-removal tombstones; it never changes an account.",
    render: () => <SharedOwnerRemovalGallery />,
  },
  {
    id: "shell-custom-rail",
    title: "Admin shell with custom navigation",
    note: "Fixture planks and a span with two planks. Open My desk, collapse the rail, open the phone menu, or use the workspace finder. All content reads remain on demand.",
    render: () => <ShellSpecimen navigation={CUSTOM_NAVIGATION_FIXTURE} />,
  },
  {
    id: "navigation-preferences-custom",
    title: "Your custom navigation",
    note: "Use fixture labels and example.test addresses. Edit, hide, move, delete, add to your rail, or inspect reset confirmation. Save is local to the specimen.",
    render: () => <ControlPresentationProvider value="text"><NavigationPreferences eligible={eligibleNavDestinations(superAdmin)}
      stored={CUSTOM_NAVIGATION_FIXTURE} onReset={async () => {}} onSave={async () => {}}
      searchContent={async (kind, query) => ({ items: [{ id: kind === "post" ? "sample-post" : "home", label: kind === "post" ? "Sample post" : "Home page" }].filter(item => item.label.toLowerCase().includes(query.toLowerCase())), pageCount: 1 })} /></ControlPresentationProvider>,
  },
  {
    id: "navigation-preferences",
    title: "Your rail — arrange the rail",
    note: "The per-account arrangement surface from account settings, for a super admin who can see every destination. Move a destination with the up and down controls, hide one that is rarely opened, and reset. Home, Broadcast schedule, and Admin settings carry no hide control because they are always shown; a hidden destination stays open at its address.",
    render: () => (
      <NavigationPreferences
        eligible={eligibleNavDestinations(superAdmin)}
        onReset={async () => {}}
        onSave={async () => {}}
        stored={null}
      />
    ),
  },
  {
    id: "navigation-preferences-error",
    title: "Your rail — save error",
    note: "A refused save keeps the arrangement and offers recovery in the visible footer.",
    render: () => <NavigationPreferences
      eligible={eligibleNavDestinations(superAdmin)} stored={null}
      onReset={async () => {}}
      onSave={async () => { throw new Error("Your rail could not be saved. Try again."); }}
    />,
  },
  {
    id: "navigation-preferences-pending",
    title: "Your rail — save pending",
    note: "A held local save demonstrates busy controls without a backend request.",
    render: () => <NavigationPreferences
      eligible={eligibleNavDestinations(superAdmin)} stored={null}
      onReset={async () => {}}
      onSave={() => new Promise<void>(() => {})}
    />,
  },
  {
    id: "navigation-preferences-text",
    title: "Your rail — text labels",
    note: "The same surface for an account that reads text labels instead of icons. Every control keeps the same action name in both presentations; only the visible label changes.",
    render: () => (
      <ControlPresentationProvider value="text">
        <NavigationPreferences
          eligible={eligibleNavDestinations(superAdmin)}
          onReset={async () => {}}
          onSave={async () => {}}
          stored={null}
        />
      </ControlPresentationProvider>
    ),
  },
  {
    id: "navigation-preferences-arranged",
    title: "Your rail — arranged and narrow",
    note: "The same surface at 320px for an account that has already moved Media library up and hidden Activity and Staff profiles. Each destination keeps its name and controls on one row, and a hidden destination stays listed with a Show action. The list scrolls above the save footer.",
    width: 320,
    render: () => (
      <NavigationPreferences
        eligible={eligibleNavDestinations(superAdmin)}
        onReset={async () => {}}
        onSave={async () => {}}
        stored={{
          version: NAVIGATION_PREFERENCES_VERSION,
          order: [
            "home",
            "media",
            "pages",
            "posts",
            "library",
            "admin-settings",
            "activity",
            "editorial-queue",
            "staff-access",
            "staff-profiles",
          ],
          hidden: ["activity", "staff-profiles"],
        }}
      />
    ),
  },
  {
    id: "page-narrow",
    title: "Content studio — narrow",
    note: "At 320px the canvas keeps the long-page outline and editing controls usable without document-level horizontal scrolling. The shell owns the single disclosure menu at this width.",
    width: 320,
    render: () => (
      <EditorWorkspace
        principal={superAdmin}
        loadPage={loadReady}
        savePage={saveOk}
        savePageMetadata={saveMetadataOk}
        newId={galleryIds}
        surface={HOME_PAGE_SURFACE}
      />
    ),
  },
];

// The specimen index, published on the window as soon as this module evaluates -- before
// anything renders. The visual regression suite reads it to enumerate the registry rather
// than restating the specimen list in a second place, and can close the page again without
// waiting for the all-states view to mount. Metadata only; no render functions cross over.
export const GALLERY_SPECIMEN_INDEX: GallerySpecimen[] = SHOTS.map(
  ({ id, title, width }) => (width ? { id, title, width } : { id, title }),
);

declare global {
  interface Window {
    __ADMIN_GALLERY_SPECIMENS__?: GallerySpecimen[];
    __ADMIN_NORMALIZE_GENERATED_IDS__?: typeof normalizeGeneratedIds;
  }
}

if (typeof window !== "undefined") {
  window.__ADMIN_GALLERY_SPECIMENS__ = GALLERY_SPECIMEN_INDEX;
  // The capture harness calls this on the rendered specimen just before the screenshot.
  // Published from here so the suite runs the same module the unit suite covers, rather
  // than a copy inlined into the test.
  window.__ADMIN_NORMALIZE_GENERATED_IDS__ = normalizeGeneratedIds;
}

// The filter lives in the URL hash so every state is a link: #page-conflict renders that
// state alone. That makes a screenshot pass a flat list of URLs to visit rather than a
// script that has to find and click the right chip, and it means a finding can cite the
// exact state it is about.
function readHash(): string | null {
  const id = window.location.hash.replace(/^#/, "");
  return SHOTS.some((shot) => shot.id === id) ? id : null;
}

// A default specimen renders into its own shadow root, so its DOM ids and the
// aria-labelledby / aria-controls targets they resolve are scoped to that one specimen. A
// sized specimen instead renders this page again in iframe embed mode. That gives it both a
// separate id namespace and a real viewport, so the unchanged production media queries run
// at the proof width. A state-isolated specimen uses the same child-document path without a
// fixed-width claim; this keeps fixture-only navigation state out of the gallery document.
// On the all-states view several EditorWorkspace specimens share the page, each carrying the
// same fixed ids (page-title, and block-<id> from the shared seed); in one document those
// collide, and a label reference in a later specimen can resolve into the first. These
// isolated trees make an accessibility audit see the admin's real wiring rather than a
// gallery artifact (#596).
//
// The children are portaled into the shadow root rather than rendered as light-DOM siblings,
// so they stay part of this one React tree: state, context, and the specimen's own effects
// behave exactly as they do in the real admin.
function ShadowScope({ children }: { children: React.ReactNode }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [mount, setMount] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // A host can only hold one shadow root; reuse it if a prior mount (React StrictMode's
    // double-invoke in dev) already attached one.
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    // The admin class rules, plus the document-body base the specimen would otherwise inherit
    // from `body` -- which does not exist inside a shadow tree. The token values come from the
    // document root by inheritance.
    style.textContent = `${stylesText}\n${mediaRouteStylesText}\n${contentScanFlowStylesText}\n${workspaceStylesText}\n${dropOverlayStylesText}\n${uploadSheetStylesText}\n${uploadTrayStylesText}\n.gx-specimen{--studio-control-height:var(--target-comfortable);--studio-icon-control:var(--target-comfortable);color:var(--color-ink);font-family:var(--font-sans);font-size:var(--font-size-base);line-height:var(--line-height-copy);}`;
    shadow.appendChild(style);
    const container = document.createElement("div");
    container.className = "gx-specimen";
    shadow.appendChild(container);
    setMount(container);
    return () => {
      style.remove();
      container.remove();
      setMount(null);
    };
  }, []);

  return (
    <div className="gx-host" ref={hostRef}>
      {mount ? createPortal(children, mount) : null}
    </div>
  );
}

function embeddedShotUrl(id: string): string {
  const search = new URLSearchParams({ embed: id });
  return `${window.location.pathname}?${search.toString()}`;
}

function EmbeddedSpecimen({ shot }: { shot: Shot }) {
  const width = shot.width;
  const title = width
    ? `${shot.title} — ${width}px responsive viewport`
    : `${shot.title} — isolated document`;
  return (
    <iframe
      className="gx-embedded-specimen"
      data-gallery-isolated="true"
      data-gallery-viewport-width={width}
      height="720"
      loading="eager"
      src={embeddedShotUrl(shot.id)}
      style={{ width: width ? `${width}px` : "100%" }}
      title={title}
      width={width}
    />
  );
}

function readEmbeddedShot(): Shot | null {
  const id = new URLSearchParams(window.location.search).get("embed");
  return SHOTS.find((shot) => shot.id === id) ?? null;
}

// An embedded specimen can be pinned to one control presentation with `&presentation=text`
// or `&presentation=icons`. Without the parameter the specimen renders exactly as before,
// on the admin's own default, so the gallery's iframe specimens are unaffected. The visual
// regression suite uses it to capture both modes of the same surface. A specimen that
// provides its own presentation (page-ready-icons, navigation-preferences-text) still wins:
// its provider is nested inside this one.
function readEmbeddedPresentation(): ControlPresentation | null {
  const value = new URLSearchParams(window.location.search).get("presentation");
  return (
    CONTROL_PRESENTATIONS.find((presentation) => presentation === value) ?? null
  );
}

export function Gallery({ specimens = SHOTS }: { specimens?: readonly Shot[] } = {}) {
  const [only, setOnly] = useState<string | null>(readHash);

  useEffect(() => {
    const sync = () => setOnly(readHash());
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  const show = (id: string | null) => {
    window.location.hash = id ?? "";
  };

  const shots = only ? specimens.filter((shot) => shot.id === only) : specimens;

  return (
    <div className="gx">
      <header className="gx-head">
        <h1>Admin design gallery</h1>
        <p>
          Every surface and state, from the real components with mock props. Dev
          only — this page is not part of the production build. Pick a state to
          see it alone; the URL follows, so any state can be linked or
          screenshotted directly.
        </p>
        <nav className="gx-index" aria-label="States">
          <button
            type="button"
            onClick={() => show(null)}
            aria-pressed={only === null}
          >
            All {SHOTS.length}
          </button>
          {SHOTS.map((shot) => (
            <button
              key={shot.id}
              type="button"
              onClick={() => show(shot.id)}
              aria-pressed={only === shot.id}
            >
              {shot.title}
            </button>
          ))}
        </nav>
      </header>

      {/*
        Shown only on the all-states view, where the isolation earns an explanation. Default
        specimens use shadow roots. Sized and state-isolated specimens use self-rendering
        iframe documents; sized specimens also run production viewport media queries at the
        stated width. In each case, fixed ids several specimens share (page-title,
        block-<id>) cannot resolve into a neighbour. An accessibility audit here reads the
        admin's real wiring, not a gallery artifact (#596).
      */}
      {only === null ? (
        <p className="gx-note">
          Each specimen renders in its own isolated tree, so the ids and{" "}
          <code>aria-labelledby</code> targets that repeat across specimens stay
          scoped to one each. Sized specimens also use a real iframe viewport so
          production responsive rules run at the stated width. Audit each iframe
          specimen inside its titled child document or open its embed URL
          directly.
        </p>
      ) : null}

      {shots.map((shot) => (
        <section className="gx-frame" id={shot.id} key={shot.id}>
          <div className="gx-frame__head">
            <h2>{shot.title}</h2>
            <p>{shot.note}</p>
          </div>
          <div
            className="gx-frame__body"
            style={shot.width ? { maxWidth: `${shot.width}px` } : undefined}
          >
            {shot.width || shot.isolateDocument ? (
              <EmbeddedSpecimen shot={shot} />
            ) : (
              <ShadowScope>{shot.render()}</ShadowScope>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}

export function GalleryRoot() {
  const embeddedShot = readEmbeddedShot();
  if (!embeddedShot) return <Gallery />;
  const presentation = readEmbeddedPresentation();
  return presentation ? (
    <ControlPresentationProvider value={presentation}>
      {embeddedShot.render()}
    </ControlPresentationProvider>
  ) : (
    embeddedShot.render()
  );
}

// Only mount when the page provides the root node. gallery.html always does; a test that
// imports Gallery for its exports does not, and must not trigger a stray render on import.
const root = document.getElementById("gallery-root");
if (root) {
  installPointerFocusTracking();
  const mount = () => createRoot(root).render(
    <StrictMode>
      <GalleryRoot />
    </StrictMode>,
  );
  // #3707: native selects retain fallback glyphs when PBS Sans arrives after mount,
  // even after fonts.ready. Load their exact face before creating this specimen.
  if (readEmbeddedShot()?.id === "post-metadata") {
    void document.fonts.load('400 14px "PBS Sans"').then(mount, mount);
  } else {
    mount();
  }
}
