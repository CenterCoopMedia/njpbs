import { SettingsInspector, useSettingsDirty } from "./SettingsWorkspace";
import { SettingsBannerPreview } from "./SettingsBannerPreview";
import { EditorFrameHeader } from "./EditorFrameHeader";
import { useSettingsPublication } from "../hooks/useSettingsPublication";
import { SettingsPublicationStatus } from "./SettingsPublicationStatus";
import { type ContextType, type FormEvent, useEffect, useRef, useState } from "react";
import { ContentShelfSources } from "./ContentShelfPicker";
import { BannerPageExclusions } from "./BannerPageExclusions";
import {
  DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS,
  PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
  cmsSettingsSchemaFor,
  currentCmsSettingsSchemaFor,
  validateCmsSettingsValues,
  type CmsSettingsSchema,
  type PublicHomepageBannerSettingsValues,
} from "../../../packages/content-core/src/cms-settings";
import { renderNjDecidesBand } from "../../../packages/content-core/src/nj-decides-render";
import "../../../packages/content-core/src/nj-decides.css";
import { PUBLIC_SITE_ORIGIN } from "../../../packages/content-core/src/public-pages";
import { STATION_TIME_ZONE } from "../../../packages/content-core/src/station-time";
import type { EditorField } from "../../../packages/content-core/src/editor-admin";
import {
  AsyncActionButton,
  Button,
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
export type PublicHomepageBannerValues = PublicHomepageBannerSettingsValues;

function scheduleInstantLabel(value: string): string {
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? value : new Intl.DateTimeFormat("en-US", {
    timeZone: STATION_TIME_ZONE, month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(instant);
}

function publicHomepageBannerSchema() {
  const schema = currentCmsSettingsSchemaFor(PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID);
  if (!schema) {
    throw new Error("The public homepage banner schema is unavailable.");
  }
  return schema;
}

const PUBLIC_HOMEPAGE_BANNER_SCHEMA = publicHomepageBannerSchema();

function stringFieldMaxBytes(
  field: "message" | "linkLabel" | "linkHref" | "liveLabel",
): number {
  const definition = PUBLIC_HOMEPAGE_BANNER_SCHEMA.fields[field];
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

interface BannerDraft {
  excludedPaths: string[];
  enabled: boolean;
  message: string;
  linkLabel: string;
  linkHref: string;
  secondLinkLabel: string;
  secondLinkHref: string;
  njDecides: boolean;
  liveLabel: string;
  startsAt: string;
  endsAt: string;
}

interface ReadySettings {
  status: "ready";
  values: PublicHomepageBannerValues;
  version: number | null;
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

const DEFAULT_VALUES = DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS;

const MODE_FIELD: EditorField = {
  key: "njDecides",
  label: "Use NJ Decides sitewide mode",
  help: "Use the branded election band across the public site, except the URLs selected below.",
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

function candidateValues(draft: BannerDraft): PublicHomepageBannerValues {
  const message = draft.message.trim();
  const linkLabel = draft.linkLabel.trim();
  const linkHref = draft.linkHref.trim();
  const liveLabel = draft.liveLabel.trim();
  return {
    enabled: draft.enabled,
    message,
    ...(linkLabel ? { linkLabel } : {}),
    ...(linkHref ? { linkHref } : {}),
    ...(draft.secondLinkLabel.trim() ? { secondLinkLabel: draft.secondLinkLabel.trim() } : {}),
    ...(draft.secondLinkHref.trim() ? { secondLinkHref: draft.secondLinkHref.trim() } : {}),
    njDecides: draft.njDecides,
    ...(liveLabel ? { liveLabel } : {}),
    ...(draft.startsAt ? { startsAt: draft.startsAt } : {}),
    ...(draft.endsAt ? { endsAt: draft.endsAt } : {}),
    ...(draft.excludedPaths.length ? { excludedPaths: [...draft.excludedPaths] } : {}),
  };
}

function canonicalValues(draft: BannerDraft): PublicHomepageBannerValues {
  return candidateValues(draft);
}

function draftFromValues(values: PublicHomepageBannerValues): BannerDraft {
  return {
    enabled: values.enabled,
    message: values.message,
    linkLabel: values.linkLabel ?? "",
    linkHref: values.linkHref ?? "",
    secondLinkLabel: values.secondLinkLabel ?? "",
    secondLinkHref: values.secondLinkHref ?? "",
    njDecides: values.njDecides === true,
    liveLabel: values.liveLabel ?? "",
    startsAt: values.startsAt ?? "",
    endsAt: values.endsAt ?? "",
    excludedPaths: [...(values.excludedPaths ?? [])],
  };
}

function valuesEqual(
  left: PublicHomepageBannerValues,
  right: PublicHomepageBannerValues,
): boolean {
  return (
    left.enabled === right.enabled &&
    left.message === right.message &&
    (left.linkLabel ?? "") === (right.linkLabel ?? "") &&
    (left.linkHref ?? "") === (right.linkHref ?? "") &&
    (left.secondLinkLabel ?? "") === (right.secondLinkLabel ?? "") &&
    (left.secondLinkHref ?? "") === (right.secondLinkHref ?? "") &&
    (left.njDecides ?? false) === (right.njDecides ?? false) &&
    (left.liveLabel ?? "") === (right.liveLabel ?? "") &&
    (left.startsAt ?? "") === (right.startsAt ?? "") &&
    (left.endsAt ?? "") === (right.endsAt ?? "") &&
    JSON.stringify(left.excludedPaths ?? []) === JSON.stringify(right.excludedPaths ?? [])
  );
}

function publicPreviewHref(href: string | undefined): string | undefined {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
  try {
    return new URL(href, `${PUBLIC_SITE_ORIGIN}/`).href;
  } catch {
    return href;
  }
}

function validationErrors(draft: BannerDraft): ValidationErrors {
  const error = validateCmsSettingsValues(
    PUBLIC_HOMEPAGE_BANNER_SCHEMA,
    candidateValues(draft),
  );
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
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The homepage banner setting is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.enabled !== "boolean" || typeof record.message !== "string") {
    throw new Error("The homepage banner setting is invalid.");
  }
  if (
    (record.linkLabel !== undefined && typeof record.linkLabel !== "string") ||
    (record.linkHref !== undefined && typeof record.linkHref !== "string") ||
    (record.njDecides !== undefined && typeof record.njDecides !== "boolean") ||
    (record.liveLabel !== undefined && typeof record.liveLabel !== "string") ||
    (record.startsAt !== undefined && typeof record.startsAt !== "string") ||
    (record.endsAt !== undefined && typeof record.endsAt !== "string")
  ) {
    throw new Error("The homepage banner setting is invalid.");
  }
  if (validateCmsSettingsValues(schema, record)) {
    throw new Error("The homepage banner setting is invalid.");
  }
  return {
    enabled: record.enabled,
    message: record.message,
    ...(typeof record.linkLabel === "string" ? { linkLabel: record.linkLabel } : {}),
    ...(typeof record.linkHref === "string" ? { linkHref: record.linkHref } : {}),
    ...(typeof record.secondLinkLabel === "string" ? { secondLinkLabel: record.secondLinkLabel } : {}),
    ...(typeof record.secondLinkHref === "string" ? { secondLinkHref: record.secondLinkHref } : {}),
    ...(typeof record.njDecides === "boolean" ? { njDecides: record.njDecides } : {}),
    ...(typeof record.liveLabel === "string" ? { liveLabel: record.liveLabel } : {}),
    ...(typeof record.startsAt === "string" ? { startsAt: record.startsAt } : {}),
    ...(typeof record.endsAt === "string" ? { endsAt: record.endsAt } : {}),
    ...(Array.isArray(record.excludedPaths) ? { excludedPaths: [...record.excludedPaths] as string[] } : {}),
  };
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
  return {
    status: "ready",
    values: valuesFromUnknown(
      response.settings.values,
      schemaForVersion(response.settings.schemaVersion),
    ),
    version: response.settings.version,
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
  const standardSnapshot = useRef<PublicHomepageBannerValues | null>(null);
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

  function edit(update: Partial<BannerDraft>) {
    setDraft((current) => ({ ...current, ...update }));
    setActionState((current) =>
      current.type === "conflict" ? current : { type: "idle" },
    );
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
    if (loadState.status !== "ready" || pending) return;
    const errors = { ...validationErrors(draft), ...dateDraftErrors };
    if (!isValid(errors)) return;
    const values = {
      ...canonicalValues(draft),
      // Explicit clearing distinguishes this client from an older Admin that
      // cannot display or preserve the saved second link.
      ...(loadState.values.secondLinkLabel && !draft.secondLinkLabel.trim() && !draft.secondLinkHref.trim()
        ? { secondLinkLabel: "", secondLinkHref: "" } : {}),
    };
    setPending("save");
    setActionState({ type: "idle" });
    try {
      const response = await save(
        loadState.version === null
          ? {
              id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
              values,
              createOnly: true,
            }
          : {
              id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
              values,
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
    const errors = { ...validationErrors(draft), ...dateDraftErrors };
    const values = canonicalValues(draft);
    if (!isValid(errors) || !valuesEqual(values, loadState.values)) return;

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

  useEffect(() => {
    if (loadState.status === "ready" && loadState.published && !loadState.published.values.njDecides) {
      standardSnapshot.current = loadState.published.values;
    }
  }, [loadState]);

  useSettingsDirty(loadState.status === "ready" && (!valuesEqual(canonicalValues(draft), loadState.values) || Object.keys(dateDraftErrors).length > 0), pending !== null || retrying);

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

  const errors = { ...validationErrors(draft), ...dateDraftErrors };
  const values = canonicalValues(draft);
  const valid = isValid(errors);
  const dirty = !valuesEqual(values, loadState.values);
  const publishedMatchesSaved = Boolean(
    loadState.published && valuesEqual(loadState.values, loadState.published.values),
  );
  const canPublish =
    valid &&
    !dirty &&
    loadState.version !== null &&
    (!publishedMatchesSaved || !publication);
  const previewHref = publicPreviewHref(values.linkHref);
  const previewOpensNewTab = previewHref
    ? !/^(?:mailto|tel):/i.test(previewHref)
    : false;
  const secondPreviewHref = publicPreviewHref(values.secondLinkHref);
  const secondPreviewOpensNewTab = Boolean(secondPreviewHref && !/^(?:mailto|tel):/i.test(secondPreviewHref));
  const electionPreviewHtml = values.njDecides
    ? renderNjDecidesBand({
        copy: values.message,
        branding: appearance,
        liveLabel: values.liveLabel,
        links: valid && values.linkLabel && values.linkHref
          ? [{ label: values.linkLabel, href: values.linkHref },
              ...(values.secondLinkLabel && values.secondLinkHref
                ? [{ label: values.secondLinkLabel, href: values.secondLinkHref }] : [])]
          : [],
      })
    : "";

  const standard = loadState.published && !loadState.published.values.njDecides
    ? loadState.published.values : standardSnapshot.current;
  const standardTextRemains = values.njDecides && standard &&
    (["message", "linkLabel", "linkHref", "secondLinkLabel", "secondLinkHref"] as const).some(key =>
      Boolean(values[key]) && values[key] === standard[key]);
  const scheduleHasError = Boolean(errors.startsAt || errors.endsAt || errors.schedule);
  const scheduleSummary = [draft.startsAt && `Starts ${scheduleInstantLabel(draft.startsAt)}`, draft.endsAt && `Ends ${scheduleInstantLabel(draft.endsAt)}`].filter(Boolean).join(" · ") || "No schedule set";

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
              onChange={(value) => edit({ njDecides: Boolean(value) })}
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
              onChange={(value) => edit({ enabled: Boolean(value) })}
              togglePresentation="inline"
              value={draft.enabled}
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
              <p>The band shows the NJ Decides logo, then this message and up to two links. Replace the standard banner text with election text, or leave Message empty to show only the logo and links.</p>
              <Button type="button" disabled={pending !== null} onClick={() => edit({
                message: "Find voting information for New Jersey.",
                linkLabel: "NJ Decides 2026", linkHref: "/nj-decides-2026/",
              })}>Use suggested election text</Button>
            </div>}
            <FieldRenderer
              error={errors.message}
              field={{ ...MESSAGE_FIELD, required: !draft.njDecides }}
              fieldId="public-banner-message"
              onChange={(value) => edit({ message: String(value) })}
              value={draft.message}
              valueStatus={`${utf8Bytes(draft.message.trim())} of ${PUBLIC_HOMEPAGE_BANNER_MESSAGE_BYTES} bytes used.`}
            />
            <FieldRenderer
              additionalDescriptionId={errors.linkPair ? "public-banner-link-pair-error" : undefined}
              error={errors.linkLabel}
              field={LINK_LABEL_FIELD}
              fieldId="public-banner-link-label"
              invalid={Boolean(errors.linkPair)}
              onChange={(value) => edit({ linkLabel: String(value) })}
              value={draft.linkLabel}
            />
            <FieldRenderer
              additionalDescriptionId={errors.linkPair ? "public-banner-link-pair-error" : undefined}
              error={errors.linkHref}
              field={LINK_HREF_FIELD}
              fieldId="public-banner-link-href"
              invalid={Boolean(errors.linkPair)}
              onChange={(value) => edit({ linkHref: String(value) })}
              value={draft.linkHref}
            />
            <FieldRenderer
              additionalDescriptionId={errors.secondLinkPair ? "public-banner-second-link-pair-error" : undefined}
              error={errors.secondLinkLabel}
              field={SECOND_LINK_LABEL_FIELD}
              fieldId="public-banner-second-link-label"
              invalid={Boolean(errors.secondLinkPair)}
              onChange={(value) => edit({ secondLinkLabel: String(value) })}
              value={draft.secondLinkLabel}
            />
            <FieldRenderer
              additionalDescriptionId={errors.secondLinkPair ? "public-banner-second-link-pair-error" : undefined}
              error={errors.secondLinkHref}
              field={SECOND_LINK_HREF_FIELD}
              fieldId="public-banner-second-link-href"
              invalid={Boolean(errors.secondLinkPair)}
              onChange={(value) => edit({ secondLinkHref: String(value) })}
              value={draft.secondLinkHref}
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
              error={errors.liveLabel}
              field={LIVE_LABEL_FIELD}
              fieldId="public-banner-live-label"
              onChange={(value) => edit({ liveLabel: String(value) })}
              value={draft.liveLabel}
              valueStatus={`${utf8Bytes(draft.liveLabel.trim())} of ${PUBLIC_HOMEPAGE_BANNER_LIVE_LABEL_BYTES} bytes used.`}
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
              additionalDescriptionId={errors.schedule ? "public-banner-schedule-error" : undefined}
              error={errors.startsAt}
              field={STARTS_AT_FIELD}
              fieldId="public-banner-starts-at"
              invalid={Boolean(errors.schedule)}
              onChange={(value) => edit({ startsAt: String(value) })}
              onDraftError={(message) => reportDateDraftError("startsAt", message)}
              value={draft.startsAt}
            />
            <FieldRenderer
              additionalDescriptionId={errors.schedule ? "public-banner-schedule-error" : undefined}
              error={errors.endsAt}
              field={ENDS_AT_FIELD}
              fieldId="public-banner-ends-at"
              invalid={Boolean(errors.schedule)}
              onChange={(value) => edit({ endsAt: String(value) })}
              onDraftError={(message) => reportDateDraftError("endsAt", message)}
              value={draft.endsAt}
            />
          </div>
          {errors.schedule ? (
            <p className="error-text" id="public-banner-schedule-error" role="alert">
              {errors.schedule}
            </p>
          ) : null}
        </fieldset>
        </details>

        {draft.njDecides && <div className="settings-card"><BannerPageExclusions paths={draft.excludedPaths} sources={contentSources}
          disabled={pending !== null} onChange={excludedPaths => edit({ excludedPaths })} /></div>}

      </div>
      <SettingsInspector>
        <EditorFrameHeader scope="panel" title="Draft preview" />
        {standardTextRemains && <InlineMessage tone="warning">This is still the standard banner text. Review Message and both links before publishing the NJ Decides band.</InlineMessage>}
        <div
          className="public-banner-preview"
          data-enabled={String(values.enabled)}
          aria-label={values.njDecides
            ? "Proposed NJ Decides sitewide banner preview"
            : "Proposed homepage banner preview"}
        >
          <span>{values.njDecides ? "NJ Decides sitewide preview" : "Homepage preview"}</span>
          {values.njDecides && <p className="muted">Sample page: Home. {draft.excludedPaths.includes("/")
            ? "The band is hidden on Home."
            : "The band can appear here when enabled and within its schedule."}</p>}
          {values.njDecides && appearanceError && <p role="status">Published appearance could not be loaded. This preview uses the approved defaults. Reload settings to try again.</p>}
          {values.enabled && !(values.njDecides && draft.excludedPaths.includes("/")) ? (
            values.njDecides ? (
              <SettingsBannerPreview html={electionPreviewHtml} />
            ) : (
              <div className="public-banner-preview-row">
                <strong>{values.message || "Banner message"}</strong>
                {valid && values.linkLabel && values.linkHref ? (
                  <a
                    href={previewHref}
                    rel={previewOpensNewTab ? "noopener" : undefined}
                    target={previewOpensNewTab ? "_blank" : undefined}
                  >
                    {values.linkLabel} <span aria-hidden="true">→</span>
                    {previewOpensNewTab ? <span className="sr-only"> (opens in new tab)</span> : null}
                  </a>
                ) : null}
                {valid && values.secondLinkLabel && values.secondLinkHref && (
                  <a href={secondPreviewHref}
                    target={secondPreviewOpensNewTab ? "_blank" : undefined}
                    rel={secondPreviewOpensNewTab ? "noopener" : undefined}>
                    {values.secondLinkLabel} <span aria-hidden="true">→</span>
                    {secondPreviewOpensNewTab ? <span className="sr-only"> (opens in new tab)</span> : null}
                  </a>
                )}
              </div>
            )
          ) : (
            <div>
              <strong>{values.enabled && values.njDecides && draft.excludedPaths.includes("/")
                ? "Hidden on Home" : values.njDecides ? "Hidden from the public site" : "Hidden from the homepage"}</strong>
              <p>{values.enabled && values.njDecides && draft.excludedPaths.includes("/")
                ? "The band can still appear on other pages. Save and publish to apply your choices."
                : values.njDecides
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
            disabled={pending !== null || !valid || !dirty}
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
