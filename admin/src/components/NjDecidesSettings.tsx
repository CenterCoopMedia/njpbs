import { SettingsBannerPreview } from "./SettingsBannerPreview";
import { SettingsInspector, useSettingsDirty } from "./SettingsWorkspace";
import { EditorFrameHeader } from "./EditorFrameHeader";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  DEFAULT_NJ_DECIDES_SETTINGS,
  NJ_DECIDES_SETTINGS_ID,
  currentCmsSettingsSchemaFor,
  validateCmsSettingsValues,
  type NjDecidesSettingsValues,
} from "../../../packages/content-core/src/cms-settings";
import { renderNjDecidesBand } from "../../../packages/content-core/src/nj-decides-render";
import "../../../packages/content-core/src/nj-decides.css";
import type { EditorField } from "../../../packages/content-core/src/editor-admin";
import { useSettingsPublication } from "../hooks/useSettingsPublication";
import {
  HttpError,
  isConflictError,
  settingsPublicationRefusalMessage,
  type CmsSettingsPublishedSnapshot,
  type GetSettingsResponse,
  type ListMediaResponse,
  type MediaAssetSummary,
  type MediaCategoryDefinition,
  type MutateSettingsResponse,
  type PublishSettingsRequest,
  type SaveSettingsRequest,
} from "../lib/functions";
import type { MediaPickerLoader } from "./MediaPickerDialog";
import type { MediaUploader } from "./MediaUploadForm";
import { FieldRenderer } from "./FieldRenderer";
import { SettingsPublicationStatus } from "./SettingsPublicationStatus";
import { LoadingIndicator } from "./ui/LoadingIndicator";
import {
  AsyncActionButton,
  Button,
  InlineMessage,
  Panel,
  TextInput,
} from "./ui/Primitives";
import { useSuccessNotice } from "./ui/SuccessNoticeRegion";
import "./NjDecidesSettings.css";

export { NJ_DECIDES_SETTINGS_ID };
export type NjDecidesValues = NjDecidesSettingsValues;

export interface NjDecidesSettingsTransport {
  load: () => Promise<GetSettingsResponse<NjDecidesValues>>;
  save: (
    request: SaveSettingsRequest<NjDecidesValues>,
  ) => Promise<MutateSettingsResponse<NjDecidesValues>>;
  publish: (
    request: PublishSettingsRequest,
  ) => Promise<MutateSettingsResponse<NjDecidesValues>>;
  loadMedia?: MediaPickerLoader;
  mediaPickerUnavailable?: boolean;
  uploadMedia?: MediaUploader;
  mediaCategories?: readonly MediaCategoryDefinition[];
  defaultUploadCategory?: string;
  canUploadCategory?: (category: string) => boolean;
}

interface NjDecidesDraft {
  backgroundColor: string;
  textColor: string;
  linkColor: string;
  ruleColor: string;
  accentColor: string;
  flagEnabled: boolean;
  logoAssetId: string;
  logoAlt: string;
  backgroundAssetId: string;
}

interface ReadySettings {
  status: "ready";
  values: NjDecidesValues;
  version: number | null;
  published: CmsSettingsPublishedSnapshot<NjDecidesValues> | null;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | ReadySettings;

type ActionState =
  | { type: "idle" }
  | { type: "saved" }
  | { type: "conflict"; message?: string }
  | { type: "save-error"; message: string }
  | { type: "publish-error"; message: string };

type ColorFieldName =
  | "backgroundColor"
  | "textColor"
  | "linkColor"
  | "ruleColor"
  | "accentColor";

interface ValidationResult {
  message: string | null;
  field?: ColorFieldName | "logoAssetId" | "logoAlt" | "backgroundAssetId";
}

const COLOR_FIELDS: readonly { key: ColorFieldName; label: string }[] = [
  { key: "backgroundColor", label: "Background color" },
  { key: "textColor", label: "Text color" },
  { key: "linkColor", label: "Link color" },
  { key: "ruleColor", label: "Rule color" },
  { key: "accentColor", label: "Accent color" },
];

const LOGO_FIELD: EditorField = {
  key: "logoAssetId",
  label: "Custom logo",
  help: "Choose an image only when the bundled NJ Decides logo should not be used.",
  kind: "asset",
  required: false,
};

const BACKGROUND_FIELD: EditorField = {
  key: "backgroundAssetId",
  label: "Background artwork",
  help: "Choose optional artwork. The selected background color stays behind all text and links.",
  kind: "asset",
  required: false,
};

const PREVIEW_COPY = "Find voting information for New Jersey.";
const PREVIEW_LINKS = [
  { label: "Check registration", href: "/voting/registration/" },
  { label: "Find a polling place", href: "/voting/polling-places/" },
] as const;

function njDecidesSchema() {
  const schema = currentCmsSettingsSchemaFor(NJ_DECIDES_SETTINGS_ID);
  if (!schema) throw new Error("The NJ Decides brand schema is unavailable.");
  return schema;
}

const SCHEMA = njDecidesSchema();

function draftFromValues(values: NjDecidesValues): NjDecidesDraft {
  return {
    backgroundColor: values.backgroundColor,
    textColor: values.textColor,
    linkColor: values.linkColor,
    ruleColor: values.ruleColor,
    accentColor: values.accentColor,
    flagEnabled: values.flagEnabled,
    logoAssetId: values.logoAssetId ?? "",
    logoAlt: values.logoAlt ?? "",
    backgroundAssetId: values.backgroundAssetId ?? "",
  };
}

function canonicalValues(draft: NjDecidesDraft): NjDecidesValues {
  const logoAssetId = draft.logoAssetId.trim();
  const logoAlt = draft.logoAlt.trim();
  const backgroundAssetId = draft.backgroundAssetId.trim();
  return {
    backgroundColor: draft.backgroundColor.trim(),
    textColor: draft.textColor.trim(),
    linkColor: draft.linkColor.trim(),
    ruleColor: draft.ruleColor.trim(),
    accentColor: draft.accentColor.trim(),
    flagEnabled: draft.flagEnabled,
    ...(logoAssetId ? { logoAssetId, ...(logoAlt ? { logoAlt } : {}) } : {}),
    ...(backgroundAssetId ? { backgroundAssetId } : {}),
  };
}

function valuesEqual(left: NjDecidesValues, right: NjDecidesValues): boolean {
  return (
    left.backgroundColor === right.backgroundColor &&
    left.textColor === right.textColor &&
    left.linkColor === right.linkColor &&
    left.ruleColor === right.ruleColor &&
    left.accentColor === right.accentColor &&
    left.flagEnabled === right.flagEnabled &&
    (left.logoAssetId ?? "") === (right.logoAssetId ?? "") &&
    (left.logoAlt ?? "") === (right.logoAlt ?? "") &&
    (left.backgroundAssetId ?? "") === (right.backgroundAssetId ?? "")
  );
}

function validationResult(values: NjDecidesValues): ValidationResult {
  const error = validateCmsSettingsValues(SCHEMA, values);
  if (!error) return { message: null };
  const color = COLOR_FIELDS.find(({ key }) => error.startsWith(key));
  if (color && !error.includes("contrast")) {
    return {
      field: color.key,
      message: `${color.label} must use the #RRGGBB format.`,
    };
  }
  if (error.startsWith("Text color") || error.includes("textColor must have")) {
    return {
      field: "textColor",
      message: "Text color must have at least 4.5:1 contrast against the background color.",
    };
  }
  if (error.startsWith("Link color") || error.includes("linkColor must have")) {
    return {
      field: "linkColor",
      message: "Link color must have at least 4.5:1 contrast against the background color.",
    };
  }
  if (error.startsWith("logoAlt")) {
    return {
      field: "logoAlt",
      message: error.startsWith("logoAlt can be at most")
        ? `Logo alternative text${error.slice("logoAlt".length)}.`
        : "Add alternative text for the custom logo.",
    };
  }
  if (error.startsWith("logoAssetId")) {
    return { field: "logoAssetId", message: "Choose a valid custom logo." };
  }
  if (error.startsWith("backgroundAssetId")) {
    return { field: "backgroundAssetId", message: "Choose valid background artwork." };
  }
  return { message: "The NJ Decides brand settings are invalid." };
}

function valuesFromUnknown(value: unknown): NjDecidesValues {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The NJ Decides brand setting is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.backgroundColor !== "string" ||
    typeof record.textColor !== "string" ||
    typeof record.linkColor !== "string" ||
    typeof record.ruleColor !== "string" ||
    typeof record.accentColor !== "string" ||
    typeof record.flagEnabled !== "boolean" ||
    (record.logoAssetId !== undefined && typeof record.logoAssetId !== "string") ||
    (record.logoAlt !== undefined && typeof record.logoAlt !== "string") ||
    (record.backgroundAssetId !== undefined && typeof record.backgroundAssetId !== "string") ||
    validateCmsSettingsValues(SCHEMA, record)
  ) {
    throw new Error("The NJ Decides brand setting is invalid.");
  }
  return canonicalValues({
    backgroundColor: record.backgroundColor,
    textColor: record.textColor,
    linkColor: record.linkColor,
    ruleColor: record.ruleColor,
    accentColor: record.accentColor,
    flagEnabled: record.flagEnabled,
    logoAssetId: typeof record.logoAssetId === "string" ? record.logoAssetId : "",
    logoAlt: typeof record.logoAlt === "string" ? record.logoAlt : "",
    backgroundAssetId: typeof record.backgroundAssetId === "string" ? record.backgroundAssetId : "",
  });
}

function publishedFromUnknown(value: unknown): CmsSettingsPublishedSnapshot<NjDecidesValues> | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The published NJ Decides brand setting is invalid.");
  }
  const record = value as Record<string, unknown>;
  const publishedAt = typeof record.publishedAt === "string" ? new Date(record.publishedAt) : null;
  if (
    record.schemaVersion !== SCHEMA.schemaVersion ||
    !Number.isSafeInteger(record.sourceVersion) ||
    Number(record.sourceVersion) < 1 ||
    !publishedAt ||
    Number.isNaN(publishedAt.getTime()) ||
    publishedAt.toISOString() !== record.publishedAt
  ) {
    throw new Error("The published NJ Decides brand setting is invalid.");
  }
  return {
    schemaVersion: SCHEMA.schemaVersion,
    sourceVersion: Number(record.sourceVersion),
    publishedAt: record.publishedAt,
    values: valuesFromUnknown(record.values),
  };
}

function readyFromResponse(response: GetSettingsResponse<NjDecidesValues>): ReadySettings {
  if (response.id !== NJ_DECIDES_SETTINGS_ID) {
    throw new Error("The NJ Decides brand setting id is invalid.");
  }
  if (!response.found) {
    return { status: "ready", values: DEFAULT_NJ_DECIDES_SETTINGS, version: null, published: null };
  }
  if (
    response.settings.schemaVersion !== SCHEMA.schemaVersion ||
    !Number.isSafeInteger(response.settings.version) ||
    response.settings.version < 1
  ) {
    throw new Error("The NJ Decides brand setting document is invalid.");
  }
  const published = publishedFromUnknown(response.settings.published);
  if (published && published.sourceVersion > response.settings.version) {
    throw new Error("The published NJ Decides brand setting is invalid.");
  }
  return {
    status: "ready",
    values: valuesFromUnknown(response.settings.values),
    version: response.settings.version,
    published,
  };
}

function readyFromMutation(response: MutateSettingsResponse<NjDecidesValues>): ReadySettings {
  return readyFromResponse({ success: true, found: true, id: response.id, settings: response.settings });
}

function plainError(error: unknown, fallback: string): string {
  if (error instanceof HttpError && error.message.trim()) return error.message.trim();
  return fallback;
}

function PublishedStatus({ published }: { published: CmsSettingsPublishedSnapshot<NjDecidesValues> | null }) {
  if (!published) return <>Not published</>;
  return <>
    Published version {published.sourceVersion} on{" "}
    <time dateTime={published.publishedAt}>{new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium", timeStyle: "short",
    }).format(new Date(published.publishedAt))}</time>
  </>;
}

function assetIds(values: NjDecidesValues): string[] {
  return [...new Set([values.logoAssetId, values.backgroundAssetId].filter(
    (value): value is string => typeof value === "string" && value !== "",
  ))];
}

function exactMediaResponse(records: MediaAssetSummary[]): ListMediaResponse {
  return {
    success: true, records, total: records.length, allCount: records.length,
    page: 1, pageCount: 1, categoryCounts: {}, kindCounts: { image: records.length },
  };
}

function previewAsset(asset: MediaAssetSummary) {
  return {
    url: asset.url,
    mimeType: asset.mimeType,
    ...(Number.isSafeInteger(asset.width) && Number(asset.width) > 0 ? { width: Number(asset.width) } : {}),
    ...(Number.isSafeInteger(asset.height) && Number(asset.height) > 0 ? { height: Number(asset.height) } : {}),
  };
}

function ColorField({
  field, draft, disabled, invalid, onChange,
}: {
  field: (typeof COLOR_FIELDS)[number];
  draft: NjDecidesDraft;
  disabled: boolean;
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  const id = `nj-decides-${field.key}`;
  const pickerId = `${id}-picker`;
  const value = draft[field.key];
  const pickerValue = /^#[0-9a-f]{6}$/i.test(value)
    ? value
    : DEFAULT_NJ_DECIDES_SETTINGS[field.key];
  return <div className="nj-decides-color-field">
    <label className="editor-field-label" htmlFor={id}>{field.label}</label>
    <div className="nj-decides-color-controls">
      <TextInput
        aria-describedby={invalid ? "nj-decides-validation-error" : undefined}
        aria-invalid={invalid || undefined}
        autoCapitalize="none"
        disabled={disabled}
        id={id}
        maxLength={7}
        onChange={(event) => onChange(event.target.value)}
        placeholder="#RRGGBB"
        spellCheck={false}
        value={value}
      />
      <label className="nj-decides-color-picker-label" htmlFor={pickerId}>
        <span className="sr-only">Choose {field.label.toLocaleLowerCase("en-US")}</span>
        <input
          aria-label={`Choose ${field.label.toLocaleLowerCase("en-US")}`}
          disabled={disabled}
          id={pickerId}
          onChange={(event) => onChange(event.target.value)}
          type="color"
          value={pickerValue}
        />
      </label>
    </div>
  </div>;
}

export function NjDecidesSettings({
  focusHeading = false,
  load,
  save,
  publish,
  loadMedia,
  mediaPickerUnavailable,
  uploadMedia,
  mediaCategories,
  defaultUploadCategory,
  canUploadCategory,
}: NjDecidesSettingsTransport & { focusHeading?: boolean }) {
  const [logoPickerDirty, setLogoPickerDirty] = useState(false);
  const [backgroundPickerDirty, setBackgroundPickerDirty] = useState(false);
  const successNotice = useSuccessNotice();
  const [attempt, setAttempt] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!focusHeading || loadState.status !== "ready") return;
    // The lazy route and saved settings must both arrive before the hash target exists.
    const frame = requestAnimationFrame(() => {
      const heading = headingRef.current;
      if (!heading) return;
      const owner = heading.closest("[data-settings-section]") ?? heading.closest("section");
      // A retained field or owned picker already restored by the workspace keeps focus.
      if (document.activeElement !== owner && owner?.contains(document.activeElement)) return;
      heading.scrollIntoView({ block: "center" });
      heading.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusHeading, loadState.status]);
  const [draft, setDraft] = useState<NjDecidesDraft>(
    draftFromValues(DEFAULT_NJ_DECIDES_SETTINGS),
  );
  const [pending, setPending] = useState<"save" | "publish" | "reload" | null>(null);
  const [actionState, setActionState] = useState<ActionState>({ type: "idle" });
  const [mediaError, setMediaError] = useState(false);
  const [mediaAttempt, setMediaAttempt] = useState(0);
  const [previewAssets, setPreviewAssets] = useState<Record<string, MediaAssetSummary>>({});
  const [resolvedAssetIds, setResolvedAssetIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const assetCache = useRef(new Map<string, MediaAssetSummary>());
  const resolvedAssetIdsRef = useRef(new Set<string>());
  const {
    publication,
    observe,
    retry,
    retrying,
    refresh,
    needsRefresh,
  } = useSettingsPublication(load, (sourceVersion) =>
    publish({ id: NJ_DECIDES_SETTINGS_ID, baseVersion: sourceVersion }),
  );

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
        setLoadState(loaded);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadState({
            status: "error",
            message: plainError(error, "Try the request again."),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, load, observe]);

  const savedAssetKey =
    loadState.status === "ready"
      ? `${loadState.version ?? "new"}:${assetIds(loadState.values).join(",")}`
      : "not-ready";

  useEffect(() => {
    if (loadState.status !== "ready" || !loadMedia) return;
    const ids = assetIds(loadState.values);
    const missing = ids.filter((id) => !resolvedAssetIdsRef.current.has(id));
    if (missing.length === 0) {
      setMediaError(false);
      return;
    }
    let cancelled = false;
    setMediaError(false);
    void loadMedia({
      q: "",
      assetIds: missing,
      categories: [],
      kinds: ["image"],
      sort: "updatedAt",
      direction: "desc",
      page: 1,
    })
      .then((response) => {
        if (cancelled) return;
        for (const id of missing) resolvedAssetIdsRef.current.add(id);
        for (const asset of response.records) {
          if (missing.includes(asset.id)) assetCache.current.set(asset.id, asset);
        }
        setPreviewAssets(Object.fromEntries(assetCache.current));
        setResolvedAssetIds(new Set(resolvedAssetIdsRef.current));
      })
      .catch(() => {
        if (!cancelled) setMediaError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [loadMedia, mediaAttempt, savedAssetKey]);

  const cachedLoadMedia = useCallback<MediaPickerLoader>(
    async (query, options) => {
      if (query.assetIds && query.assetIds.every((id) => resolvedAssetIds.has(id))) {
        return exactMediaResponse(
          query.assetIds.flatMap((id) => {
            const asset = previewAssets[id];
            return asset ? [asset] : [];
          }),
        );
      }
      if (!loadMedia) return exactMediaResponse([]);
      return loadMedia(query, options);
    },
    [loadMedia, previewAssets, resolvedAssetIds],
  );

  function edit(update: Partial<NjDecidesDraft>) {
    setDraft((current) => ({ ...current, ...update }));
    setActionState((current) =>
      current.type === "conflict" ? current : { type: "idle" },
    );
  }

  function selectAsset(
    field: "logoAssetId" | "backgroundAssetId",
    asset: MediaAssetSummary | null,
  ) {
    const nextAssetId = asset?.id ?? "";
    if (field === "logoAssetId") {
      edit(nextAssetId === draft.logoAssetId
        ? { logoAssetId: nextAssetId }
        : { logoAssetId: nextAssetId, logoAlt: "" });
    } else {
      edit({ backgroundAssetId: nextAssetId });
    }
    if (!asset) return;
    assetCache.current.set(asset.id, asset);
    resolvedAssetIdsRef.current.add(asset.id);
    setPreviewAssets(Object.fromEntries(assetCache.current));
    setResolvedAssetIds(new Set(resolvedAssetIdsRef.current));
  }

  function adopt(ready: ReadySettings) {
    setDraft(draftFromValues(ready.values));
    setLoadState(ready);
  }

  function resetDraft() {
    setDraft(draftFromValues(DEFAULT_NJ_DECIDES_SETTINGS));
    setActionState((current) =>
      current.type === "conflict" ? current : { type: "idle" },
    );
  }

  async function saveDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      loadState.status !== "ready" ||
      pending ||
      actionState.type === "conflict"
    ) return;
    const values = canonicalValues(draft);
    if (validationResult(values).message) return;
    setPending("save");
    setActionState({ type: "idle" });
    try {
      const response = await save(
        loadState.version === null
          ? { id: NJ_DECIDES_SETTINGS_ID, values, createOnly: true }
          : { id: NJ_DECIDES_SETTINGS_ID, values, baseVersion: loadState.version },
      );
      adopt(readyFromMutation(response));
      setActionState({ type: "saved" });
      successNotice.show("NJ Decides brand draft saved.");
    } catch (error) {
      setActionState(
        isConflictError(error)
          ? { type: "conflict" }
          : {
              type: "save-error",
              message: plainError(
                error,
                "The NJ Decides brand draft could not be saved. Try again.",
              ),
            },
      );
    } finally {
      setPending(null);
    }
  }

  async function publishDraft() {
    if (
      loadState.status !== "ready" ||
      pending ||
      retrying ||
      actionState.type === "conflict" ||
      loadState.version === null
    ) return;
    const values = canonicalValues(draft);
    if (validationResult(values).message || !valuesEqual(values, loadState.values)) return;
    setPending("publish");
    setActionState({ type: "idle" });
    try {
      const response = await publish({
        id: NJ_DECIDES_SETTINGS_ID,
        baseVersion: loadState.version,
      });
      const published = readyFromMutation(response);
      if (!published.published || !response.publication) {
        throw new Error("The settings publication receipt is missing.");
      }
      adopt(published);
      observe(response.publication);
    } catch (error) {
      const refusal = settingsPublicationRefusalMessage(error);
      setActionState(
        refusal
          ? { type: "publish-error", message: refusal }
          : isConflictError(error)
            ? { type: "conflict" }
            : {
                type: "publish-error",
                message: plainError(
                  error,
                  "The NJ Decides brand could not be published. Try again.",
                ),
              },
      );
    } finally {
      setPending(null);
    }
  }

  async function refreshConflict() {
    if (pending) return;
    setPending("reload");
    try {
      const response = await load();
      const loaded = readyFromResponse(response);
      observe(response.found ? response.publication : undefined);
      setLoadState(loaded);
      setActionState({ type: "idle" });
    } catch {
      setActionState({
        type: "conflict",
        message: "The current saved version could not be loaded. Your changes are still here.",
      });
    } finally {
      setPending(null);
    }
  }

  useSettingsDirty(loadState.status === "ready" && (!valuesEqual(canonicalValues(draft), loadState.values) || logoPickerDirty || backgroundPickerDirty), pending !== null || retrying);

  if (loadState.status === "loading") {
    return <LoadingIndicator
      label="Loading NJ Decides brand settings"
      stages={[
        "Asking the CMS for the saved brand",
        "Checking its publication state on the public site",
      ]}
    />;
  }

  if (loadState.status === "error") {
    return <InlineMessage tone="error" title="NJ Decides brand settings could not be loaded">
      <p>{loadState.message}</p>
      <Button onClick={() => setAttempt((value) => value + 1)}>Retry</Button>
    </InlineMessage>;
  }

  const values = canonicalValues(draft);
  const validation = validationResult(values);
  const valid = validation.message === null;
  const dirty = !valuesEqual(values, loadState.values);
  const publishedMatchesSaved = Boolean(
    loadState.published && valuesEqual(loadState.values, loadState.published.values),
  );
  const canPublish =
    valid &&
    !dirty &&
    loadState.version !== null &&
    !publishedMatchesSaved &&
    actionState.type !== "conflict";
  const isDefault = valuesEqual(values, DEFAULT_NJ_DECIDES_SETTINGS);
  const savedIds = assetIds(loadState.values);
  const mediaReady = savedIds.every((id) => resolvedAssetIds.has(id)) && !mediaError;
  const missingSavedAssets = savedIds.filter(
    (id) => resolvedAssetIds.has(id) && !previewAssets[id],
  );
  const fieldMediaLoader = loadMedia && mediaReady ? cachedLoadMedia : undefined;
  const assets = Object.fromEntries(
    Object.entries(previewAssets).map(([id, asset]) => [id, previewAsset(asset)]),
  );
  const previewHtml = valid
    ? renderNjDecidesBand({ copy: PREVIEW_COPY, links: PREVIEW_LINKS, branding: values, assets })
    : null;

  return <Panel
    className="admin-settings-panel settings-public-panel nj-decides-settings"
    aria-labelledby="nj-decides-settings-heading"
  >
    <div className="panel-heading">
      <div>
        <h2 id="nj-decides-settings-heading" ref={headingRef} tabIndex={-1}
          data-route-focus-heading={focusHeading || undefined}>NJ Decides brand</h2>
        <p>Prepare the shared NJ Decides colors and artwork. Publishing the brand does not add a public banner or apply a Page theme.</p>
      </div>
    </div>

    <form className="admin-settings-form settings-section-layout" onSubmit={saveDraft}>
      <div className="settings-section-fields">
      <fieldset className="nj-decides-settings-fields settings-card" disabled={pending !== null}>
        <legend>Colors</legend>

        <div className="nj-decides-color-grid">
          {COLOR_FIELDS.map((field) => <ColorField
            disabled={pending !== null}
            draft={draft}
            field={field}
            invalid={validation.field === field.key}
            key={field.key}
            onChange={(value) => edit({ [field.key]: value })}
          />)}
        </div>

        {valid && <InlineMessage tone="success">Text and link colors meet the 4.5:1 contrast target.</InlineMessage>}
      </fieldset>
      <fieldset className="nj-decides-settings-fields settings-card" disabled={pending !== null}>
        <legend>Artwork</legend>
        <label className="public-banner-toggle">
          <input
            aria-label="Show the diagonal flag"
            checked={draft.flagEnabled}
            className="editor-toggle"
            onChange={(event) => edit({ flagEnabled: event.target.checked })}
            type="checkbox"
          />
          <span>
            <strong>Show the diagonal flag</strong>
            <small>The flag is decorative and does not replace the NJ Decides logo.</small>
          </span>
        </label>

        <div className="nj-decides-asset-grid">
          <div>
            <FieldRenderer
              canUploadCategory={canUploadCategory}
              defaultUploadCategory={defaultUploadCategory}
              error={validation.field === "logoAssetId" ? validation.message ?? undefined : undefined}
              field={LOGO_FIELD}
              fieldId="nj-decides-logo-asset"
              onMediaPickerDirtyChange={setLogoPickerDirty}
              loadMedia={fieldMediaLoader}
              mediaCategories={mediaCategories}
              mediaPickerUnavailable={Boolean(mediaPickerUnavailable || !loadMedia || !mediaReady)}
              onAssetSelect={(asset) => selectAsset("logoAssetId", asset)}
              onChange={(value) => edit({ logoAssetId: typeof value === "string" ? value : "" })}
              uploadMedia={uploadMedia}
              value={draft.logoAssetId}
            />
            {draft.logoAssetId ? <label className="nj-decides-logo-alt" htmlFor="nj-decides-logo-alt">
              <span className="editor-field-label">Custom logo alternative text</span>
              <TextInput
                aria-describedby={validation.field === "logoAlt" ? "nj-decides-validation-error" : undefined}
                aria-invalid={validation.field === "logoAlt" || undefined}
                id="nj-decides-logo-alt"
                onChange={(event) => edit({ logoAlt: event.target.value })}
                required
                value={draft.logoAlt}
              />
              <small>Describe the words or identity shown in the custom logo.</small>
            </label> : null}
          </div>

          <FieldRenderer
            canUploadCategory={canUploadCategory}
            defaultUploadCategory={defaultUploadCategory}
            error={validation.field === "backgroundAssetId" ? validation.message ?? undefined : undefined}
            field={BACKGROUND_FIELD}
            fieldId="nj-decides-background-asset"
            onMediaPickerDirtyChange={setBackgroundPickerDirty}
            loadMedia={fieldMediaLoader}
            mediaCategories={mediaCategories}
            mediaPickerUnavailable={Boolean(mediaPickerUnavailable || !loadMedia || !mediaReady)}
            onAssetSelect={(asset) => selectAsset("backgroundAssetId", asset)}
            onChange={(value) => edit({ backgroundAssetId: typeof value === "string" ? value : "" })}
            uploadMedia={uploadMedia}
            value={draft.backgroundAssetId}
          />
        </div>
      </fieldset>

      {mediaError ? <InlineMessage tone="error">
        <p>The selected artwork could not be loaded for preview. The saved asset IDs are unchanged.</p>
        <Button onClick={() => setMediaAttempt((value) => value + 1)}>
          Retry artwork load
        </Button>
      </InlineMessage> : null}
      {missingSavedAssets.length > 0 ? <InlineMessage tone="warning">
        One or more saved images are unavailable. Choose a replacement or remove the image before you save.
      </InlineMessage> : null}

      {validation.message ? <InlineMessage tone="error">
        <span id="nj-decides-validation-error">{validation.message}</span>
      </InlineMessage> : null}

      </div>
      <SettingsInspector>
        <EditorFrameHeader scope="panel" title="Draft preview" />
      <section className="nj-decides-settings-preview" aria-labelledby="nj-decides-preview-heading">
        <div>
          <h3 id="nj-decides-preview-heading">Live preview</h3>
          <strong>Sample text</strong>
          <p>Sample text only. Edit the message and link in Homepage banner. Preview links are disabled here.</p>
        </div>
        {previewHtml ? <div
          aria-label="Proposed NJ Decides band preview"
          className="nj-decides-settings-preview-band"
        ><SettingsBannerPreview html={previewHtml} /></div> : <InlineMessage tone="error">Correct the brand settings to update the preview.</InlineMessage>}
      </section>

      <dl className="public-banner-status" aria-label="NJ Decides brand status">
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

      {actionState.type === "saved" && !successNotice.available
        ? <InlineMessage tone="success">NJ Decides brand draft saved.</InlineMessage>
        : null}
      {actionState.type === "conflict" ? <InlineMessage tone="error">
        <p>{actionState.message ?? "This setting changed after you opened it. Your local changes are still here."}</p>
        <AsyncActionButton
          label="Check saved version and keep my changes"
          onClick={() => void refreshConflict()}
          pending={pending === "reload"}
          pendingLabel="Checking…"
          type="button"
        />
      </InlineMessage> : null}
      {actionState.type === "save-error"
        ? <InlineMessage tone="error">{actionState.message}</InlineMessage>
        : null}
      {actionState.type === "publish-error"
        ? <InlineMessage tone="error">{actionState.message}</InlineMessage>
        : null}

      <SettingsPublicationStatus
        disabled={pending !== null}
        needsRefresh={needsRefresh}
        publication={publication}
        refresh={refresh}
        retry={retry}
        retrying={retrying}
      />

      </SettingsInspector>
      <div className="settings-section-actions">
      <p className="admin-settings-save-note">
        Reset changes only this local draft. Save draft stores these fields without changing the public site. Publish updates the public site from the saved draft.
      </p>
      <div className="admin-settings-actions">
        <Button
          disabled={pending !== null || isDefault}
          onClick={resetDraft}
          type="button"
          variant="ghost"
        >
          Reset to defaults
        </Button>
        <AsyncActionButton
          disabled={pending !== null || !valid || (!dirty && loadState.version !== null) || actionState.type === "conflict"}
          label="Save draft"
          pending={pending === "save"}
          pendingAnnouncement="Saving NJ Decides brand draft."
          pendingLabel="Saving…"
          type="submit"
          variant="secondary"
        />
        <AsyncActionButton
          disabled={pending !== null || retrying || !canPublish}
          label="Publish"
          onClick={() => void publishDraft()}
          pending={pending === "publish"}
          pendingAnnouncement="Starting NJ Decides brand publication."
          pendingLabel="Starting…"
          type="button"
          variant="primary"
        />
      </div>
      </div>
    </form>
  </Panel>;
}
