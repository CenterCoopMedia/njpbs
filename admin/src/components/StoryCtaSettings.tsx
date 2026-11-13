import {
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ContextType,
  type FormEvent,
} from "react";
import {
  STORY_CTAS_SETTINGS_ID,
  cmsSettingsSchemaFor,
  currentCmsSettingsSchemaFor,
  validateCmsSettingsValues,
} from "../../../packages/content-core/src/cms-settings";
import {
  SUPPORT_APPEAL_DEFAULTS,
  type NewsletterRecord,
  type PageBlock,
} from "../../../packages/content-core/src/content-model";
import { renderBlock } from "../../../packages/content-core/src/content-render";
import { editorFieldsForBlock } from "../../../packages/content-core/src/editor-admin";
import { newsletterCardData, type NewsletterCardData } from "../../../packages/content-core/src/newsletter-card-data";
import {
  insertStoryCtas,
  MAX_STORY_CTA_RULES,
  type StoryCtaRule,
  type StoryCtasSettingsValues,
} from "../../../packages/content-core/src/story-cta-rules";
import { projectStoryCtas } from "../../../packages/content-core/src/story-ctas";
import blockStyles from "../../../packages/content-core/src/component-blocks.css?inline";
import { useSettingsPublication } from "../hooks/useSettingsPublication";
import {
  isConflictError,
  settingsPublicationRefusalMessage,
  type GetSettingsResponse,
  type MutateSettingsResponse,
  type PublishSettingsRequest,
  type SaveSettingsRequest,
} from "../lib/functions";
import { ContentShelfSources } from "./ContentShelfPicker";
import { ComponentEditorDialog } from "./ComponentEditorDialog";
import { FieldRenderer } from "./FieldRenderer";
import { NewsletterSignupEditor } from "./NewsletterSignupEditor";
import { SettingsPublicationStatus } from "./SettingsPublicationStatus";
import {
  FittedSettingsPreview,
  SettingsPreviewSummary,
  SettingsPreviewWidthControls,
} from "./SettingsBannerPreview";
import { SettingsInspector, useSettingsDirty, useSettingsPreviewWidth, useSettingsSectionActive } from "./SettingsWorkspace";
import { ActionControl } from "./ui/ActionControl";
import { Checkbox } from "./ui/Checkbox";
import {
  AsyncActionButton,
  Button,
  InlineMessage,
  Panel,
  Select,
  TextInput,
} from "./ui/Primitives";
import { LoadingIndicator } from "./ui/LoadingIndicator";
import "./StoryCtaSettings.css";

export { STORY_CTAS_SETTINGS_ID };

export const DEFAULT_STORY_CTAS: StoryCtasSettingsValues = { rules: [] };

export interface StoryCtaSettingsTransport {
  load: () => Promise<GetSettingsResponse<StoryCtasSettingsValues>>;
  save: (request: SaveSettingsRequest<StoryCtasSettingsValues>) => Promise<MutateSettingsResponse<StoryCtasSettingsValues>>;
  publish: (request: PublishSettingsRequest) => Promise<MutateSettingsResponse<StoryCtasSettingsValues>>;
  contentSources?: ContextType<typeof ContentShelfSources>;
}

type Ready = {
  version: number | null;
  values: StoryCtasSettingsValues;
  published?: StoryCtasSettingsValues;
};

const currentSchema = currentCmsSettingsSchemaFor(STORY_CTAS_SETTINGS_ID)!;
const supportAppealFields = editorFieldsForBlock("support_appeal").filter(
  field => field.key !== "backgroundImageAssetId",
);
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function readyFromResponse(response: GetSettingsResponse<StoryCtasSettingsValues>): Ready {
  if (response.id !== STORY_CTAS_SETTINGS_ID) throw new Error("The story CTA rules could not be read.");
  if (!response.found) return { version: null, values: structuredClone(DEFAULT_STORY_CTAS) };
  const data = response.settings;
  const storedSchema = cmsSettingsSchemaFor(STORY_CTAS_SETTINGS_ID, data.schemaVersion);
  if (!storedSchema || !Number.isSafeInteger(data.version) || data.version < 1 || validateCmsSettingsValues(storedSchema, data.values)) {
    throw new Error("The saved story CTA rules are invalid.");
  }
  const projected = projectStoryCtas(data);
  if (data.published && (!projected || projected.data.sourceVersion > data.version)) {
    throw new Error("The published story CTA rules are invalid.");
  }
  return {
    version: data.version,
    values: structuredClone(data.values),
    ...(projected ? { published: { rules: structuredClone(projected.data.rules) } } : {}),
  };
}

function newRule(): StoryCtaRule {
  return {
    id: `cta-${crypto.randomUUID()}`,
    label: "New support appeal",
    enabled: true,
    target: { contentTypes: ["post"] },
    position: { kind: "end" },
    content: { type: "support_appeal", data: structuredClone(SUPPORT_APPEAL_DEFAULTS) },
  };
}

function paragraph(text: string) {
  return { type: "paragraph" as const, content: [{ type: "text" as const, text }] };
}

const SAMPLE_STORY_BLOCKS: readonly PageBlock[] = [
  {
    id: "sample-opening",
    type: "prose",
    visible: true,
    order: 0,
    data: { content: { type: "doc", content: [
      paragraph("The first paragraph introduces the sample story."),
      paragraph("The second paragraph adds reporting context."),
    ] } },
  },
  { id: "sample-divider", type: "divider", visible: true, order: 1, data: {} },
  {
    id: "sample-closing",
    type: "prose",
    visible: true,
    order: 2,
    data: { content: { type: "doc", content: [
      paragraph("The third paragraph follows a divider, which does not count as a paragraph."),
      paragraph("The fourth paragraph closes the sample story."),
    ] } },
  },
];

const previewStyles = `${blockStyles}
html { color-scheme: light; background: var(--color-surface-page); }
body { background: var(--color-surface-page); color: var(--color-text-on-surface); }
.story-cta-sample { box-sizing: border-box; width: 100%; max-width: 64rem; margin-inline: auto; padding: clamp(1rem, 4vw, 3rem); }
.story-cta-sample__header { margin-block-end: 2rem; }
.story-cta-sample__header h1 { margin: 0 0 .5rem; font-size: clamp(1.75rem, 4vw, 3rem); }
.story-cta-sample__header p { margin: 0; color: var(--color-text-muted); }
.story-cta-sample__body { display: grid; gap: clamp(1.25rem, 3vw, 2.4rem); --post-prose-width: 100%; }
.story-cta-sample__body > .cms-block { min-width: 0; line-height: 1.7; }
.story-cta-sample__body > .cms-block > :first-child { margin-block-start: 0; }
.story-cta-sample__body > .cms-block > :last-child { margin-block-end: 0; }
.story-cta-sample__body hr { width: 100%; border: 0; border-top: 1px solid var(--color-border); }
`;

type NewsletterResolution =
  | { id: string; status: "ready"; title: string; projection: "approved" | "draft"; card: NewsletterCardData }
  | { id: string; status: "unavailable" | "error"; title: string; message: string };

function selectedNewsletterIds(rules: readonly StoryCtaRule[]): string[] {
  return [...new Set(rules.flatMap(rule => rule.enabled && rule.content.type === "newsletter_signup"
    ? rule.content.data.newsletterIds
    : []))];
}

function SampleStoryPreview({ rules }: { rules: readonly StoryCtaRule[] }) {
  const sources = useContext(ContentShelfSources);
  const [mode, setMode] = useSettingsPreviewWidth();
  const active = useSettingsSectionActive();
  const [open, setOpen] = useState(false);
  const ids = useMemo(() => selectedNewsletterIds(rules), [rules]);
  const idsKey = ids.join("\u0000");
  const [loading, setLoading] = useState(false);
  const [resolutions, setResolutions] = useState<NewsletterResolution[]>([]);

  useEffect(() => { if (!active) setOpen(false); }, [active]);

  useEffect(() => {
    if (!ids.length) {
      setLoading(false);
      setResolutions([]);
      return;
    }
    if (!sources.loadRecord) {
      setLoading(false);
      setResolutions(ids.map(id => ({
        id,
        status: "error",
        title: `Newsletter ${id}`,
        message: "Newsletter records are unavailable in this preview.",
      })));
      return;
    }
    let current = true;
    setLoading(true);
    void Promise.all(ids.map(async (id): Promise<NewsletterResolution> => {
      try {
        const loaded = await sources.loadRecord!("newsletter", id);
        if (loaded.status !== "ready") return {
          id,
          status: "unavailable",
          title: `Newsletter ${id}`,
          message: "This newsletter is unavailable and will not appear in the sample story.",
        };
        const record = loaded.record;
        const title = typeof record.title === "string" && record.title.trim() ? record.title.trim() : `Newsletter ${id}`;
        if (record.type !== "newsletter" || record.deleted === true || record.status === "archived") return {
          id,
          status: "unavailable",
          title,
          message: "This newsletter is not available for a public CTA.",
        };
        const card = newsletterCardData(record as unknown as NewsletterRecord);
        if (!card) return {
          id,
          status: "unavailable",
          title,
          message: "This newsletter needs a title and a secure signup link before it can appear.",
        };
        return {
          id,
          status: "ready",
          title,
          projection: record.status === "approved" ? "approved" : "draft",
          card,
        };
      } catch {
        return {
          id,
          status: "error",
          title: `Newsletter ${id}`,
          message: "This newsletter could not be loaded for the preview.",
        };
      }
    })).then(next => {
      if (!current) return;
      setResolutions(next);
      setLoading(false);
    });
    return () => { current = false; };
  }, [idsKey, sources.loadRecord]);

  const cards = useMemo(() => new Map(resolutions.flatMap(item => item.status === "ready"
    ? [[item.id, item.card] as const]
    : [])), [resolutions]);
  const html = useMemo(() => {
    const body = insertStoryCtas(SAMPLE_STORY_BLOCKS, rules).map(block => {
      const rendered = renderBlock(block, { resolveNewsletter: id => cards.get(id) ?? null });
      return rendered
        ? `<div class="cms-block cms-block--${block.type}" data-sample-block-id="${block.id}" data-sample-block-type="${block.type}">${rendered}</div>`
        : "";
    }).join("");
    return `<article class="story-cta-sample"><header class="story-cta-sample__header"><h1>Sample New Jersey story</h1><p>Four body paragraphs with a divider between the second and third paragraphs.</p></header><div class="story-cta-sample__body">${body}</div></article>`;
  }, [cards, rules]);

  return <>
    <SettingsPreviewWidthControls mode={mode} onChange={setMode} />
    {loading ? <LoadingIndicator label="Loading newsletters for the sample story" /> : null}
    {resolutions.length ? <div className="story-cta-settings__preview-status" aria-label="Newsletter preview sources">
      {resolutions.map(item => item.status === "ready"
        ? <p key={item.id} role="status"><strong>{item.title}:</strong> {item.projection === "approved"
          ? "Approved projection shown."
          : "Draft projection shown. Public stories use an approved newsletter card."}</p>
        : <p key={item.id} role={item.status === "error" ? "alert" : "status"}><strong>{item.title}:</strong> {item.message}</p>)}
    </div> : null}
    <FittedSettingsPreview
      html={html}
      mode={mode}
      styles={previewStyles}
      title={`Story CTA ${mode} sample preview`}
    />
    <SettingsPreviewSummary html={html} textOnly />
    <Button aria-haspopup="dialog" onClick={() => setOpen(true)}>Open full-size sample</Button>
    {open ? <ComponentEditorDialog open={active} onClose={() => setOpen(false)} title="Full-size sample story preview"
      description="Review the automatic story calls to action at the selected public width." className="settings-banner-dialog"
      footerNote={null} closeLabel="Close preview" closeActionLabel="Close full-size sample preview">
      <SettingsPreviewWidthControls mode={mode} onChange={setMode} />
      <FittedSettingsPreview html={html} mode={mode} styles={previewStyles} title={`Story CTA ${mode} full-size sample preview`} />
      <SettingsPreviewSummary html={html} textOnly />
    </ComponentEditorDialog> : null}
    <p className="editor-field-help">The divider in this sample does not count toward an after-paragraph position. Optional newsletter images are omitted from this preview.</p>
  </>;
}

function StoryCtaSettingsEditor({ load, save, publish }: Omit<StoryCtaSettingsTransport, "contentSources">) {
  const [ready, setReady] = useState<Ready>();
  const [draft, setDraft] = useState<StoryCtasSettingsValues>(DEFAULT_STORY_CTAS);
  const [selectedId, setSelectedId] = useState<string>();
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState<"save" | "publish" | null>(null);
  const [message, setMessage] = useState<string>();
  const [messageTone, setMessageTone] = useState<"success" | "error">("success");
  const [conflict, setConflict] = useState(false);
  const prefix = useId();
  const ruleEditor = useRef<HTMLFieldSetElement>(null);
  const ruleButtons = useRef(new Map<string, HTMLButtonElement>());
  const addRuleButton = useRef<HTMLButtonElement>(null);
  const focusTarget = useRef<"name" | "content" | "selection" | "add" | null>(null);
  const { publication, observe, retry, retrying, refresh, needsRefresh } = useSettingsPublication(
    load,
    sourceVersion => publish({ id: STORY_CTAS_SETTINGS_ID, baseVersion: sourceVersion }),
  );

  useEffect(() => {
    let current = true;
    setLoadError(false);
    setReady(undefined);
    void load().then(response => {
      const next = readyFromResponse(response);
      if (!current) return;
      setReady(next);
      setDraft(next.values);
      setSelectedId(next.values.rules[0]?.id);
      setConflict(false);
      setMessage(undefined);
      observe(response.found ? response.publication : undefined);
    }).catch(() => { if (current) setLoadError(true); });
    return () => { current = false; };
  }, [attempt, load, observe]);

  const selected = draft.rules.find(rule => rule.id === selectedId);
  useEffect(() => {
    if (!focusTarget.current) return;
    const target = focusTarget.current;
    focusTarget.current = null;
    if (target === "add") addRuleButton.current?.focus();
    else if (target === "selection" && selected) ruleButtons.current.get(selected.id)?.focus();
    else if (target === "name") document.getElementById(`${prefix}-name`)?.focus();
    else ruleEditor.current?.querySelector<HTMLElement>(".story-cta-settings__content input, .story-cta-settings__content textarea, .story-cta-settings__content select, .story-cta-settings__content button")?.focus();
  }, [prefix, selected?.content.type, selected?.id, draft.rules.length]);

  const validationError = validateCmsSettingsValues(currentSchema, draft);
  const dirty = Boolean(ready && !same(draft, ready.values));
  useSettingsDirty(dirty, pending !== null || retrying);

  function replaceRules(rules: readonly StoryCtaRule[]) {
    setDraft({ rules });
    setMessage(undefined);
  }

  function edit(patch: Partial<StoryCtaRule>) {
    replaceRules(draft.rules.map(rule => rule.id === selectedId ? { ...rule, ...patch } : rule));
  }

  function editContent(data: Record<string, unknown>) {
    if (!selected) return;
    edit({ content: { type: selected.content.type, data } as StoryCtaRule["content"] });
  }

  function add() {
    const rule = newRule();
    replaceRules([...draft.rules, rule]);
    focusTarget.current = "name";
    setSelectedId(rule.id);
  }

  function remove(index: number) {
    const remaining = draft.rules.filter((_, at) => at !== index);
    const next = remaining[index] ?? remaining[index - 1];
    replaceRules(remaining);
    focusTarget.current = next ? "selection" : "add";
    setSelectedId(next?.id);
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= draft.rules.length) return;
    const rules = [...draft.rules];
    [rules[index], rules[target]] = [rules[target]!, rules[index]!];
    replaceRules(rules);
  }

  function chooseContent(type: StoryCtaRule["content"]["type"]) {
    if (!selected || type === selected.content.type) return;
    focusTarget.current = "content";
    edit({ content: type === "support_appeal"
      ? { type, data: structuredClone(SUPPORT_APPEAL_DEFAULTS) }
      : { type, data: { newsletterIds: [], heading: "", intro: "" } } });
  }

  async function saveDraft(event: FormEvent) {
    event.preventDefault();
    if (!ready || pending || validationError || conflict) return;
    setPending("save");
    setMessage(undefined);
    try {
      const response = await save({
        id: STORY_CTAS_SETTINGS_ID,
        values: draft,
        ...(ready.version === null ? { createOnly: true as const } : { baseVersion: ready.version }),
      });
      const next = readyFromResponse({ ...response, found: true });
      setReady(next);
      setDraft(next.values);
      setMessageTone("success");
      setMessage("Story CTA draft saved.");
    } catch (cause) {
      setMessageTone("error");
      setConflict(isConflictError(cause));
      setMessage(cause instanceof Error ? cause.message : "Story CTA rules could not be saved. Your draft is still here.");
    } finally {
      setPending(null);
    }
  }

  async function publishSaved() {
    if (!ready?.version || pending || dirty || validationError || conflict) return;
    setPending("publish");
    setMessage(undefined);
    try {
      const response = await publish({ id: STORY_CTAS_SETTINGS_ID, baseVersion: ready.version });
      const next = readyFromResponse({ ...response, found: true });
      if (!response.publication || !next.published) throw new Error("The settings publication receipt is missing.");
      setReady(next);
      setDraft(next.values);
      observe(response.publication);
    } catch (cause) {
      setMessageTone("error");
      setConflict(isConflictError(cause) && !settingsPublicationRefusalMessage(cause));
      setMessage(settingsPublicationRefusalMessage(cause) ?? (cause instanceof Error
        ? cause.message
        : "Story CTA rules could not be published. Your draft is still here."));
    } finally {
      setPending(null);
    }
  }

  if (loadError) return <InlineMessage tone="error" title="Story CTA rules could not be loaded"><Button onClick={() => setAttempt(value => value + 1)}>Reload story CTA rules</Button></InlineMessage>;
  if (!ready) return <LoadingIndicator label="Loading story CTA rules" />;

  return <Panel className="admin-settings-panel settings-public-panel story-cta-settings" aria-labelledby="story-cta-settings-heading">
    <div className="panel-heading"><div><h2 id="story-cta-settings-heading">Story CTAs</h2>
      <p>Create reusable support and newsletter calls to action for story pages. Save a private draft, preview it, then publish it.</p></div></div>
    <form className="admin-settings-form settings-section-layout" onSubmit={saveDraft}>
      <div className="settings-section-fields">
        <div className="story-cta-settings__layout">
          <div className="story-cta-settings__rules">
            <div className="story-cta-settings__list-heading"><h3>Rules</h3>
              <ActionControl ref={addRuleButton} action="add-item" accessibleName="Add story CTA rule" disabled={pending !== null || draft.rules.length >= MAX_STORY_CTA_RULES} onClick={add} /></div>
            {draft.rules.length ? <ol className="story-cta-settings__list">{draft.rules.map((rule, index) => <li key={rule.id}>
              <Button
                aria-pressed={rule.id === selectedId}
                onClick={() => setSelectedId(rule.id)}
                ref={node => { if (node) ruleButtons.current.set(rule.id, node); else ruleButtons.current.delete(rule.id); }}
              ><span>{rule.label || "Untitled rule"}</span><small>{rule.enabled ? "Enabled" : "Disabled"}</small></Button>
              <div className="story-cta-settings__rule-actions" aria-label={`Arrange ${rule.label || "untitled rule"}`}>
                <ActionControl action="move-up" accessibleName={`Move up, ${rule.label || "untitled rule"}`} disabled={pending !== null || index === 0} onClick={() => move(index, -1)} />
                <ActionControl action="move-down" accessibleName={`Move down, ${rule.label || "untitled rule"}`} disabled={pending !== null || index === draft.rules.length - 1} onClick={() => move(index, 1)} />
                <ActionControl action="remove-item" accessibleName={`Remove ${rule.label || "untitled rule"}`} disabled={pending !== null} onClick={() => remove(index)} />
              </div>
            </li>)}</ol> : <p>No story CTA rules yet. Add a rule to begin.</p>}
            <p className="muted">{draft.rules.length} of {MAX_STORY_CTA_RULES} rules</p>
          </div>

          {selected ? <fieldset className="story-cta-settings__fields" disabled={pending !== null} ref={ruleEditor}>
            <legend>Edit rule</legend>
            <label className="editor-field">Rule name
              <TextInput id={`${prefix}-name`} required maxLength={100} value={selected.label} onChange={event => edit({ label: event.target.value })} />
            </label>
            <Checkbox label="Enabled on stories" checked={selected.enabled} onChange={event => edit({ enabled: event.target.checked })} />
            <div className="story-cta-settings__fixed-target"><strong>Applies to</strong><span>Stories (posts)</span></div>
            <label className="editor-field">Position
              <Select value={selected.position.kind} onChange={event => {
                const kind = event.target.value as StoryCtaRule["position"]["kind"];
                edit({ position: kind === "after-paragraph" ? { kind, count: 2 } : { kind } });
              }}>
                <option value="start">Start of story</option>
                <option value="end">End of story</option>
                <option value="after-paragraph">After paragraph</option>
              </Select>
            </label>
            {selected.position.kind === "after-paragraph" ? <div className="editor-field">
              <label htmlFor={`${prefix}-paragraph-count`}>Paragraph number</label>
              <TextInput id={`${prefix}-paragraph-count`} type="number" inputMode="numeric" min={1} max={10_000}
                aria-describedby={`${prefix}-paragraph-help`}
                value={Number.isFinite(selected.position.count) ? selected.position.count : ""}
                onChange={event => edit({ position: { kind: "after-paragraph", count: event.target.value === "" ? Number.NaN : Number(event.target.value) } })} />
              <span className="editor-field-help" id={`${prefix}-paragraph-help`}>Only visible body paragraphs count. If the story has fewer paragraphs, this CTA is omitted.</span>
            </div> : null}
            <label className="editor-field">CTA type
              <Select value={selected.content.type} onChange={event => chooseContent(event.target.value as StoryCtaRule["content"]["type"])}>
                <option value="support_appeal">Support appeal</option>
                <option value="newsletter_signup">Newsletter signup</option>
              </Select>
            </label>
            <div className="story-cta-settings__content" aria-label="CTA content">
              {selected.content.type === "support_appeal" ? supportAppealFields.map(field => <FieldRenderer
                key={field.key}
                field={field}
                fieldId={`${prefix}-support-${field.key}`}
                value={(selected.content.data as unknown as Record<string, unknown>)[field.key]}
                onChange={value => editContent({ ...(selected.content.data as unknown as Record<string, unknown>), [field.key]: value })}
              />) : <NewsletterSignupEditor
                data={selected.content.data as unknown as Record<string, unknown>}
                onChange={editContent}
              />}
            </div>
          </fieldset> : null}
        </div>
        {validationError ? <InlineMessage tone="error" title="Complete this rule before saving">{validationError}</InlineMessage> : null}
        {message ? <InlineMessage tone={conflict ? "warning" : messageTone}>{message}</InlineMessage> : null}
        {conflict ? <div><p>Your local changes are still here. Reloading replaces them with the saved rules.</p><Button onClick={() => setAttempt(value => value + 1)}>Reload saved story CTA rules</Button></div> : null}
      </div>

      <SettingsInspector label="Story CTA sample preview and publication">
        <h3>Sample story preview</h3>
        <SampleStoryPreview rules={draft.rules} />
        <SettingsPublicationStatus publication={publication} retry={retry} retrying={retrying} refresh={refresh} needsRefresh={needsRefresh} disabled={pending !== null} />
      </SettingsInspector>

      <div className="settings-section-actions">
        <p className="admin-settings-save-note">Save draft keeps changes private. Publish updates automatic CTAs on story pages through the existing fast settings publication.</p>
        <div className="admin-settings-actions">
          <AsyncActionButton type="submit" label="Save draft" pendingLabel="Saving draft…" pending={pending === "save"}
            disabled={pending !== null || Boolean(validationError) || conflict || (!dirty && ready.version !== null)} />
          <AsyncActionButton label="Publish" pendingLabel="Publishing…" pending={pending === "publish"}
            disabled={pending !== null || dirty || Boolean(validationError) || conflict || ready.version === null || same(ready.values, ready.published)}
            onClick={publishSaved} />
        </div>
      </div>
    </form>
  </Panel>;
}

export function StoryCtaSettings({ contentSources = {}, ...transport }: StoryCtaSettingsTransport) {
  return <ContentShelfSources.Provider value={contentSources}>
    <StoryCtaSettingsEditor {...transport} />
  </ContentShelfSources.Provider>;
}
