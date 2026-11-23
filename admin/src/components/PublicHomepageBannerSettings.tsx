import { SettingsInspector, useSettingsDirty } from "./SettingsWorkspace";
import { SettingsBannerPreview } from "./SettingsBannerPreview";
import { EditorFrameHeader } from "./EditorFrameHeader";
import { useSettingsPublication } from "../hooks/useSettingsPublication";
import { SettingsPublicationStatus } from "./SettingsPublicationStatus";
import { type ContextType, type FormEvent, useEffect, useState } from "react";
import { ContentShelfSources } from "./ContentShelfPicker";
import { BannerPageExclusions } from "./BannerPageExclusions";
import {
  DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS,
  PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
  activeHomepageBannerContent,
  cmsSettingsSchemaFor,
  legacyBannerNeedsSave,
  separateHomepageBannerContent,
  validateCmsSettingsValues,
  validateHomepageBannerContent,
  type CmsSettingsSchema,
  type ElectionHomepageBannerContent,
  type LegacyHomepageBannerSettingsValues,
  type PublicHomepageBannerSettingsValues,
  type StandardHomepageBannerContent,
} from "../../../packages/content-core/src/cms-settings";
import { renderNjDecidesBand } from "../../../packages/content-core/src/nj-decides-render";
import { renderHomepageAnnouncement } from "../../../packages/content-core/src/homepage-announcement-render";
import "../../../packages/content-core/src/nj-decides.css";
import { PUBLIC_SITE_ORIGIN } from "../../../packages/content-core/src/public-pages";
import { STATION_TIME_ZONE } from "../../../packages/content-core/src/station-time";
import type { EditorField } from "../../../packages/content-core/src/editor-admin";
import {
  AsyncActionButton,
  Button,
  buttonClassName,
  InlineMessage,
  Panel,
} from "./ui/Primitives";
import { FieldRenderer } from "./FieldRenderer";
import { InfoTooltip } from "./ui/InfoTooltip";
import { LoadingIndicator } from "./ui/LoadingIndicator";
import {
  isConflictError,
  settingsPublicationRefusalMessage,
  type CmsSettingsPublishedSnapshot,
  type GetSettingsResponse,
  type MutateSettingsResponse,
  type PublishSettingsRequest,
  type SaveSettingsRequest,
} from "../lib/functions";
import { useSuccessNotice } from "./ui/SuccessNoticeRegion";

export { PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID };
export type PublicHomepageBannerValues = PublicHomepageBannerSettingsValues | LegacyHomepageBannerSettingsValues;

function scheduleInstantLabel(value: string): string {
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? value : new Intl.DateTimeFormat("en-US", {
    timeZone: STATION_TIME_ZONE, month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(instant);
}

function stringFieldMaxBytes(
  field: "message" | "linkLabel" | "linkHref" | "liveLabel",
): number {
  const definition = cmsSettingsSchemaFor(PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID, 4)?.fields[field];
  if (!definition || (definition.kind !== "string" && definition.kind !== "safeHref")) {
    throw new Error(`The public homepage banner ${field} schema is invalid.`);
  }
  return definition.maxBytes;
}

export const PUBLIC_HOMEPAGE_BANNER_MESSAGE_BYTES = stringFieldMaxBytes("message");
export const PUBLIC_HOMEPAGE_BANNER_LINK_LABEL_BYTES = stringFieldMaxBytes("linkLabel");
export const PUBLIC_HOMEPAGE_BANNER_LINK_HREF_BYTES = stringFieldMaxBytes("linkHref");
export const PUBLIC_HOMEPAGE_BANNER_LIVE_LABEL_BYTES = stringFieldMaxBytes("liveLabel");

export interface PublicHomepageBannerSettingsTransport {
  contentSources?: ContextType<typeof ContentShelfSources>;
  loadAppearance?: () => Promise<unknown>;
  load: () => Promise<GetSettingsResponse<PublicHomepageBannerValues>>;
  save: (
    request: SaveSettingsRequest<PublicHomepageBannerValues>,
  ) => Promise<MutateSettingsResponse<PublicHomepageBannerValues>>;
  publish: (
    request: PublishSettingsRequest,
  ) => Promise<MutateSettingsResponse<PublicHomepageBannerValues>>;
}

interface ContentDraft {
  enabled: boolean;
  message: string;
  linkLabel: string;
  linkHref: string;
  secondLinkLabel: string;
  secondLinkHref: string;
}

interface ElectionDraft extends ContentDraft {
  liveLabel: string;
  startsAt: string;
  endsAt: string;
  excludedPaths: string[];
}

interface BannerDraft {
  njDecides: boolean;
  standard: ContentDraft;
  election: ElectionDraft;
}

interface ReadySettings {
  status: "ready";
  values: PublicHomepageBannerSettingsValues;
  version: number | null;
  needsMigrationSave: boolean;
  published: CmsSettingsPublishedSnapshot<PublicHomepageBannerValues> | null;
}

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | ReadySettings;

type ActionState =
  | { type: "idle" }
  | { type: "saved" }
  | { type: "conflict" }
  | { type: "save-error" }
  | { type: "publish-error"; message?: string };

interface ValidationErrors {
  message?: string;
  linkLabel?: string;
  linkHref?: string;
  linkPair?: string;
  secondLinkLabel?: string;
  secondLinkHref?: string;
  secondLinkPair?: string;
  liveLabel?: string;
  startsAt?: string;
  endsAt?: string;
  schedule?: string;
}

type DateDraftErrors = Partial<Record<"startsAt" | "endsAt", string>>;

const DEFAULT_VALUES = separateHomepageBannerContent(DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS);

const MODE_FIELD: EditorField = {
  key: "njDecides",
  label: "Use NJ Decides sitewide mode",
  help: "Choose which banner to publish. Each mode keeps its own message, links and visibility setting.",
  kind: "toggle",
  required: false,
};

const MESSAGE_FIELD: EditorField = {
  key: "message",
  label: "Message",
  help: "The public announcement. In NJ Decides mode, this functional copy is optional because the logo is the title.",
  kind: "text",
  multiline: true,
  required: false,
};

const LINK_LABEL_FIELD: EditorField = {
  key: "linkLabel",
  label: "Link label",
  help: "Optional call-to-action text. Add a link URL with it, or leave both fields blank.",
  kind: "text",
  required: false,
};

const LINK_HREF_FIELD: EditorField = {
  key: "linkHref",
  label: "Link URL",
  help: "Add a safe public URL with the link label. NJ Decides links must be absolute or start with /.",
  kind: "url",
  required: false,
};

const SECOND_LINK_LABEL_FIELD: EditorField = {
  key: "secondLinkLabel", label: "Second link label", kind: "text", required: false,
  help: "Optional. Add up to two links, shown side by side and wrapped on phones. Fill in the first link before adding the second.",
};
const SECOND_LINK_HREF_FIELD: EditorField = {
  key: "secondLinkHref", label: "Second link URL", kind: "url", required: false,
  help: "Add a safe public URL with the second label, or leave both second link fields blank to remove it.",
};

const LIVE_LABEL_FIELD: EditorField = {
  key: "liveLabel",
  label: "Live label",
  help: "Optional short text for a live election update.",
  kind: "text",
  required: false,
};

const STARTS_AT_FIELD: EditorField = {
  key: "startsAt",
  label: "Start date and time",
  help: `Optional. The band starts at this time in Eastern Time (${STATION_TIME_ZONE}).`,
  kind: "datetime",
  required: false,
};

const ENDS_AT_FIELD: EditorField = {
  key: "endsAt",
  label: "End date and time",
  help: `Optional. The band ends at this time in Eastern Time (${STATION_TIME_ZONE}).`,
  kind: "datetime",
  required: false,
};

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function contentValues(draft: ContentDraft): StandardHomepageBannerContent {
  const message = draft.message.trim();
  const linkLabel = draft.linkLabel.trim();
  const linkHref = draft.linkHref.trim();
  return {
    enabled: draft.enabled,
    message,
    ...(linkLabel ? { linkLabel } : {}),
    ...(linkHref ? { linkHref } : {}),
    ...(draft.secondLinkLabel.trim() ? { secondLinkLabel: draft.secondLinkLabel.trim() } : {}),
    ...(draft.secondLinkHref.trim() ? { secondLinkHref: draft.secondLinkHref.trim() } : {}),
  };
}

function canonicalValues({ njDecides, standard, election }: BannerDraft): PublicHomepageBannerSettingsValues {
  const liveLabel = election.liveLabel.trim();
  return {
    njDecides,
    standard: contentValues(standard),
    election: {
      ...contentValues(election),
      ...(liveLabel ? { liveLabel } : {}),
      ...(election.startsAt ? { startsAt: election.startsAt } : {}),
      ...(election.endsAt ? { endsAt: election.endsAt } : {}),
      ...(election.excludedPaths.length ? { excludedPaths: [...election.excludedPaths] } : {}),
    },
  };
}

function contentDraft(values: StandardHomepageBannerContent): ContentDraft {
  return {
    enabled: values.enabled,
    message: values.message,
    linkLabel: values.linkLabel ?? "",
    linkHref: values.linkHref ?? "",
    secondLinkLabel: values.secondLinkLabel ?? "",
    secondLinkHref: values.secondLinkHref ?? "",
  };
}

function draftFromValues({ njDecides, standard, election }: PublicHomepageBannerSettingsValues): BannerDraft {
  return {
    njDecides,
    standard: contentDraft(standard),
    election: {
      ...contentDraft(election),
      liveLabel: election.liveLabel ?? "",
      startsAt: election.startsAt ?? "",
      endsAt: election.endsAt ?? "",
      excludedPaths: [...(election.excludedPaths ?? [])],
    },
  };
}

function valuesEqual(
  left: PublicHomepageBannerSettingsValues,
  right: PublicHomepageBannerSettingsValues,
): boolean {
  return JSON.stringify(canonicalValues(draftFromValues(left))) === JSON.stringify(canonicalValues(draftFromValues(right)));
}

function validationErrors(mode: "standard" | "election", values: ElectionHomepageBannerContent): ValidationErrors {
  const error = validateHomepageBannerContent(mode, values);
  const errors: ValidationErrors = {};
  if (!error) return errors;
  if (error.startsWith("message")) {
    errors.message = error.includes("required")
      ? "Enter a message for a standard homepage banner."
      : `Enter a message of no more than ${PUBLIC_HOMEPAGE_BANNER_MESSAGE_BYTES} bytes.`;
  } else if (error.includes("must be provided together")) {
    if (error.startsWith("secondLink")) errors.secondLinkPair = "Enter both second link fields or leave both blank.";
    else errors.linkPair = "Enter both link fields or leave both blank.";
  } else if (error.startsWith("linkLabel")) {
    errors.linkLabel = `Enter a link label of no more than ${PUBLIC_HOMEPAGE_BANNER_LINK_LABEL_BYTES} bytes.`;
  } else if (error.startsWith("linkHref")) {
    errors.linkHref = error.includes("absolute address")
      ? "Enter an absolute URL or a path that starts with /."
      : error.includes("safe link")
        ? "Enter a safe link URL."
        : `Enter a link URL of no more than ${PUBLIC_HOMEPAGE_BANNER_LINK_HREF_BYTES} bytes.`;
  } else if (error.startsWith("secondLinkLabel")) {
    errors.secondLinkLabel = error.includes("requires the first link")
      ? "Add the first link before adding a second link."
      : `Enter a second link label of no more than ${PUBLIC_HOMEPAGE_BANNER_LINK_LABEL_BYTES} bytes.`;
  } else if (error.startsWith("secondLinkHref")) {
    errors.secondLinkHref = error.includes("absolute address")
      ? "Enter an absolute URL or a path that starts with /."
      : error.includes("safe link") ? "Enter a safe second link URL."
      : `Enter a second link URL of no more than ${PUBLIC_HOMEPAGE_BANNER_LINK_HREF_BYTES} bytes.`;
  } else if (error.startsWith("liveLabel")) {
    errors.liveLabel = `Enter a live label of no more than ${PUBLIC_HOMEPAGE_BANNER_LIVE_LABEL_BYTES} bytes.`;
  } else if (error.startsWith("startsAt")) {
    if (error.includes("before endsAt")) {
      errors.schedule = "The start date and time must be before the end date and time.";
    } else {
      errors.startsAt = "Choose a valid start date and time.";
    }
  } else if (error.startsWith("endsAt")) {
    errors.endsAt = "Choose a valid end date and time.";
  } else {
    errors.message = "The homepage banner fields are invalid.";
  }
  return errors;
}

function isValid(errors: ValidationErrors): boolean {
  return Object.keys(errors).length === 0;
}

function valuesFromUnknown(
  value: unknown,
  schema: CmsSettingsSchema,
): PublicHomepageBannerValues {
  if (validateCmsSettingsValues(schema, value)) {
    throw new Error("The homepage banner setting is invalid.");
  }
  return value as PublicHomepageBannerValues;
}

function schemaForVersion(schemaVersion: unknown): CmsSettingsSchema {
  if (!Number.isSafeInteger(schemaVersion)) {
    throw new Error("The homepage banner schema version is invalid.");
  }
  const schema = cmsSettingsSchemaFor(
    PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
    Number(schemaVersion),
  );
  if (!schema) throw new Error("The homepage banner schema version is invalid.");
  return schema;
}

function publishedFromUnknown(
  value: unknown,
): CmsSettingsPublishedSnapshot<PublicHomepageBannerValues> | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The published homepage banner setting is invalid.");
  }
  const record = value as Record<string, unknown>;
  const publishedAt =
    typeof record.publishedAt === "string" ? new Date(record.publishedAt) : null;
  if (
    !Number.isSafeInteger(record.schemaVersion) ||
    !Number.isSafeInteger(record.sourceVersion) ||
    Number(record.sourceVersion) < 1 ||
    !publishedAt ||
    Number.isNaN(publishedAt.getTime()) ||
    publishedAt.toISOString() !== record.publishedAt
  ) {
    throw new Error("The published homepage banner setting is invalid.");
  }
  return {
    schemaVersion: Number(record.schemaVersion),
    sourceVersion: Number(record.sourceVersion),
    publishedAt: record.publishedAt,
    values: valuesFromUnknown(record.values, schemaForVersion(record.schemaVersion)),
  };
}

function readyFromResponse(
  response: GetSettingsResponse<PublicHomepageBannerValues>,
): ReadySettings {
  if (!response.found) {
    return {
      status: "ready",
      values: DEFAULT_VALUES,
      version: null,
      needsMigrationSave: false,
      published: null,
    };
  }
  if (response.id !== PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID) {
    throw new Error("The homepage banner setting id is invalid.");
  }
  if (!Number.isSafeInteger(response.settings.version) || response.settings.version < 1) {
    throw new Error("The homepage banner version is invalid.");
  }
  const published = publishedFromUnknown(response.settings.published);
  if (published && published.sourceVersion > response.settings.version) {
    throw new Error("The published homepage banner version is invalid.");
  }
  const values = valuesFromUnknown(response.settings.values, schemaForVersion(response.settings.schemaVersion));
  return {
    status: "ready",
    values: separateHomepageBannerContent(values, published?.values),
    version: response.settings.version,
    needsMigrationSave: legacyBannerNeedsSave(values, published?.values),
    published,
  };
}

function readyFromMutation(
  response: MutateSettingsResponse<PublicHomepageBannerValues>,
): ReadySettings {
  return readyFromResponse({
    success: true,
    found: true,
    id: response.id,
    settings: response.settings,
  });
}

function PublishedStatus({
  published,
}: {
  published: CmsSettingsPublishedSnapshot<PublicHomepageBannerValues> | null;
}) {
  if (!published) return <>Not published</>;
  return (
    <>
      Published version {published.sourceVersion} on{" "}
      <time dateTime={published.publishedAt}>
        {new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(published.publishedAt))}
      </time>
    </>
  );
}

export function PublicHomepageBannerSettings({
  load,
  save,
  publish,
  loadAppearance,
  contentSources,
}: PublicHomepageBannerSettingsTransport) {
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const successNotice = useSuccessNotice();
  const [attempt, setAttempt] = useState(0);
  const [appearance, setAppearance] = useState<unknown>();
  const [appearanceError, setAppearanceError] = useState(false);
  useEffect(() => {
    if (!loadAppearance) return;
    let cancelled = false;
    setAppearanceError(false);
    void loadAppearance().then(value => { if (!cancelled) setAppearance(value); })
      .catch(() => { if (!cancelled) setAppearanceError(true); });
    return () => { cancelled = true; };
  }, [loadAppearance, attempt]);
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [draft, setDraft] = useState<BannerDraft>(draftFromValues(DEFAULT_VALUES));
  const [dateDraftErrors, setDateDraftErrors] = useState<DateDraftErrors>({});
  const [pending, setPending] = useState<"save" | "publish" | null>(null);
  const [actionState, setActionState] = useState<ActionState>({ type: "idle" });
  const { publication, observe, retry, retrying, refresh, needsRefresh } = useSettingsPublication(load,
    (sourceVersion) => publish({ id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID, baseVersion: sourceVersion }));

  useEffect(() => {
    let cancelled = false;
    setLoadState({ status: "loading" });
    setActionState({ type: "idle" });
    observe();
    load()
      .then((response) => {
        if (!cancelled) observe(response.found ? response.publication : undefined);
        return readyFromResponse(response);
      })
      .then((loaded) => {
        if (cancelled) return;
        setDraft(draftFromValues(loaded.values));
        setDateDraftErrors({});
        setLoadState(loaded);

      })
      .catch(() => {
        if (!cancelled) setLoadState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, load, observe]);

  function edit(update: (current: BannerDraft) => BannerDraft) {
    setDraft(update);
    setActionState((current) =>
      current.type === "conflict" ? current : { type: "idle" },
    );
  }

  const mode = draft.njDecides ? "election" : "standard";
  const content = draft[mode];
  const election = draft.election;
  const draftValues = canonicalValues(draft);
  const standardErrors = validationErrors("standard", draftValues.standard);
  const electionErrors = { ...validationErrors("election", draftValues.election), ...dateDraftErrors };
  const errors = draft.njDecides ? electionErrors : standardErrors;
  const otherModeErrors = draft.njDecides ? standardErrors : electionErrors;
  const valid = isValid(standardErrors) && isValid(electionErrors);

  function editContent(update: Partial<ContentDraft>) {
    edit(current => ({ ...current, [mode]: { ...current[mode], ...update } }));
  }

  function editElection(update: Partial<ElectionDraft>) {
    edit(current => ({ ...current, election: { ...current.election, ...update } }));
  }

  function adopt(ready: ReadySettings) {
    setDraft(draftFromValues(ready.values));
    setDateDraftErrors({});
    setLoadState(ready);
  }

  function reportDateDraftError(
    field: "startsAt" | "endsAt",
    message: string | null,
  ) {
    setDateDraftErrors((current) => {
      if (message === (current[field] ?? null)) return current;
      const next = { ...current };
      if (message) next[field] = message;
      else delete next[field];
      return next;
    });
  }

  async function saveDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loadState.status !== "ready" || pending || !valid) return;
    setPending("save");
    setActionState({ type: "idle" });
    try {
      const response = await save(
        loadState.version === null
          ? {
              id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
              values: draftValues,
              createOnly: true,
            }
          : {
              id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
              values: draftValues,
              baseVersion: loadState.version,
            },
      );
      adopt(readyFromMutation(response));
      setActionState({ type: "saved" });
      successNotice.show("Homepage banner draft saved.");
    } catch (error) {
      setActionState({
        type: isConflictError(error) ? "conflict" : "save-error",
      });
    } finally {
      setPending(null);
    }
  }

  async function publishDraft() {
    if (loadState.status !== "ready" || pending || retrying || loadState.version === null) return;
    if (!valid || loadState.needsMigrationSave || !valuesEqual(draftValues, loadState.values)) return;

    setPending("publish");
    setActionState({ type: "idle" });
    try {
      const response = await publish({ id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
        baseVersion: loadState.version });
      const published = readyFromMutation(response);
      if (!published.published || !response.publication) throw new Error("The settings publication receipt is missing.");
      adopt(published);
      observe(response.publication);
    } catch (error) {
      const message = settingsPublicationRefusalMessage(error);
      setActionState(message ? { type: "publish-error", message }
        : { type: isConflictError(error) ? "conflict" : "publish-error" });
    } finally {
      setPending(null);
    }
  }

  useSettingsDirty(loadState.status === "ready" && (!valuesEqual(draftValues, loadState.values) || !isValid(dateDraftErrors)), pending !== null || retrying);

  if (loadState.status === "loading") {
    return (
      <LoadingIndicator
        label="Loading public homepage banner"
        stages={[
          "Asking the CMS for the saved banner",
          "Checking its publication state on the public site",
        ]}
      />
    );
  }
  if (loadState.status === "error") {
    return (
      <InlineMessage tone="error" title="Public homepage banner could not be loaded">
        <p>Try the request again.</p>
        <Button onClick={() => setAttempt((value) => value + 1)}>Retry</Button>
      </InlineMessage>
    );
  }

  const values = activeHomepageBannerContent(draftValues);
  const { njDecides } = values;
  const dirty = !valuesEqual(draftValues, loadState.values);
  const publishedMatchesSaved = Boolean(
    loadState.published && valuesEqual(loadState.values, separateHomepageBannerContent(loadState.published.values)),
  );
  const canPublish =
    valid &&
    !dirty &&
    !loadState.needsMigrationSave &&
    loadState.version !== null &&
    (!publishedMatchesSaved || !publication);
  const link = isValid(errors) && values.linkLabel && values.linkHref
    ? { label: values.linkLabel, href: values.linkHref } : undefined;
  const secondLink = link && values.secondLinkLabel && values.secondLinkHref
    ? { label: values.secondLinkLabel, href: values.secondLinkHref } : undefined;
  const links = link ? [link, ...(secondLink ? [secondLink] : [])] : [];
  const previewHtml = njDecides
    ? renderNjDecidesBand({
        copy: values.message,
        branding: appearance,
        liveLabel: values.liveLabel,
        links,
      })
    : renderHomepageAnnouncement({ message: values.message || "Banner message", link, secondLink });

  const scheduleHasError = Boolean(electionErrors.startsAt || electionErrors.endsAt || electionErrors.schedule);
  const scheduleSummary = [election.startsAt && `Starts ${scheduleInstantLabel(election.startsAt)}`, election.endsAt && `Ends ${scheduleInstantLabel(election.endsAt)}`].filter(Boolean).join(" · ") || "No schedule set";

  return (
    <Panel className="admin-settings-panel settings-public-panel" aria-labelledby="public-homepage-banner-heading">
      <div className="panel-heading">
        <div>
          <h2 tabIndex={-1} id="public-homepage-banner-heading">Public homepage banner</h2>
          <p>Publish a homepage announcement or an NJ Decides band for the full public site.</p>
        </div>
      </div>

      <form className="record-form admin-settings-form public-banner-settings settings-section-layout" onSubmit={saveDraft}>
        <div className="settings-section-fields">
        <fieldset
          className="record-field-group settings-card"
          data-field-group="presentation"
          disabled={pending !== null}
        >
          <legend>
            Presentation
            <InfoTooltip
              label="Presentation"
              content="Choose the standard homepage announcement or the sitewide NJ Decides band, then choose whether it is on."
            />
          </legend>
          <div className="record-field-group-fields">
            <FieldRenderer
              field={MODE_FIELD}
              fieldId="public-banner-nj-decides"
              onChange={(value) => edit(current => ({ ...current, njDecides: Boolean(value) }))}
              togglePresentation="inline"
              value={draft.njDecides}
            />
            <FieldRenderer
              field={{
                key: "enabled",
                label: draft.njDecides
                  ? "Show NJ Decides band sitewide"
                  : "Show banner on the homepage",
                help: draft.njDecides
                  ? "The schedule can limit when the published band appears."
                  : "Publication controls when this saved message appears.",
                kind: "toggle",
                required: false,
              }}
              fieldId="public-banner-enabled"
              onChange={(value) => editContent({ enabled: Boolean(value) })}
              togglePresentation="inline"
              value={content.enabled}
            />
          </div>
        </fieldset>

        <fieldset
          className="record-field-group settings-card"
          data-field-group="content"
          disabled={pending !== null}
        >
          <legend>
            Content
            <InfoTooltip
              label="Content"
              content="Set the public message and up to two links. Each link needs both a label and URL; the second needs the first."
            />
          </legend>
          <div className="record-field-group-fields">
            {draft.njDecides && <div className="settings-banner-guidance">
              <p>Leave Message empty to show the NJ Decides logo and any links you add.</p>
              <Button type="button" disabled={pending !== null} onClick={() => editContent({
                message: "Find voting information for New Jersey.",
                linkLabel: "NJ Decides 2026", linkHref: "/nj-decides-2026/",
              })}>Use suggested election text</Button>
            </div>}
            <FieldRenderer
              error={errors.message}
              field={{ ...MESSAGE_FIELD, required: !draft.njDecides && content.enabled }}
              fieldId="public-banner-message"
              onChange={(value) => editContent({ message: String(value) })}
              value={content.message}
              valueStatus={`${utf8Bytes(content.message.trim())} of ${PUBLIC_HOMEPAGE_BANNER_MESSAGE_BYTES} bytes used.`}
            />
            <FieldRenderer
              additionalDescriptionId={errors.linkPair ? "public-banner-link-pair-error" : undefined}
              error={errors.linkLabel}
              field={LINK_LABEL_FIELD}
              fieldId="public-banner-link-label"
              invalid={Boolean(errors.linkPair)}
              onChange={(value) => editContent({ linkLabel: String(value) })}
              value={content.linkLabel}
            />
            <FieldRenderer
              additionalDescriptionId={errors.linkPair ? "public-banner-link-pair-error" : undefined}
              error={errors.linkHref}
              field={LINK_HREF_FIELD}
              fieldId="public-banner-link-href"
              invalid={Boolean(errors.linkPair)}
              onChange={(value) => editContent({ linkHref: String(value) })}
              value={content.linkHref}
            />
            <FieldRenderer
              additionalDescriptionId={errors.secondLinkPair ? "public-banner-second-link-pair-error" : undefined}
              error={errors.secondLinkLabel}
              field={SECOND_LINK_LABEL_FIELD}
              fieldId="public-banner-second-link-label"
              invalid={Boolean(errors.secondLinkPair)}
              onChange={(value) => editContent({ secondLinkLabel: String(value) })}
              value={content.secondLinkLabel}
            />
            <FieldRenderer
              additionalDescriptionId={errors.secondLinkPair ? "public-banner-second-link-pair-error" : undefined}
              error={errors.secondLinkHref}
              field={SECOND_LINK_HREF_FIELD}
              fieldId="public-banner-second-link-href"
              invalid={Boolean(errors.secondLinkPair)}
              onChange={(value) => editContent({ secondLinkHref: String(value) })}
              value={content.secondLinkHref}
            />
          </div>
          {errors.secondLinkPair && <p className="error-text" id="public-banner-second-link-pair-error" role="alert">{errors.secondLinkPair}</p>}
          {errors.linkPair ? (
            <p className="error-text" id="public-banner-link-pair-error" role="alert">
              {errors.linkPair}
            </p>
          ) : null}
        </fieldset>

        <fieldset
          className="record-field-group settings-card"
          data-field-group="nj-decides-details"
          disabled={pending !== null}
        >
          <legend>
            NJ Decides details
            <InfoTooltip
              label="NJ Decides details"
              content="These optional fields are used only when NJ Decides sitewide mode is on."
            />
          </legend>
          <div className="record-field-group-fields">
            <FieldRenderer
              error={electionErrors.liveLabel}
              field={LIVE_LABEL_FIELD}
              fieldId="public-banner-live-label"
              onChange={(value) => editElection({ liveLabel: String(value) })}
              value={election.liveLabel}
              valueStatus={`${utf8Bytes(election.liveLabel.trim())} of ${PUBLIC_HOMEPAGE_BANNER_LIVE_LABEL_BYTES} bytes used.`}
            />
          </div>
        </fieldset>
        <details className="settings-card settings-schedule" open={scheduleOpen || scheduleHasError}
          onToggle={event => {
            if (scheduleHasError && !event.currentTarget.open) event.currentTarget.open = true;
            setScheduleOpen(event.currentTarget.open);
          }}>
          <summary>Schedule · {scheduleSummary} · NJ Decides band only</summary>
          <fieldset disabled={pending !== null}>
            <legend className="sr-only">Optional schedule</legend>
            <div className="record-field-group-fields">
            <FieldRenderer
              additionalDescriptionId={electionErrors.schedule ? "public-banner-schedule-error" : undefined}
              error={electionErrors.startsAt}
              field={STARTS_AT_FIELD}
              fieldId="public-banner-starts-at"
              invalid={Boolean(electionErrors.schedule)}
              onChange={(value) => editElection({ startsAt: String(value) })}
              onDraftError={(message) => reportDateDraftError("startsAt", message)}
              value={election.startsAt}
            />
            <FieldRenderer
              additionalDescriptionId={electionErrors.schedule ? "public-banner-schedule-error" : undefined}
              error={electionErrors.endsAt}
              field={ENDS_AT_FIELD}
              fieldId="public-banner-ends-at"
              invalid={Boolean(electionErrors.schedule)}
              onChange={(value) => editElection({ endsAt: String(value) })}
              onDraftError={(message) => reportDateDraftError("endsAt", message)}
              value={election.endsAt}
            />
          </div>
          {electionErrors.schedule ? (
            <p className="error-text" id="public-banner-schedule-error" role="alert">
              {electionErrors.schedule}
            </p>
          ) : null}
        </fieldset>
        </details>

        {draft.njDecides && <div className="settings-card"><BannerPageExclusions paths={election.excludedPaths} sources={contentSources}
          disabled={pending !== null} onChange={excludedPaths => editElection({ excludedPaths })} /></div>}

      </div>
      <SettingsInspector>
        <EditorFrameHeader scope="panel" title="Draft preview" />
        {loadState.needsMigrationSave && <InlineMessage tone="info">Save the draft before publishing to keep the saved content for both modes.</InlineMessage>}
        {!isValid(otherModeErrors) && <InlineMessage tone="error">Review the {draft.njDecides ? "standard banner" : "NJ Decides band"} fields before saving.</InlineMessage>}
        <div
          className="public-banner-preview"
          data-enabled={String(values.enabled)}
          aria-label={njDecides
            ? "Proposed NJ Decides sitewide banner preview"
            : "Proposed homepage banner preview"}
        >
          <span>{njDecides ? "NJ Decides sitewide preview" : "Homepage preview"}</span>
          {njDecides && <p className="muted">Sample page: Home. {election.excludedPaths.includes("/")
            ? "The band is hidden on Home."
            : "The band can appear here when enabled and within its schedule."}</p>}
          {njDecides && appearanceError && <p role="status">Published appearance could not be loaded. This preview uses the approved defaults. Reload settings to try again.</p>}
          {values.enabled && !(njDecides && election.excludedPaths.includes("/")) ? (
            <>
              <SettingsBannerPreview html={previewHtml} variant={njDecides ? "election" : "homepage"} />
              {!njDecides && links.map(({ label, href }, index) => {
                const destination = new URL(href, `${PUBLIC_SITE_ORIGIN}/`);
                const opensNewTab = destination.protocol === "https:" || destination.protocol === "http:";
                const actionLabel = `Check link: ${label}`;
                return <a key={index} className={buttonClassName()} href={destination.href}
                  target={opensNewTab ? "_blank" : undefined} rel={opensNewTab ? "noopener" : undefined}
                  aria-label={opensNewTab ? `${actionLabel} (opens in new tab)` : undefined}>
                  <span>{actionLabel}</span>
                </a>;
              })}
            </>
          ) : (
            <div>
              <strong>{values.enabled && njDecides && election.excludedPaths.includes("/")
                ? "Hidden on Home" : njDecides ? "Hidden from the public site" : "Hidden from the homepage"}</strong>
              <p>{values.enabled && njDecides && election.excludedPaths.includes("/")
                ? "The band can still appear on other pages. Save and publish to apply your choices."
                : njDecides
                ? "Enable the band to include it in the next publication."
                : "Enable the banner to include this message in the next publication."}</p>
            </div>
          )}
        </div>

        <dl className="public-banner-status" aria-label="Homepage banner status">
          <div>
            <dt>Edit state</dt>
            <dd>{dirty ? "Unsaved changes" : "No unsaved changes"}</dd>
          </div>
          <div>
            <dt>Saved draft</dt>
            <dd>{loadState.version === null ? "Draft not saved" : `Saved draft version ${loadState.version}`}</dd>
          </div>
          <div>
            <dt>Published</dt>
            <dd><PublishedStatus published={loadState.published} /></dd>
          </div>
        </dl>

        {actionState.type === "saved" && !successNotice.available ? (
          <InlineMessage tone="success">Homepage banner draft saved.</InlineMessage>
        ) : null}
        {actionState.type === "conflict" ? (
          <InlineMessage tone="error">
            <p>This setting changed after you opened it.</p>
            <Button type="button" onClick={() => setAttempt((value) => value + 1)}>
              Reload saved banner
            </Button>
          </InlineMessage>
        ) : null}
        {actionState.type === "save-error" ? (
          <InlineMessage tone="error">The homepage banner draft could not be saved. Try again.</InlineMessage>
        ) : null}
        {actionState.type === "publish-error" ? (
          <InlineMessage tone="error">{actionState.message ?? "The homepage banner could not be published. Try again."}</InlineMessage>
        ) : null}
        <SettingsPublicationStatus publication={publication} retry={retry} retrying={retrying} refresh={refresh} needsRefresh={needsRefresh} disabled={pending !== null} />

      </SettingsInspector>
      <div className="settings-section-actions">
        <p className="admin-settings-save-note">
          Save draft stores these fields without changing the public site. Publish updates the public site from the saved draft.
        </p>
        <div className="admin-settings-actions">
          <AsyncActionButton
            disabled={pending !== null || !valid || (!dirty && !loadState.needsMigrationSave)}
            label="Save draft"
            pending={pending === "save"}
            pendingAnnouncement="Saving homepage banner draft."
            pendingLabel="Saving…"
            type="submit"
            variant="secondary"
          />
          <AsyncActionButton
            disabled={pending !== null || retrying || !canPublish}
            label="Publish"
            onClick={() => void publishDraft()}
            pending={pending === "publish"}
            pendingAnnouncement="Starting homepage banner publication."
            pendingLabel="Starting…"
            type="button"
            variant="primary"
          />
        </div>
        </div>
    </form>
    </Panel>
  );
}
