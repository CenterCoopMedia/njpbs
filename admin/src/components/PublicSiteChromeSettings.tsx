import { SettingsInspector, useSettingsDirty } from "./SettingsWorkspace";
import { EditorFrameHeader } from "./EditorFrameHeader";
import { useSettingsPublication } from "../hooks/useSettingsPublication";
import { SettingsPublicationStatus } from "./SettingsPublicationStatus";
import { type FormEvent, useEffect, useState } from "react";
import {
  DEFAULT_PUBLIC_SITE_CHROME_SETTINGS,
  PUBLIC_SITE_CHROME_SETTINGS_ID,
  currentCmsSettingsSchemaFor,
  validateCmsSettingsValues,
  type PublicSiteChromeSettingsValues,
} from "../../../packages/content-core/src/cms-settings";
import { resolvePublicSiteChromeNewsletter } from "../../../packages/content-core/src/public-site-chrome";
import { PUBLIC_SITE_ORIGIN } from "../../../packages/content-core/src/public-pages";
import {
  AsyncActionButton,
  Button,
  InlineMessage,
  Panel,
  TextInput,
} from "./ui/Primitives";
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

export { PUBLIC_SITE_CHROME_SETTINGS_ID };
export type PublicSiteChromeValues = PublicSiteChromeSettingsValues;

export interface PublicSiteChromeSettingsTransport {
  load: () => Promise<GetSettingsResponse<PublicSiteChromeValues>>;
  save: (
    request: SaveSettingsRequest<PublicSiteChromeValues>,
  ) => Promise<MutateSettingsResponse<PublicSiteChromeValues>>;
  publish: (
    request: PublishSettingsRequest,
  ) => Promise<MutateSettingsResponse<PublicSiteChromeValues>>;
}

interface ReadySettings {
  status: "ready";
  values: PublicSiteChromeValues;
  version: number | null;
  published: CmsSettingsPublishedSnapshot<PublicSiteChromeValues> | null;
}

type LoadState = { status: "loading" } | { status: "error" } | ReadySettings;
type ActionState =
  | { type: "idle" }
  | { type: "saved" }
  | { type: "conflict" }
  | { type: "save-error" }
  | { type: "publish-error"; message?: string };

function publicSiteChromeSchema() {
  const schema = currentCmsSettingsSchemaFor(PUBLIC_SITE_CHROME_SETTINGS_ID);
  if (!schema) throw new Error("The public-site chrome schema is unavailable.");
  return schema;
}

const SCHEMA = publicSiteChromeSchema();

function canonicalValues(values: PublicSiteChromeValues): PublicSiteChromeValues {
  return {
    newsletterEnabled: values.newsletterEnabled,
    newsletterLabel: values.newsletterLabel.trim(),
    newsletterHref: values.newsletterHref.trim(),
    newsletterOpensInNewTab: values.newsletterOpensInNewTab,
  };
}

function valuesEqual(left: PublicSiteChromeValues, right: PublicSiteChromeValues) {
  return (
    left.newsletterEnabled === right.newsletterEnabled &&
    left.newsletterLabel === right.newsletterLabel &&
    left.newsletterHref === right.newsletterHref &&
    left.newsletterOpensInNewTab === right.newsletterOpensInNewTab
  );
}

function valuesFromUnknown(value: unknown): PublicSiteChromeValues {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The public-site chrome setting is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.newsletterEnabled !== "boolean" ||
    typeof record.newsletterLabel !== "string" ||
    typeof record.newsletterHref !== "string" ||
    typeof record.newsletterOpensInNewTab !== "boolean" ||
    validateCmsSettingsValues(SCHEMA, record)
  ) {
    throw new Error("The public-site chrome setting is invalid.");
  }
  const values = canonicalValues({
    newsletterEnabled: record.newsletterEnabled,
    newsletterLabel: record.newsletterLabel,
    newsletterHref: record.newsletterHref,
    newsletterOpensInNewTab: record.newsletterOpensInNewTab,
  });
  if (validateCmsSettingsValues(SCHEMA, values)) {
    throw new Error("The public-site chrome setting is invalid.");
  }
  return values;
}

function publishedFromUnknown(
  value: unknown,
): CmsSettingsPublishedSnapshot<PublicSiteChromeValues> | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The published public-site chrome setting is invalid.");
  }
  const record = value as Record<string, unknown>;
  const publishedAt =
    typeof record.publishedAt === "string" ? new Date(record.publishedAt) : null;
  if (
    record.schemaVersion !== SCHEMA.schemaVersion ||
    !Number.isSafeInteger(record.sourceVersion) ||
    Number(record.sourceVersion) < 1 ||
    !publishedAt ||
    Number.isNaN(publishedAt.getTime()) ||
    publishedAt.toISOString() !== record.publishedAt
  ) {
    throw new Error("The published public-site chrome setting is invalid.");
  }
  return {
    schemaVersion: SCHEMA.schemaVersion,
    sourceVersion: Number(record.sourceVersion),
    publishedAt: record.publishedAt,
    values: valuesFromUnknown(record.values),
  };
}

function readyFromResponse(
  response: GetSettingsResponse<PublicSiteChromeValues>,
): ReadySettings {
  if (!response.found) {
    if (response.id !== PUBLIC_SITE_CHROME_SETTINGS_ID) {
      throw new Error("The public-site chrome setting id is invalid.");
    }
    return {
      status: "ready",
      values: DEFAULT_PUBLIC_SITE_CHROME_SETTINGS,
      version: null,
      published: null,
    };
  }
  if (
    response.id !== PUBLIC_SITE_CHROME_SETTINGS_ID ||
    response.settings.schemaVersion !== SCHEMA.schemaVersion ||
    !Number.isSafeInteger(response.settings.version) ||
    response.settings.version < 1
  ) {
    throw new Error("The public-site chrome setting document is invalid.");
  }
  const published = publishedFromUnknown(response.settings.published);
  if (published && published.sourceVersion > response.settings.version) {
    throw new Error("The published public-site chrome setting is invalid.");
  }
  return {
    status: "ready",
    values: valuesFromUnknown(response.settings.values),
    version: response.settings.version,
    published,
  };
}

function readyFromMutation(
  response: MutateSettingsResponse<PublicSiteChromeValues>,
): ReadySettings {
  return readyFromResponse({
    success: true,
    found: true,
    id: response.id,
    settings: response.settings,
  });
}

function fieldError(values: PublicSiteChromeValues): string | null {
  const error = validateCmsSettingsValues(SCHEMA, canonicalValues(values));
  if (!error) return null;
  if (error.startsWith("newsletterLabel")) {
    return "Enter a newsletter label of no more than 80 bytes.";
  }
  if (error.includes("safe link")) return "Enter a safe newsletter URL.";
  if (error.includes("starts with /")) {
    return "Enter a full web address, or a site path that starts with /.";
  }
  if (error.startsWith("newsletterHref")) {
    return "Enter a newsletter URL of no more than 2,048 bytes.";
  }
  return "The newsletter settings are invalid.";
}

// Admin runs on its own origin, so a root-relative preview link must point at the
// public site instead of an Admin route.
function publicPreviewHref(href: string): string {
  return href.startsWith("/") ? new URL(href, `${PUBLIC_SITE_ORIGIN}/`).href : href;
}

function PublishedStatus({
  published,
}: {
  published: CmsSettingsPublishedSnapshot<PublicSiteChromeValues> | null;
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

export function PublicSiteChromeSettings({
  load,
  save,
  publish,
}: PublicSiteChromeSettingsTransport) {
  const successNotice = useSuccessNotice();
  const [attempt, setAttempt] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [draft, setDraft] = useState<PublicSiteChromeValues>(
    DEFAULT_PUBLIC_SITE_CHROME_SETTINGS,
  );
  const [pending, setPending] = useState<"save" | "publish" | null>(null);
  const [actionState, setActionState] = useState<ActionState>({ type: "idle" });
  const { publication, observe, retry, retrying, refresh, needsRefresh } = useSettingsPublication(load,
    (sourceVersion) => publish({ id: PUBLIC_SITE_CHROME_SETTINGS_ID, baseVersion: sourceVersion }));

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
        setDraft(loaded.values);
        setLoadState(loaded);

      })
      .catch(() => {
        if (!cancelled) setLoadState({ status: "error" });
      });
    return () => { cancelled = true; };
  }, [attempt, load, observe]);

  function edit(update: Partial<PublicSiteChromeValues>) {
    setDraft((current) => ({ ...current, ...update }));
    setActionState((current) =>
      current.type === "conflict" ? current : { type: "idle" });
  }

  function adopt(ready: ReadySettings) {
    setDraft(ready.values);
    setLoadState(ready);
  }

  async function saveDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loadState.status !== "ready" || pending) return;
    const values = canonicalValues(draft);
    if (fieldError(values)) return;
    setPending("save");
    setActionState({ type: "idle" });
    try {
      const response = await save(loadState.version === null
        ? { id: PUBLIC_SITE_CHROME_SETTINGS_ID, values, createOnly: true }
        : { id: PUBLIC_SITE_CHROME_SETTINGS_ID, values, baseVersion: loadState.version });
      adopt(readyFromMutation(response));
      setActionState({ type: "saved" });
      successNotice.show("Public header draft saved.");
    } catch (error) {
      setActionState({ type: isConflictError(error) ? "conflict" : "save-error" });
    } finally {
      setPending(null);
    }
  }

  async function publishDraft() {
    if (loadState.status !== "ready" || pending || retrying || loadState.version === null) return;
    const values = canonicalValues(draft);
    if (fieldError(values) || !valuesEqual(values, loadState.values)) return;
    setPending("publish");
    setActionState({ type: "idle" });
    try {
      const response = await publish({ id: PUBLIC_SITE_CHROME_SETTINGS_ID,
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

  useSettingsDirty(loadState.status === "ready" && (!valuesEqual(canonicalValues(draft), loadState.values)), pending !== null || retrying);

  if (loadState.status === "loading") {
    return (
      <LoadingIndicator
        label="Loading public header settings"
        stages={["Asking the CMS for the saved header", "Checking its publication state"]}
      />
    );
  }
  if (loadState.status === "error") {
    return (
      <InlineMessage tone="error" title="Public header settings could not be loaded">
        <p>Try the request again.</p>
        <Button onClick={() => setAttempt((value) => value + 1)}>Retry</Button>
      </InlineMessage>
    );
  }

  const values = canonicalValues(draft);
  const error = fieldError(values);
  // The preview uses the public resolver, so it shows the same link and tab behavior.
  const preview = resolvePublicSiteChromeNewsletter(values);
  const dirty = !valuesEqual(values, loadState.values);
  const publishedMatchesSaved = Boolean(
    loadState.published && valuesEqual(loadState.values, loadState.published.values),
  );
  const canPublish = !error && !dirty && loadState.version !== null &&
    (!publishedMatchesSaved || !publication);

  return (
    <Panel className="admin-settings-panel settings-public-panel" aria-labelledby="public-site-chrome-heading">
      <div className="panel-heading">
        <div>
          <h2 tabIndex={-1} id="public-site-chrome-heading">Public header newsletter action</h2>
          <p>Set the shared newsletter action used in desktop and collapsed navigation.</p>
        </div>
      </div>

      <form className="admin-settings-form public-banner-settings settings-section-layout" onSubmit={saveDraft}>
        <div className="settings-section-fields settings-card">
        <EditorFrameHeader scope="panel" title="Newsletter action" />
        <label className="public-banner-toggle">
          <input
            aria-label="Show newsletter action"
            checked={draft.newsletterEnabled}
            className="editor-toggle"
            disabled={pending !== null}
            onChange={(event) => edit({ newsletterEnabled: event.target.checked })}
            type="checkbox"
          />
          <span>
            <strong>Show newsletter action</strong>
            <small>Kids pages always hide this action.</small>
          </span>
        </label>

        <div className="admin-settings-fields">
          <label htmlFor="public-newsletter-label">
            <span className="editor-field-label">Label</span>
            <TextInput
              aria-invalid={error?.includes("label") ? "true" : undefined}
              disabled={pending !== null}
              id="public-newsletter-label"
              onChange={(event) => edit({ newsletterLabel: event.target.value })}
              required
              value={draft.newsletterLabel}
            />
          </label>
          <label htmlFor="public-newsletter-href">
            <span className="editor-field-label">Destination URL</span>
            <TextInput
              aria-invalid={error && !error.includes("label") ? "true" : undefined}
              autoCapitalize="none"
              disabled={pending !== null}
              id="public-newsletter-href"
              inputMode="url"
              onChange={(event) => edit({ newsletterHref: event.target.value })}
              required
              spellCheck={false}
              value={draft.newsletterHref}
            />
          </label>
        </div>

        <label className="public-banner-toggle">
          <input
            aria-label="Open newsletter action in a new tab"
            checked={draft.newsletterOpensInNewTab}
            className="editor-toggle"
            disabled={pending !== null}
            onChange={(event) => edit({ newsletterOpensInNewTab: event.target.checked })}
            type="checkbox"
          />
          <span>
            <strong>Open in a new tab</strong>
            <small>Applies to web addresses. The public link includes an accessible new-tab notice.</small>
          </span>
        </label>

        {error ? <InlineMessage tone="error">{error}</InlineMessage> : null}

      </div>
      <SettingsInspector>
        <EditorFrameHeader scope="panel" title="Draft preview" />
        {error ? null : (
          <div className="public-banner-preview" data-enabled={String(preview.enabled)} aria-label="Proposed public header preview">
            <span>Header preview</span>
            {preview.enabled ? (
              <div className="public-banner-preview-row">
                <a
                  href={publicPreviewHref(preview.href)}
                  rel={preview.opensInNewTab ? "noopener" : undefined}
                  target={preview.opensInNewTab ? "_blank" : undefined}
                >
                  {preview.label}
                  {preview.opensInNewTab ? <span className="sr-only"> (opens in new tab)</span> : null}
                </a>
              </div>
            ) : (
              <div><strong>Hidden from the public header</strong></div>
            )}
          </div>
        )}

        <dl className="public-banner-status" aria-label="Public header status">
          <div><dt>Edit state</dt><dd>{dirty ? "Unsaved changes" : "No unsaved changes"}</dd></div>
          <div><dt>Saved draft</dt><dd>{loadState.version === null ? "Draft not saved" : `Saved draft version ${loadState.version}`}</dd></div>
          <div><dt>Published</dt><dd><PublishedStatus published={loadState.published} /></dd></div>
        </dl>

        {actionState.type === "saved" && !successNotice.available ? (
          <InlineMessage tone="success">Public header draft saved.</InlineMessage>
        ) : null}
        {actionState.type === "conflict" ? (
          <InlineMessage tone="error">
            <p>This setting changed after you opened it.</p>
            <Button type="button" onClick={() => setAttempt((value) => value + 1)}>
              Reload saved header
            </Button>
          </InlineMessage>
        ) : null}
        {actionState.type === "save-error" ? (
          <InlineMessage tone="error">The public header draft could not be saved. Try again.</InlineMessage>
        ) : null}
        {actionState.type === "publish-error" ? (
          <InlineMessage tone="error">{actionState.message ?? "The public header could not be published. Try again."}</InlineMessage>
        ) : null}
        <SettingsPublicationStatus publication={publication} retry={retry} retrying={retrying} refresh={refresh} needsRefresh={needsRefresh} disabled={pending !== null} />

      </SettingsInspector>
      <div className="settings-section-actions">
        <p className="admin-settings-save-note">
          Save draft stores these fields without changing the public site. Publish updates the public site from the saved draft.
        </p>
        <div className="admin-settings-actions">
          <AsyncActionButton
            disabled={pending !== null || Boolean(error) || !dirty}
            label="Save draft"
            pending={pending === "save"}
            pendingAnnouncement="Saving public header draft."
            pendingLabel="Saving…"
            type="submit"
            variant="secondary"
          />
          <AsyncActionButton
            disabled={pending !== null || retrying || !canPublish}
            label="Publish"
            onClick={() => void publishDraft()}
            pending={pending === "publish"}
            pendingAnnouncement="Starting public header publication."
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
