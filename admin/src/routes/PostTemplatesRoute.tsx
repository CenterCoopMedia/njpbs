import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useBeforeUnload, useBlocker, useNavigate, useParams, useSearchParams } from "react-router";
import { can } from "../../../packages/content-core/src/rbac";
import { BLOCK_LABELS, editorFieldGroupsFor } from "../../../packages/content-core/src/editor-admin";
import { parseBlocks, type BlockType } from "../../../packages/content-core/src/content-model";
import { POST_PRESENTATIONS, resolvePostPresentation, tagsWithPostPresentation, type PostPresentation } from "../../../packages/content-core/src/post-formats";
import { useAuth } from "../context/AuthContext";
import { canUploadMedia, canUseContentStudio, canUseMediaLibrary } from "../lib/access";
import { createRecordPath, editRecordPath, postTemplatesPath, recordListPath } from "../lib/routes";
import { recordsEqual } from "../lib/record-equality";
import { useMediaCategories } from "../lib/use-media-categories";
import { defaultMediaUploadCategory, uploadMediaReusingDuplicates } from "../lib/media-upload";
import {
  HttpError, cmsChangePostTemplate, cmsGetPostTemplate, cmsListPostTemplates, cmsSaveContent,
  cmsListMedia, cmsListContent, cmsGetContent, cmsListPages,
  type PostTemplateContent, type PostTemplateSummary, type MediaListQuery, type UploadMediaMetadata,
} from "../lib/functions";
import { encodeContentQuery, type ContentQuery } from "../lib/content-query";
import type { AdminBlock } from "../lib/block-factory";
import type { LoadedRecord } from "../components/EditorWorkspace";
import { BlockEditor, type BlockEditorHandle } from "../components/BlockEditor";
import { ContentShelfSources } from "../components/ContentShelfPicker";
import { FieldRenderer } from "../components/FieldRenderer";
import { PostLeadMediaEditor } from "../components/PostLeadMediaEditor";
import { PostLeadMediaReview } from "../components/PostLeadMediaReview";
import { recommendedFieldWarning } from "../lib/field-validation";
import type { MediaPickerLoader } from "../components/MediaPickerDialog";
import type { MediaUploader } from "../components/MediaUploadForm";
import { LoadingIndicator } from "../components/ui/LoadingIndicator";
import { AsyncActionButton, Button, EmptyState, InlineMessage, Panel, Select, StatusBadge, TextInput, Textarea, Toolbar } from "../components/ui/Primitives";
import { LeaveGuardDialog } from "./LeaveGuardDialog";
import { useRegisterExitGuard } from "./ExitGuard";
import { RequireCapability } from "./RequireCapability";
import { useOptionalShell, useShell } from "./ShellContext";
import "../components/PostTemplates.css";

export interface PostTemplatesApi {
  list: (cursor?: string) => ReturnType<typeof cmsListPostTemplates>;
  get: (id: string) => ReturnType<typeof cmsGetPostTemplate>;
  change: (body: Parameters<typeof cmsChangePostTemplate>[1]) => ReturnType<typeof cmsChangePostTemplate>;
  create: (template: PostTemplateSummary, key: string) => ReturnType<typeof cmsSaveContent>;
}

async function listAllTemplates(api: PostTemplatesApi) {
  const templates: PostTemplateSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.list(cursor);
    templates.push(...page.templates);
    cursor = page.nextCursor;
  } while (cursor);
  return { success: true as const, templates: templates.sort((a, b) => a.name.localeCompare(b.name)) };
}

type TemplateValues = { name: string; description: string; document: Record<string, unknown> };
type Decision = { template: PostTemplateSummary; action: "retire" | "restore" | "remove" };
const HERO_FIELDS = editorFieldGroupsFor("post").flatMap(group => group.fields).filter(field =>
  ["heroImage", "heroImageAlt", "heroImageDecorative", "heroImageCaption", "heroBackgroundImage", "heroBackgroundPosition"].includes(field.key));

function structureSummary(template: PostTemplateSummary) {
  return Object.entries(template.counts).map(([type, count]) =>
    `${count} ${BLOCK_LABELS[type as BlockType] ?? "block"}${count === 1 || type === "cta_row" || type === "topic_shelf" ? "" : "s"}`).join(" · ") || "Empty layout";
}

function isTemplateConflict(error: unknown): boolean {
  return error instanceof HttpError && error.status === 409 && error.data.code === "post_template_conflict";
}

function DecisionDialog({ decision, pending, error, confirm, close, reload, returnFocusId }: {
  decision: Decision; pending: boolean; error: string | null; confirm: () => void; close: () => void; reload?: () => void; returnFocusId: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const verb = decision.action === "remove" ? "Remove" : decision.action === "retire" ? "Retire" : "Restore";
  useEffect(() => {
    const element = dialog.current;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();
    return () => {
      element?.close();
      if (trigger?.isConnected) trigger.focus();
      else document.getElementById(returnFocusId)?.focus();
    };
  }, [returnFocusId]);
  return <dialog ref={dialog} className="post-template-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!pending) close(); }}>
    <h2 id={titleId}>{verb} “{decision.template.name}”?</h2>
    <p>{decision.action === "remove" ? "Remove this preset from the library. Existing Posts and media files will stay in place."
      : decision.action === "retire" ? "Keep this preset in the library, but stop using it for new Posts. You can restore it later."
      : "Make this preset available for new Posts again."}</p>
    {error ? <InlineMessage tone="error" role="alert" title="Change was not confirmed">{error}</InlineMessage> : null}
    <Toolbar>
      <Button disabled={pending} onClick={close}>Cancel</Button>
      {reload ? <Button disabled={pending} onClick={reload}>Reload templates</Button> : <AsyncActionButton variant={decision.action === "remove" ? "danger" : "primary"} label={`${verb} template`} pending={pending} pendingLabel="Saving change…" onClick={confirm} />}
    </Toolbar>
  </dialog>;
}

export function PostTemplatesPage({ api, canCreate = true, media = {} }: {
  api: PostTemplatesApi;
  canCreate?: boolean;
  media?: {
    mediaPickerUnavailable?: boolean;
    loadMedia?: MediaPickerLoader;
    uploadMedia?: MediaUploader;
    mediaCategories?: Parameters<typeof FieldRenderer>[0]["mediaCategories"];
    defaultUploadCategory?: string;
    canUploadCategory?: (category: string) => boolean;
  };
}) {
  const principal = useOptionalShell()?.principal;
  const { templateId } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [templates, setTemplates] = useState<PostTemplateSummary[]>([]);
  const [loaded, setLoaded] = useState<PostTemplateContent | null>(null);
  const [values, setValues] = useState<TemplateValues | null>(null);
  const baseline = useRef<TemplateValues | null>(null);
  const valuesRef = useRef(values);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const [mediaDirty, setMediaDirty] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [decisionConflict, setDecisionConflict] = useState(false);
  const editor = useRef<BlockEditorHandle>(null);
  const requests = useRef(new Map<string, string>());
  const formId = useId();
  const nameId = useId();
  const searchId = useId();
  const dirty = mediaDirty || (values !== null && !recordsEqual(values, baseline.current ?? {}));
  const dirtyRef = useRef(dirty);
  const blockedForSave = useRef(false);
  dirtyRef.current = dirty;
  valuesRef.current = values;

  function setBusy(value: string | null) { pendingRef.current = value !== null; setPending(value); }
  function requestKey(operation: string, body: unknown) {
    const fingerprint = `${operation}:${JSON.stringify(body)}`;
    if (!requests.current.has(fingerprint)) requests.current.set(fingerprint, crypto.randomUUID());
    return requests.current.get(fingerprint)!;
  }
  function changeValues(next: TemplateValues) {
    valuesRef.current = next;
    dirtyRef.current = !recordsEqual(next, baseline.current ?? {});
    setValues(next);
    setNotice(null);
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null); setLoaded(null); setValues(null); baseline.current = null;
    const load = templateId ? api.get(templateId) : listAllTemplates(api);
    load.then(result => {
      if (cancelled) return;
      if ("document" in result) {
        const parsed = parseBlocks(result.document.blocks, { complete: false });
        if (!parsed.ok) throw new Error(`This template needs repair: ${parsed.error}`);
        const initial = { name: result.template.name, description: result.template.description, document: result.document };
        baseline.current = initial; valuesRef.current = initial;
        setLoaded(result); setValues(initial);
      } else setTemplates(result.templates);
    }).catch(error => { if (!cancelled) setError(error instanceof Error ? error.message : "Post templates could not be loaded."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [api, templateId, attempt]);

  const saveBeforeExit = useCallback(async () => {
    if (pendingRef.current || mediaDirty || !editor.current) return { status: "failed" as const };
    return (await editor.current.save()).clean ? { status: "saved" as const } : { status: "failed" as const };
  }, [mediaDirty]);
  useRegisterExitGuard({ saving: pending !== null, hasUnsavedWork: () => dirtyRef.current, save: saveBeforeExit });
  useBeforeUnload(useCallback(event => {
    if (dirtyRef.current || pendingRef.current) { event.preventDefault(); event.returnValue = ""; }
  }, []));
  const blocker = useBlocker(() => {
    blockedForSave.current = pendingRef.current;
    return dirtyRef.current || pendingRef.current;
  });
  useEffect(() => {
    if (blocker.state !== "blocked" || pending || !blockedForSave.current) return;
    blockedForSave.current = false;
    if (!dirty) blocker.proceed();
  }, [blocker, pending, dirty]);

  async function useTemplate(template: PostTemplateSummary) {
    if (pendingRef.current || !canCreate || template.retired) return;
    const key = requestKey("create", { id: template.id, version: template.version });
    setBusy(`use:${template.id}`); setError(null);
    try {
      const result = await api.create(template, key);
      const id = result.document.id;
      if (typeof id !== "string" || !id) throw new Error("The draft save did not return its address. Retry this template to recover the result.");
      setBusy(null);
      navigate(editRecordPath("post", id));
    } catch (error) {
      setError(error instanceof Error ? error.message : "The draft was not confirmed. Retry this template to recover the same request.");
    } finally { setBusy(null); }
  }

  async function confirmDecision() {
    if (!decision || pendingRef.current) return;
    const { template, action } = decision;
    const change = { action: action === "remove" ? "remove" as const : "update" as const, id: template.id, baseVersion: template.version,
      ...(action === "remove" ? {} : { retired: action === "retire" }) };
    setBusy(`change:${template.id}`); setDecisionError(null);
    try {
      const result = await api.change({ ...change, idempotencyKey: requestKey("change", change) });
      setTemplates(current => result.removed ? current.filter(item => item.id !== template.id) : current.map(item => item.id === template.id ? result.template : item));
      setDecision(null);
      setNotice(`“${template.name}” was ${action === "remove" ? "removed" : action === "retire" ? "retired" : "restored"}.`);
    } catch (error) {
      setDecisionError(error instanceof Error ? error.message : "The template could not be changed. Reload the library before trying again.");
      setDecisionConflict(isTemplateConflict(error));
    }
    finally { setBusy(null); }
  }

  async function saveTemplate(blocks: AdminBlock[]) {
    if (!loaded?.template.canManage || !valuesRef.current || pendingRef.current) throw new Error("This template cannot be saved now.");
    const sent = { ...valuesRef.current, name: valuesRef.current.name.trim(), description: valuesRef.current.description.trim(), document: { ...valuesRef.current.document, blocks } };
    if (!sent.name) { document.getElementById(nameId)?.focus(); throw new Error("Enter a template name."); }
    if (mediaDirty) throw new Error("Finish choosing media before saving the template.");
    const change = { action: "update" as const, id: loaded.template.id, baseVersion: loaded.template.version, name: sent.name, description: sent.description,
      ...(recordsEqual(sent.document, baseline.current?.document ?? {}) ? {} : { document: sent.document }) };
    setBusy("save"); setNotice(null);
    try {
      const result = await api.change({ ...change, idempotencyKey: requestKey("save", change) });
      baseline.current = sent; valuesRef.current = sent; dirtyRef.current = false;
      setValues(sent); setLoaded({ ...loaded, template: result.template, document: sent.document, mediaWarning: null });
      setNotice("Template saved. Future Posts will use this version.");
      return { blocks, mintedIds: {} };
    } catch (error) {
      // Only stale template versions require discarding local edits. Validation
      // failures keep their message and can be corrected in the current editor.
      if (error instanceof HttpError && error.status === 409 && !isTemplateConflict(error)) throw new Error(error.message);
      throw error;
    } finally { setBusy(null); }
  }

  const query = params.get("q") ?? "";
  const showRetired = params.get("retired") === "1";
  const matching = templates.filter(template => (showRetired || !template.retired) &&
    `${template.name} ${template.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const bodyBlocks = Array.isArray(loaded?.document.blocks) ? loaded.document.blocks as AdminBlock[] : [];
  const tags = Array.isArray(values?.document.tags) ? values.document.tags as string[] : [];

  return <section className="post-templates-page" aria-labelledby="page-title">
    <header className="post-templates-heading">
      <div>
        <Link to={templateId ? postTemplatesPath() : recordListPath("post")}>{templateId ? "Back to post templates" : "Back to Posts"}</Link>
        <h1 id="page-title" tabIndex={-1}>{templateId ? "Edit post template" : "Post templates"}</h1>
        <p>{templateId ? "Changes apply to future Posts made from this preset. Existing Posts stay independent." : "Choose a reusable starting point, or create a blank Post."}</p>
      </div>
      <Toolbar>{templateId && loaded?.template.canManage ?
        <AsyncActionButton type="submit" form={formId} variant="primary" label="Save template" pending={pending === "save"} pendingLabel="Saving template…" disabled={pending !== null || mediaDirty} />
        : !templateId && canCreate ? <Link className="button button-secondary" to={createRecordPath("post")}>Blank post</Link> : null}</Toolbar>
    </header>
    {notice ? <InlineMessage tone="success" role="status">{notice}</InlineMessage> : null}
    {error ? <InlineMessage tone="error" role="alert" title="Templates are unavailable">{error}<Button disabled={pending !== null} onClick={() => setAttempt(value => value + 1)}>Reload templates</Button></InlineMessage> : null}
    {loading ? <LoadingIndicator label="Loading post templates" /> : null}
    {!loading && !templateId && (templates.length > 0 || !error) ? <>
      <div className="post-template-fields">
        <label>Search templates<TextInput id={searchId} type="search" value={query} onChange={event => { const next = new URLSearchParams(params); next.set("q", event.target.value); setParams(next, { replace: true }); }} /></label>
        <label><span><input type="checkbox" checked={showRetired} onChange={event => { const next = new URLSearchParams(params); event.target.checked ? next.set("retired", "1") : next.delete("retired"); setParams(next, { replace: true }); }} /> Show retired templates</span></label>
      </div>
      {matching.length === 0 ? <EmptyState title={templates.length ? "No templates match" : "No post templates yet"} description={templates.length ? "Change the search or show retired templates." : "Open a saved Post, then choose Post actions and Save as template."} /> : <ul className="post-template-list">
        {matching.map(template => <li className="post-template-card" key={template.id}>
          <div className="post-templates-heading"><h2>{template.name}</h2>{template.retired ? <StatusBadge tone="neutral">Retired</StatusBadge> : null}</div>
          {template.description ? <p>{template.description}</p> : null}
          <p className="muted">{structureSummary(template)}</p>
          <p className="muted">{template.mode === "layout" ? "Layout only · empty story slots" : "Layout and content · review reused story material"}</p>
          <Toolbar>
            {canCreate && !template.retired ? <AsyncActionButton variant="primary" label="Use template" aria-label={`Use template: ${template.name}`} pending={pending === `use:${template.id}`} pendingLabel="Creating draft…" disabled={pending !== null} onClick={() => void useTemplate(template)} /> : null}
            {template.canManage ? <>
              <Link className="button button-secondary" to={postTemplatesPath(template.id)}>Edit template</Link>
              <Button disabled={pending !== null} onClick={() => { setDecisionError(null); setDecisionConflict(false); setDecision({ template, action: template.retired ? "restore" : "retire" }); }}>{template.retired ? "Restore" : "Retire"}</Button>
              <Button variant="ghost" disabled={pending !== null} onClick={() => { setDecisionError(null); setDecisionConflict(false); setDecision({ template, action: "remove" }); }}>Remove</Button>
            </> : null}
          </Toolbar>
        </li>)}
      </ul>}
    </> : null}
    {!loading && loaded && values ? <form id={formId} noValidate onSubmit={event => { event.preventDefault(); if (!pendingRef.current) void editor.current?.save(); }}>
      {loaded.mediaWarning ? <InlineMessage tone="warning" title="Replace unavailable media">{loaded.mediaWarning}</InlineMessage> : null}
      <p className="muted">Template version {loaded.template.version}. Captured from Post version {loaded.template.sourceVersion}.</p>
      <Panel className="post-template-editor-fields">
        <fieldset className="post-template-fields" disabled={pending !== null || !loaded.template.canManage}>
          <label htmlFor={nameId}>Template name<TextInput id={nameId} value={values.name} maxLength={120} required onChange={event => changeValues({ ...values, name: event.target.value })} /></label>
          <label>Description <span className="muted">(optional)</span><Textarea value={values.description} rows={3} maxLength={500} onChange={event => changeValues({ ...values, description: event.target.value })} /></label>
          <label>Post presentation<Select value={resolvePostPresentation(tags)} onChange={event => changeValues({ ...values, document: { ...values.document, tags: tagsWithPostPresentation([], event.target.value as PostPresentation) } })}>
            {POST_PRESENTATIONS.map(presentation => <option key={presentation.value} value={presentation.value}>{presentation.label}</option>)}
          </Select></label>
        </fieldset>
        <details><summary>Lead media and background</summary>
          {!loaded.template.canManage ? <PostLeadMediaReview record={values.document} loadMedia={media.loadMedia} template onMediaPickerDirtyChange={setMediaDirty} /> : <PostLeadMediaEditor record={values.document} fieldId={`${formId}-lead-media`} {...media} template onMediaPickerDirtyChange={setMediaDirty}
              disabled={pending !== null || !loaded.template.canManage} onChange={leadMedia => changeValues({ ...values, document: { ...values.document, leadMedia } })} />}
            <fieldset className="post-template-fields" disabled={pending !== null || !loaded.template.canManage}>{HERO_FIELDS.filter(field => field.key.startsWith("heroBackground")).map(field => <FieldRenderer
              key={field.key} field={{ ...field, required: false }} fieldId={`${formId}-${field.key}`}
              warning={recommendedFieldWarning(field, values.document[field.key], { siblings: values.document })}
              value={values.document[field.key]} onChange={value => {
                const document = { ...values.document, [field.key]: value };
                if (field.key === "heroImage" && value !== values.document.heroImage) {
                  document.heroImageAlt = "";
                  document.heroImageDecorative = false;
                  document.heroImageCaption = "";
                }
                if (field.key === "heroImageDecorative" && value === true) document.heroImageAlt = "";
                changeValues({ ...values, document });
              }} {...media} onMediaPickerDirtyChange={setMediaDirty}
            />)}</fieldset>
        </details>
      </Panel>
      <div className="post-template-editor-canvas">
        <BlockEditor key={`${loaded.template.id}:${attempt}`} ref={editor} section="post" initialBlocks={bodyBlocks}
          canEditCustomHtml={!!principal && can(principal, "content.publish", { section: loaded.template.section ?? undefined })}
          allowIncomplete canSave={loaded.template.canManage} readOnly={pending !== null || !loaded.template.canManage} readOnlyNotice={null}
          showSaveAction={false} commandsInline commandLabel="Template layout controls" emptyDocumentKind="post"
          onSave={saveTemplate} allowConflictOverwrite={false} onReload={() => setAttempt(value => value + 1)}
          conflictCopy={{ title: "This template changed while you were editing it", message: "Your changes are still here. Reload the latest template before applying your edits again.", reloadLabel: "Reload template, discarding your changes" }}
          onDraftChange={blocks => {
            if (!valuesRef.current || !baseline.current) return;
            changeValues({ ...valuesRef.current, document: { ...valuesRef.current.document, blocks: blocks ?? baseline.current.document.blocks } });
          }} {...media} onMediaPickerDirtyChange={setMediaDirty}
        />
      </div>
    </form> : null}
    {decision ? <DecisionDialog decision={decision} pending={pending !== null} error={decisionError} confirm={() => void confirmDecision()} close={() => setDecision(null)} reload={decisionConflict ? () => { setDecision(null); setAttempt(value => value + 1); } : undefined} returnFocusId={searchId} /> : null}
    {blocker.state === "blocked" && !blockedForSave.current ? <LeaveGuardDialog onCancel={() => blocker.reset()} onConfirm={() => { dirtyRef.current = false; blocker.proceed(); }} onSave={saveBeforeExit} /> : null}
  </section>;
}

export function PostTemplatesRoute() {
  const { principal } = useShell();
  const { getIdToken } = useAuth();
  const { state: categories } = useMediaCategories();
  const { templateId } = useParams();
  const api = useMemo<PostTemplatesApi>(() => ({
    list: async cursor => cmsListPostTemplates(await getIdToken(), cursor),
    get: async id => cmsGetPostTemplate(await getIdToken(), id),
    change: async body => cmsChangePostTemplate(await getIdToken(), body),
    create: async (template, idempotencyKey) => cmsSaveContent(await getIdToken(), { collection: "cmsPosts", document: { type: "post" }, postTemplate: { id: template.id, version: template.version }, idempotencyKey }),
  }), [getIdToken]);
  const loadMedia = useCallback(async (query: MediaListQuery, options?: { signal?: AbortSignal }) =>
    cmsListMedia(await getIdToken(), query, options?.signal), [getIdToken]);
  const uploadMedia = useCallback(async (file: File, metadata: UploadMediaMetadata, signal: AbortSignal) => uploadMediaReusingDuplicates(await getIdToken(), file, metadata, signal), [getIdToken]);
  const sources = useMemo(() => ({
    loadPages: async () => (await cmsListPages(await getIdToken())).pages,
    loadLibrarySelection: async (query: ContentQuery) => cmsListContent(await getIdToken(), encodeContentQuery(query)),
    loadRecord: async (_kind: string, id: string): Promise<LoadedRecord> => {
      const result = await cmsGetContent(await getIdToken(), { collection: "cmsPosts", id });
      return result.found ? { status: "ready", record: result.document } : { status: "missing" };
    },
  }), [getIdToken]);
  return <RequireCapability allowed={canUseContentStudio} notice="Your account cannot use post templates.">
    <ContentShelfSources.Provider value={sources}>
      <PostTemplatesPage key={templateId ?? "library"} api={api} canCreate={can(principal, "content.create", { ownerId: principal.id, unassignedDraft: true })}
        media={{ mediaPickerUnavailable: !canUseMediaLibrary(principal), loadMedia: canUseMediaLibrary(principal) ? loadMedia : undefined, uploadMedia: canUploadMedia(principal) ? uploadMedia : undefined,
          mediaCategories: categories.status === "ready" ? categories.categories : undefined,
          defaultUploadCategory: defaultMediaUploadCategory(principal),
          canUploadCategory: category => canUploadMedia(principal, category) }}
      />
    </ContentShelfSources.Provider>
  </RequireCapability>;
}
