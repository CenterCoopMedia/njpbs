import { CoverageLabelsSettings, COVERAGE_LABELS_SETTINGS_ID, type CoverageLabelsSettingsTransport } from "../components/CoverageLabelsSettings";
import type { CoverageLabelsSettingsValues } from "../../../packages/content-core/src/cms-settings";
import { StoryCtaSettings, STORY_CTAS_SETTINGS_ID, type StoryCtaSettingsTransport } from "../components/StoryCtaSettings";
import type { StoryCtasSettingsValues } from "../../../packages/content-core/src/story-cta-rules";
import { SettingsWorkspace, useSettingsDirty } from "../components/SettingsWorkspace";
import { ConnectedLiveProductionDevices } from "../components/LiveProductionDevices";
import type { LoadedRecord } from "../components/EditorWorkspace";
import type { RecordKind } from "../../../packages/content-core/src/editor-admin";
import { encodeContentQuery, type ContentQuery } from "../lib/content-query";
import { InfoTooltip } from "../components/ui/InfoTooltip";
// Costs shares the existing lazy settings asset.
export { CostLedgerRoute } from "./CostLedgerRoute";
import { type ReactNode, type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router";
import {
  DEFAULT_NEWSROOM_BANNER_HEADING,
  DEFAULT_NEWSROOM_MILESTONE_NUMBER,
  projectPublishedCmsSettings,
  NEWSROOM_HOME_SETTINGS_ID,
  NEWSROOM_MILESTONE_SETTINGS_ID,
} from "../../../packages/content-core/src/cms-settings";
import {
  AsyncActionButton,
  Button,
  InlineMessage,
  Panel,
  Select,
  TextInput,
} from "../components/ui/Primitives";
import { SkeletonBlock, SkeletonRegion, SkeletonText } from "../components/ui/Skeleton";
import { useAuth } from "../context/AuthContext";
import { MediaCategorySettings } from "../components/MediaCategorySettings";
import {
  PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
  PublicHomepageBannerSettings,
  type PublicHomepageBannerSettingsTransport,
  type PublicHomepageBannerValues,
} from "../components/PublicHomepageBannerSettings";
import {
  SITE_NAVIGATION_SETTINGS_ID,
  SiteNavigationSettings,
  type SiteNavigationSettingsTransport,
  type SiteNavigationValues,
} from "../components/SiteNavigationSettings";
import {
  PUBLIC_SITE_CHROME_SETTINGS_ID,
  PublicSiteChromeSettings,
  type PublicSiteChromeSettingsTransport,
  type PublicSiteChromeValues,
} from "../components/PublicSiteChromeSettings";
import {
  NJ_DECIDES_SETTINGS_ID,
  NjDecidesSettings,
  type NjDecidesSettingsTransport,
  type NjDecidesValues,
} from "../components/NjDecidesSettings";
import {
  canManageSettings,
  canUploadMedia,
  canUseMediaLibrary,
} from "../lib/access";
import {
  resetMediaCategoryRegistry,
  useMediaCategories,
} from "../lib/use-media-categories";
import {
  defaultMediaUploadCategory,
  uploadMediaReusingDuplicates,
} from "../lib/media-upload";
import {
  fetchAdminStatus,
  type AdminMilestoneStatus,
  type AdminStatusManifest,
} from "../lib/admin-status";
import {
  cmsGetSettings,
  cmsPublishedVocabulary,
  cmsGetContent,
  cmsListContent,
  cmsListMedia,
  cmsListMediaCategories,
  cmsListPages,
  cmsMutateMediaCategory,
  cmsPublishSettings,
  cmsSaveSettings,
  isConflictError,
  type GetSettingsResponse,
  type MutateSettingsResponse,
  type SaveSettingsRequest,
} from "../lib/functions";
import { RequireCapability } from "./RequireCapability";
import { useSuccessNotice } from "../components/ui/SuccessNoticeRegion";

const MAX_BANNER_HEADING_BYTES = 160;

export type BannerSettingsValues = { bannerHeading?: unknown };
export type MilestoneSettingsValues = { milestoneNumber?: unknown };

/**
 * How the banner form reaches its setting. The route binds these to the signed-in token and the
 * CMS functions; the design gallery and the tests bind them to fixtures. Without the seam the only
 * way to render this form was against a live back end, so the one Admin settings surface could
 * never get a browser verdict on its own hierarchy (#1036).
 */
export interface BannerSettingsTransport {
  load: () => Promise<GetSettingsResponse<BannerSettingsValues>>;
  save: (
    request: SaveSettingsRequest<BannerSettingsValues>,
  ) => Promise<MutateSettingsResponse<BannerSettingsValues>>;
}

export interface MilestoneSettingsTransport {
  loadSettings: () => Promise<GetSettingsResponse<MilestoneSettingsValues>>;
  loadStatus: () => Promise<AdminStatusManifest>;
  save: (
    request: SaveSettingsRequest<MilestoneSettingsValues>,
  ) => Promise<MutateSettingsResponse<MilestoneSettingsValues>>;
}

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; heading: string; version: number | null };

type SaveState = "idle" | "saved" | "conflict" | "error";

type MilestoneLoadState =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "ready";
      milestones: AdminMilestoneStatus[];
      milestoneNumber: number;
      staleMilestoneNumber: number | null;
      version: number | null;
    };

function headingFromResponse(response: GetSettingsResponse<BannerSettingsValues>): {
  heading: string;
  version: number | null;
} {
  if (!response.found) {
    return { heading: DEFAULT_NEWSROOM_BANNER_HEADING, version: null };
  }
  const heading = response.settings.values.bannerHeading;
  if (typeof heading !== "string" || heading.trim() === "") {
    throw new Error("The newsroom banner setting is invalid.");
  }
  return { heading, version: response.settings.version };
}

function headingBytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function AdminSettingsForm({ load, save: saveSetting }: BannerSettingsTransport) {
  const successNotice = useSuccessNotice();
  const [attempt, setAttempt] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [draft, setDraft] = useState(DEFAULT_NEWSROOM_BANNER_HEADING);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  useEffect(() => {
    let cancelled = false;
    setLoadState({ status: "loading" });
    setSaveState("idle");
    load()
      .then((response) => headingFromResponse(response))
      .then((settings) => {
        if (cancelled) return;
        setDraft(settings.heading);
        setLoadState({ status: "ready", ...settings });
      })
      .catch(() => {
        if (!cancelled) setLoadState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, load]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loadState.status !== "ready" || saving || saveState === "conflict") return;
    const heading = draft.trim();
    if (!heading || headingBytes(heading) > MAX_BANNER_HEADING_BYTES) return;
    setSaving(true);
    setSaveState("idle");
    try {
      const response = await saveSetting(
        loadState.version === null
          ? {
              id: NEWSROOM_HOME_SETTINGS_ID,
              values: { bannerHeading: heading },
              createOnly: true,
            }
          : {
              id: NEWSROOM_HOME_SETTINGS_ID,
              values: { bannerHeading: heading },
              baseVersion: loadState.version,
            },
      );
      const savedHeading = response.settings.values.bannerHeading;
      if (typeof savedHeading !== "string" || savedHeading.trim() === "") {
        throw new Error("The saved newsroom banner setting is invalid.");
      }
      setDraft(savedHeading);
      setLoadState({
        status: "ready",
        heading: savedHeading,
        version: response.settings.version,
      });
      setSaveState("saved");
      successNotice.show("Newsroom banner saved.");
    } catch (error) {
      setSaveState(isConflictError(error) ? "conflict" : "error");
    } finally {
      setSaving(false);
    }
  }

  useSettingsDirty(loadState.status === "ready" && draft.trim() !== loadState.heading, saving);

  if (loadState.status === "loading") {
    return (
      <SettingsPanelSkeleton
        label="Loading Admin settings"
        heading="Newsroom home banner"
        field="Main heading"
        withPreview
      />
    );
  }

  if (loadState.status === "error") {
    return (
      <InlineMessage tone="error" title="Admin settings could not be loaded">
        <p>Try the request again.</p>
        <Button onClick={() => setAttempt((value) => value + 1)}>Retry</Button>
      </InlineMessage>
    );
  }

  const trimmedDraft = draft.trim();
  const bytes = headingBytes(trimmedDraft);
  const invalid = trimmedDraft.length === 0 || bytes > MAX_BANNER_HEADING_BYTES;
  const unchanged = trimmedDraft === loadState.heading;

  return (
    <Panel className="admin-settings-panel" aria-labelledby="newsroom-banner-heading">
      <div className="panel-heading">
        <div>
          <h2 id="newsroom-banner-heading">Newsroom home banner</h2>
          <p>
            Set the heading in the expandable Build and publication details section on Home.
            Build and milestone facts remain automatic.
          </p>
        </div>
      </div>

      <form className="admin-settings-form" onSubmit={save}>
        <label className="editor-field-label" htmlFor="newsroom-banner-heading-input">
          Main heading
        </label>
        <TextInput
          aria-describedby="newsroom-banner-heading-help"
          disabled={saving}
          id="newsroom-banner-heading-input"
          onChange={(event) => {
            setDraft(event.target.value);
            setSaveState((state) => state === "conflict" ? state : "idle");
          }}
          required
          value={draft}
        />
        <p className="muted" id="newsroom-banner-heading-help">
          {bytes} of {MAX_BANNER_HEADING_BYTES} bytes used.
        </p>

        <div className="admin-settings-banner-preview" aria-label="Banner heading preview">
          <span>Build and milestone</span>
          <strong>{trimmedDraft || "A plain-language heading appears here"}</strong>
        </div>

        {invalid ? (
          <InlineMessage tone="error">
            Enter a heading of no more than {MAX_BANNER_HEADING_BYTES} bytes.
          </InlineMessage>
        ) : null}
        {saveState === "saved" && !successNotice.available ? (
          <InlineMessage tone="success">Newsroom banner saved.</InlineMessage>
        ) : null}
        {saveState === "conflict" ? (
          <InlineMessage tone="error">
            <p>This setting changed after you opened it.</p>
            <Button
              type="button"
              variant="primary"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Reload saved heading
            </Button>
          </InlineMessage>
        ) : null}
        {saveState === "error" ? (
          <InlineMessage tone="error">
            The newsroom banner could not be saved. Try again.
          </InlineMessage>
        ) : null}

        <div className="admin-settings-actions">
          <AsyncActionButton
            disabled={invalid || unchanged || saveState === "conflict"}
            label="Save newsroom banner"
            pending={saving}
            pendingAnnouncement="Saving newsroom banner."
            pendingLabel="Saving…"
            type="submit"
            variant="primary"
          />
        </div>
      </form>
    </Panel>
  );
}

function milestoneSettingsFromResponses(
  response: GetSettingsResponse<MilestoneSettingsValues>,
  status: AdminStatusManifest,
): Extract<MilestoneLoadState, { status: "ready" }> {
  if (status.status !== "current") {
    throw new Error("The milestone catalog is unavailable.");
  }
  const savedNumber = response.found
    ? response.settings.values.milestoneNumber
    : DEFAULT_NEWSROOM_MILESTONE_NUMBER;
  if (!Number.isSafeInteger(savedNumber)) {
    throw new Error("The saved milestone is invalid.");
  }
  const savedMilestoneIsCurrent = status.milestones.some(
    ({ number }) => number === savedNumber,
  );
  return {
    status: "ready",
    milestones: status.milestones,
    milestoneNumber: savedMilestoneIsCurrent
      ? (savedNumber as number)
      : status.milestone.number,
    staleMilestoneNumber:
      response.found && !savedMilestoneIsCurrent ? (savedNumber as number) : null,
    version: response.found ? response.settings.version : null,
  };
}

export function MilestoneSettingsForm({
  loadSettings,
  loadStatus,
  save: saveSetting,
}: MilestoneSettingsTransport) {
  const successNotice = useSuccessNotice();
  const [attempt, setAttempt] = useState(0);
  const [loadState, setLoadState] = useState<MilestoneLoadState>({
    status: "loading",
  });
  const [draft, setDraft] = useState(DEFAULT_NEWSROOM_MILESTONE_NUMBER);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  useEffect(() => {
    let cancelled = false;
    setLoadState({ status: "loading" });
    setSaveState("idle");
    Promise.all([loadSettings(), loadStatus()])
      .then(([settings, status]) => milestoneSettingsFromResponses(settings, status))
      .then((loaded) => {
        if (cancelled) return;
        setDraft(loaded.milestoneNumber);
        setLoadState(loaded);
      })
      .catch(() => {
        if (!cancelled) setLoadState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, loadSettings, loadStatus]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loadState.status !== "ready" || saving || saveState === "conflict") return;
    setSaving(true);
    setSaveState("idle");
    try {
      const response = await saveSetting(
        loadState.version === null
          ? {
              id: NEWSROOM_MILESTONE_SETTINGS_ID,
              values: { milestoneNumber: draft },
              createOnly: true,
            }
          : {
              id: NEWSROOM_MILESTONE_SETTINGS_ID,
              values: { milestoneNumber: draft },
              baseVersion: loadState.version,
            },
      );
      const savedNumber = response.settings.values.milestoneNumber;
      if (
        !Number.isSafeInteger(savedNumber) ||
        !loadState.milestones.some(({ number }) => number === savedNumber)
      ) {
        throw new Error("The saved milestone is invalid.");
      }
      setDraft(savedNumber as number);
      setLoadState({
        ...loadState,
        milestoneNumber: savedNumber as number,
        staleMilestoneNumber: null,
        version: response.settings.version,
      });
      setSaveState("saved");
      successNotice.show("Current milestone saved.");
    } catch (error) {
      setSaveState(isConflictError(error) ? "conflict" : "error");
    } finally {
      setSaving(false);
    }
  }

  useSettingsDirty(loadState.status === "ready" && draft !== loadState.milestoneNumber, saving);

  if (loadState.status === "loading") {
    return (
      <SettingsPanelSkeleton label="Loading current milestone" heading="Current milestone" field="Milestone" />
    );
  }
  if (loadState.status === "error") {
    return (
      <InlineMessage tone="error" title="Current milestone could not be loaded">
        <p>Try the request again.</p>
        <Button onClick={() => setAttempt((value) => value + 1)}>Retry</Button>
      </InlineMessage>
    );
  }

  return (
    <Panel className="admin-settings-panel" aria-labelledby="current-milestone-heading">
      <div className="panel-heading">
        <div>
          <div className="editor-field-label-row"><h2 id="current-milestone-heading">Current milestone</h2>
          <InfoTooltip label="current milestone" content="A milestone groups repository tasks. This selects the progress shown in the expandable Build and publication details section on Home; it does not publish content or change staff access." /></div>
          <p>Choose the GitHub milestone shown under Build and publication details on Home.</p>
        </div>
      </div>
      <form className="admin-settings-form" onSubmit={save}>
        <label className="editor-field-label" htmlFor="current-milestone-select">
          Milestone
        </label>
        <Select
          disabled={saving}
          id="current-milestone-select"
          onChange={(event) => {
            setDraft(Number(event.target.value));
            setSaveState((state) => state === "conflict" ? state : "idle");
          }}
          value={draft}
        >
          {loadState.milestones.map((milestone) => (
            <option key={milestone.number} value={milestone.number}>
              {milestone.title} ({milestone.state})
            </option>
          ))}
        </Select>

        {loadState.staleMilestoneNumber !== null ? (
          <InlineMessage tone="warning">
            Saved milestone {loadState.staleMilestoneNumber} is no longer in the
            GitHub catalog. Choose a current milestone and save it.
          </InlineMessage>
        ) : null}

        {saveState === "saved" && !successNotice.available ? (
          <InlineMessage tone="success">Current milestone saved.</InlineMessage>
        ) : null}
        {saveState === "conflict" ? (
          <InlineMessage tone="error">
            <p>This setting changed after you opened it.</p>
            <Button type="button" variant="primary" onClick={() => setAttempt((value) => value + 1)}>
              Reload saved milestone
            </Button>
          </InlineMessage>
        ) : null}
        {saveState === "error" ? (
          <InlineMessage tone="error">
            The current milestone could not be saved. Try again.
          </InlineMessage>
        ) : null}

        <div className="admin-settings-actions">
          <AsyncActionButton
            disabled={
              saveState === "conflict" ||
              (loadState.staleMilestoneNumber === null &&
                draft === loadState.milestoneNumber)
            }
            label="Save current milestone"
            pending={saving}
            pendingAnnouncement="Saving current milestone."
            pendingLabel="Saving…"
            type="submit"
            variant="primary"
          />
        </div>
      </form>
    </Panel>
  );
}

// The signed-in binding of the seam above: the token is read once here, so the form itself stays a
// plain function of its transport and can be rendered anywhere.
function ConnectedAdminSettingsForm() {
  const { getIdToken } = useAuth();
  const load = useCallback(
    () =>
      getIdToken().then((token) =>
        cmsGetSettings<BannerSettingsValues>(token, { id: NEWSROOM_HOME_SETTINGS_ID }),
      ),
    [getIdToken],
  );
  const save = useCallback(
    (request: SaveSettingsRequest<BannerSettingsValues>) =>
      getIdToken().then((token) => cmsSaveSettings<BannerSettingsValues>(token, request)),
    [getIdToken],
  );
  return <AdminSettingsForm load={load} save={save} />;
}

function ConnectedMilestoneSettingsForm() {
  const { getIdToken } = useAuth();
  const loadSettings = useCallback(
    () =>
      getIdToken().then((token) =>
        cmsGetSettings<MilestoneSettingsValues>(token, {
          id: NEWSROOM_MILESTONE_SETTINGS_ID,
        }),
      ),
    [getIdToken],
  );
  const save = useCallback(
    (request: SaveSettingsRequest<MilestoneSettingsValues>) =>
      getIdToken().then((token) =>
        cmsSaveSettings<MilestoneSettingsValues>(token, request),
      ),
    [getIdToken],
  );
  const loadStatus = useCallback(
    async () => fetchAdminStatus(await getIdToken()),
    [getIdToken],
  );
  return (
    <MilestoneSettingsForm
      loadSettings={loadSettings}
      loadStatus={loadStatus}
      save={save}
    />
  );
}

function ConnectedPublicHomepageBannerSettings() {
  const { getIdToken } = useAuth();
  const loadPages = useCallback(() => getIdToken().then(cmsListPages).then(response => response.pages), [getIdToken]);
  const loadLibrarySelection = useCallback(async (query: ContentQuery) =>
    cmsListContent(await getIdToken(), encodeContentQuery(query)), [getIdToken]);
  const loadRecord = useCallback(async (kind: RecordKind, id: string): Promise<LoadedRecord> => {
    const response = await cmsGetContent(await getIdToken(), { collection: "cmsPosts", id });
    if (!response.found || !response.document) return { status: "missing" };
    if (response.document.deleted === true) return { status: "deleted" };
    if (kind !== "post" || response.document.type !== "post") return { status: "invalid" };
    return { status: "ready", record: { ...response.document, id } };
  }, [getIdToken]);
  const load = useCallback(
    () =>
      getIdToken().then((token) =>
        cmsGetSettings<PublicHomepageBannerValues>(token, {
          id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
        }),
      ),
    [getIdToken],
  );
  const loadAppearance = useCallback(async () => {
    const token = await getIdToken();
    const response = await cmsGetSettings<NjDecidesValues>(token, { id: NJ_DECIDES_SETTINGS_ID });
    if (!response.found) return undefined;
    const published = projectPublishedCmsSettings({ documentId: NJ_DECIDES_SETTINGS_ID, document: response.settings });
    if (!published) return undefined;
    const values = published.values as unknown as NjDecidesValues;
    const assetIds = [...new Set([values.logoAssetId, values.backgroundAssetId].filter((id): id is string => Boolean(id)))];
    const media = assetIds.length ? await cmsListMedia(token, { assetIds }) : undefined;
    return { ...values, assets: Object.fromEntries((media?.records ?? [])
      .filter(asset => asset.lifecycle === "active").map(asset => [asset.id, asset])) };
  }, [getIdToken]);
  const save = useCallback<PublicHomepageBannerSettingsTransport["save"]>(
    (request) =>
      getIdToken().then((token) =>
        cmsSaveSettings<PublicHomepageBannerValues>(token, request),
      ),
    [getIdToken],
  );
  const publish = useCallback<PublicHomepageBannerSettingsTransport["publish"]>(
    (request) =>
      getIdToken().then((token) =>
        cmsPublishSettings<PublicHomepageBannerValues>(token, request),
      ),
    [getIdToken],
  );

  return (
    <PublicHomepageBannerSettings
      contentSources={{ loadPages, loadLibrarySelection, loadRecord }}
      load={load}
      loadAppearance={loadAppearance}
      publish={publish}
      save={save}
    />
  );
}

function ConnectedSiteNavigationSettings() {
  const { getIdToken } = useAuth();
  const load = useCallback(
    () =>
      getIdToken().then((token) =>
        cmsGetSettings<SiteNavigationValues>(token, { id: SITE_NAVIGATION_SETTINGS_ID }),
      ),
    [getIdToken],
  );
  const save = useCallback<SiteNavigationSettingsTransport["save"]>(
    (request) =>
      getIdToken().then((token) => cmsSaveSettings<SiteNavigationValues>(token, request)),
    [getIdToken],
  );
  const publish = useCallback<SiteNavigationSettingsTransport["publish"]>(
    (request) =>
      getIdToken().then((token) => cmsPublishSettings<SiteNavigationValues>(token, request)),
    [getIdToken],
  );

  const loadPages = useCallback<SiteNavigationSettingsTransport["loadPages"]>(
    () => getIdToken().then((token) => cmsListPages(token)).then(({ pages }) => pages),
    [getIdToken],
  );
  const loadVocabulary = useCallback(() => getIdToken().then(cmsPublishedVocabulary), [getIdToken]);
  return (
    <SiteNavigationSettings
      load={load}
      loadPages={loadPages}
      loadVocabulary={loadVocabulary}
      publish={publish}
      save={save}
    />
  );
}

function ConnectedPublicSiteChromeSettings() {
  const { getIdToken } = useAuth();
  const load = useCallback(
    () =>
      getIdToken().then((token) =>
        cmsGetSettings<PublicSiteChromeValues>(token, { id: PUBLIC_SITE_CHROME_SETTINGS_ID }),
      ),
    [getIdToken],
  );
  const save = useCallback<PublicSiteChromeSettingsTransport["save"]>(
    (request) =>
      getIdToken().then((token) => cmsSaveSettings<PublicSiteChromeValues>(token, request)),
    [getIdToken],
  );
  const publish = useCallback<PublicSiteChromeSettingsTransport["publish"]>(
    (request) =>
      getIdToken().then((token) => cmsPublishSettings<PublicSiteChromeValues>(token, request)),
    [getIdToken],
  );

  return (
    <PublicSiteChromeSettings
      load={load}
      publish={publish}
      save={save}
    />
  );
}

export function ConnectedCoverageLabelsSettings() {
  const { getIdToken } = useAuth();
  const load = useCallback(() => getIdToken().then(token => cmsGetSettings<CoverageLabelsSettingsValues>(token, { id: COVERAGE_LABELS_SETTINGS_ID })), [getIdToken]);
  const save = useCallback<CoverageLabelsSettingsTransport["save"]>(request => getIdToken().then(token => cmsSaveSettings<CoverageLabelsSettingsValues>(token, request)), [getIdToken]);
  const publish = useCallback<CoverageLabelsSettingsTransport["publish"]>(request => getIdToken().then(token => cmsPublishSettings<CoverageLabelsSettingsValues>(token, request)), [getIdToken]);
  return <CoverageLabelsSettings load={load} save={save} publish={publish} />;
}

export function ConnectedStoryCtaSettings() {
  const { getIdToken } = useAuth();
  const load = useCallback(() => getIdToken().then(token => cmsGetSettings<StoryCtasSettingsValues>(token, { id: STORY_CTAS_SETTINGS_ID })), [getIdToken]);
  const save = useCallback<StoryCtaSettingsTransport["save"]>(request => getIdToken().then(token => cmsSaveSettings<StoryCtasSettingsValues>(token, request)), [getIdToken]);
  const publish = useCallback<StoryCtaSettingsTransport["publish"]>(request => getIdToken().then(token => cmsPublishSettings<StoryCtasSettingsValues>(token, request)), [getIdToken]);
  const loadLibrarySelection = useCallback(async (query: ContentQuery) =>
    cmsListContent(await getIdToken(), encodeContentQuery(query)), [getIdToken]);
  const loadRecord = useCallback(async (kind: RecordKind, id: string): Promise<LoadedRecord> => {
    const response = await cmsGetContent(await getIdToken(), { collection: "cmsPosts", id });
    if (!response.found || !response.document) return { status: "missing" };
    if (response.document.deleted === true) return { status: "deleted" };
    if (kind !== "newsletter" || response.document.type !== "newsletter") return { status: "invalid" };
    return { status: "ready", record: { ...response.document, id } };
  }, [getIdToken]);
  const contentSources = useMemo(() => ({ loadLibrarySelection, loadRecord }), [loadLibrarySelection, loadRecord]);
  return <StoryCtaSettings contentSources={contentSources} load={load} save={save} publish={publish} />;
}

function ConnectedNjDecidesSettings() {
  const { getIdToken, state } = useAuth();
  const principal = state?.status === "signed-in" ? state.principal : null;
  const mayReadMedia = Boolean(principal && canUseMediaLibrary(principal));
  const mayUploadMedia = Boolean(principal && canUploadMedia(principal));
  const { state: mediaCategoryRegistry } = useMediaCategories(mayReadMedia);
  const load = useCallback(
    () => getIdToken().then((token) =>
      cmsGetSettings<NjDecidesValues>(token, { id: NJ_DECIDES_SETTINGS_ID })),
    [getIdToken],
  );
  const save = useCallback<NjDecidesSettingsTransport["save"]>(
    (request) => getIdToken().then((token) =>
      cmsSaveSettings<NjDecidesValues>(token, request)),
    [getIdToken],
  );
  const publish = useCallback<NjDecidesSettingsTransport["publish"]>(
    (request) => getIdToken().then((token) =>
      cmsPublishSettings<NjDecidesValues>(token, request)),
    [getIdToken],
  );
  const loadMedia = useCallback<NonNullable<NjDecidesSettingsTransport["loadMedia"]>>(
    (query, options) => getIdToken().then((token) => cmsListMedia(token, query, options?.signal)),
    [getIdToken],
  );
  const uploadMedia = useCallback<NonNullable<NjDecidesSettingsTransport["uploadMedia"]>>(
    (file, metadata, signal) => getIdToken().then((token) =>
      uploadMediaReusingDuplicates(token, file, metadata, signal)),
    [getIdToken],
  );

  return <RoutedNjDecidesSettings
    canUploadCategory={principal
      ? (category) => canUploadMedia(principal, category)
      : undefined}
    defaultUploadCategory={principal ? defaultMediaUploadCategory(principal) : undefined}
    load={load}
    loadMedia={mayReadMedia ? loadMedia : undefined}
    mediaCategories={mediaCategoryRegistry.status === "ready"
      ? mediaCategoryRegistry.categories
      : undefined}
    mediaPickerUnavailable={!mayReadMedia}
    publish={publish}
    save={save}
    uploadMedia={mayUploadMedia ? uploadMedia : undefined}
  />;
}

export function RoutedNjDecidesSettings(props: NjDecidesSettingsTransport) {
  const location = useLocation();
  return <NjDecidesSettings {...props} focusHeading={location.hash === "#nj-decides-settings-heading"} />;
}

function ConnectedMediaCategorySettings() {
  const { getIdToken } = useAuth();
  const load = useCallback(
    () => getIdToken().then((token) => cmsListMediaCategories(token)),
    [getIdToken],
  );
  const mutate = useCallback(
    async (
      request: Parameters<typeof cmsMutateMediaCategory>[1],
      etag?: string,
    ) => {
      const token = await getIdToken();
      const result = await cmsMutateMediaCategory(token, request, etag);
      resetMediaCategoryRegistry();
      return result;
    },
    [getIdToken],
  );
  return <MediaCategorySettings load={load} mutate={mutate} />;
}

export function AdminSettingsFrame({ children }: { children: ReactNode }) {
  return <div className="admin-settings">{children}</div>;
}

export function PublicWebsiteSettingsSection({ children }: { children: ReactNode }) {
  return <section className="admin-settings-group" aria-label="Public website settings">
    <div className="admin-settings-group-heading">
      <span className="eyebrow">Public website</span>
      <p>Control public messages, navigation, the header newsletter action and NJ Decides branding, then publish their saved versions.</p>
    </div>
    {children}
  </section>;
}

export function AdminSettingsRoute() {
  const studioDevicesEnabled = import.meta.env.VITE_CMS_DEPLOYMENT_ENVIRONMENT !== "development";
  return (
    <RequireCapability
      allowed={canManageSettings}
      notice="Admin settings aren't available for your account."
    >
      <AdminSettingsFrame>
        <SettingsWorkspace sections={[
          { id: "public-homepage-banner", label: "Homepage banner", group: "Public website", content: <ConnectedPublicHomepageBannerSettings /> },
          { id: "nj-decides-brand", label: "NJ Decides brand", headingId: "nj-decides-settings-heading", group: "Public website", content: <ConnectedNjDecidesSettings /> },
          { id: "coverage-labels", label: "Coverage labels", group: "Public website", content: <ConnectedCoverageLabelsSettings /> },
          { id: "story-ctas", label: "Story CTAs", group: "Public website", content: <ConnectedStoryCtaSettings /> },
          { id: "site-navigation", label: "Site navigation", group: "Public website", content: <ConnectedSiteNavigationSettings /> },
          { id: "public-site-chrome", label: "Header newsletter", group: "Public website", content: <ConnectedPublicSiteChromeSettings /> },
          { id: "media-categories", label: "Media categories", group: "Workspace", content: <ConnectedMediaCategorySettings /> },
          ...(studioDevicesEnabled ? [{ id: "studio-devices", label: "Studio devices", group: "Workspace" as const, content: <ConnectedLiveProductionDevices /> }] : []),
          { id: "newsroom-defaults", label: "Newsroom defaults", group: "Workspace", content: <div className="admin-settings-internal-grid"><ConnectedAdminSettingsForm /><ConnectedMilestoneSettingsForm /></div> },
        ]} />
      </AdminSettingsFrame>
    </RequireCapability>
  );
}

// A settings panel while its saved value loads: the real heading, then the field, help line
// and save button in their loaded places.
function SettingsPanelSkeleton({
  label,
  heading,
  field,
  withPreview = false,
}: {
  label: string;
  heading: string;
  field: string;
  withPreview?: boolean;
}) {
  return (
    // The region is the panel itself, so the settings grid's child selectors still match it.
    <SkeletonRegion label={label} className="panel panel-default admin-settings-panel">
      <div className="panel-heading">
        <div>
          <h2>{heading}</h2>
          <p><SkeletonText width="80%" /></p>
        </div>
      </div>
      <div className="admin-settings-form">
        <span className="editor-field-label">{field}</span>
        <SkeletonBlock height="var(--cms-control-height)" radius="control" />
        <p className="muted"><SkeletonText width="30%" /></p>
        {withPreview ? <SkeletonBlock height={88} radius="control" /> : null}
        <div className="admin-settings-actions">
          <SkeletonBlock className="admin-settings-action-shape" height="var(--cms-control-height)" radius="control" />
        </div>
      </div>
    </SkeletonRegion>
  );
}
