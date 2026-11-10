/** Opt-in local evidence entry; excluded from the production index entry. No live API. */
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import { PostTemplatesPage, type PostTemplatesApi } from "../routes/PostTemplatesRoute";
import { EditorWorkspace, type LoadedRecord } from "../components/EditorWorkspace";
import { RecordForm } from "../components/RecordForm";
import { PostLeadMediaInspector } from "../components/PostLeadMediaInspector";
import { PostLeadMediaEditor } from "../components/PostLeadMediaEditor";
import { ShellProvider } from "../routes/ShellContext";
import type { ListMediaResponse, MediaAssetSummary } from "../lib/functions";
import type { Principal } from "../../../packages/content-core/src/rbac";
import "../styles.css";
import "../content-scan-flow.css";
import "../cms-workspace.css";

const params = new URLSearchParams(location.search);
const kind = params.get("kind") ?? "image";
const principal: Principal = { id: "fixture-editor", grants: [{ role: "super_admin" }] };
const image: MediaAssetSummary = {
  id: "lead-image", name: "New Jersey boardwalk", originalName: "boardwalk.webp", category: "newsroom", categories: ["newsroom"], tags: [],
  description: null, altText: "The New Jersey boardwalk", license: "owned", credit: "NJ PBS", mimeType: "image/webp", kind: "image", sizeBytes: 1000,
  width: 1600, height: 900, url: "/guide/landscape.webp", lifecycle: "active", version: 1, etag: '"fixture:1"',
  createdAt: null, createdBy: null, updatedAt: null, updatedBy: null,
};
const record = {
  id: "lead-story", type: "post", version: 1, title: "The New Jersey boardwalk", summary: "A local fixture of the real Post workspace.",
  date: "2026-10-15", tags: [], slug: "boardwalk", status: "draft", blocks: [],
  heroImage: image.id, heroImageAlt: image.altText,
  leadMedia: kind === "empty" ? null : kind === "image" ? { kind, data: { assetId: image.id, alt: image.altText, caption: "Photo: NJ PBS" } }
    : kind === "library-video" ? { kind, data: { sourceId: "video-library", assetId: "lead-video", title: "The New Jersey boardwalk", caption: "A library video selected for this story." } }
    : kind === "invalid" ? { kind: "unsupported" }
    : { kind, data: { url: "https://youtu.be/abcdefghijk", title: "The New Jersey boardwalk", caption: "An external video selected for this story." } },
  ...(params.has("decorative") ? { heroImageDecorative: true, heroImageAlt: params.has("whitespace") ? " " : image.altText, leadMedia: undefined } : {}),
  ...(kind === "absent" ? { heroImage: undefined, heroImageAlt: undefined, leadMedia: undefined } : {}),
  ...(kind === "legacy-empty" ? { heroImage: "", heroImageAlt: "", leadMedia: undefined } : {}),
  ...(params.has("pbs-duplicate") ? {
    leadMedia: { kind: "embed", data: { url: "https://player.pbs.org/partnerplayer/123456789/?muted=true", title: "PBS lead video" } },
    blocks: [{ id: "pbs-body", type: "embed", order: 0, visible: true,
      data: { url: "https://player.pbs.org/partnerplayer/123456789/?end=90&topbar=false&endscreen=false", caption: "PBS body playback options" } }],
  } : {}),
};
const loadRecord = async (): Promise<LoadedRecord> => ({ status: "ready", record });
const loadMedia = async (): Promise<ListMediaResponse> => ({ success: true, records: [image], total: 1, allCount: 1, page: 1, pageCount: 1, categoryCounts: { newsroom: 1 }, kindCounts: { image: 1, document: 0 } });
function InspectorSpecimen() {
  const [draft, setDraft] = useState<Record<string, unknown>>(record);
  return <div className="content-studio" style={{ maxWidth: 304 }}><ShellProvider value={{ principal,
    user: { uid: "fixture-editor", email: null }, userDoc: null, signOut() {}, getIdToken: async () => "local-evidence-only" }}>
    <PostLeadMediaInspector record={draft} loadMedia={loadMedia} onRemove={() => setDraft({ ...draft, leadMedia: null })}>
      {imagePicker => <PostLeadMediaEditor record={draft} fieldId="inspector-lead" loadMedia={loadMedia} imagePicker={imagePicker}
        onChange={leadMedia => setDraft({ ...draft, leadMedia })} />}
    </PostLeadMediaInspector>
  </ShellProvider></div>;
}
const workspace = <EditorWorkspace principal={principal}
  surface={{ kind: "record", record: "post", id: "lead-story" }} loadRecord={loadRecord} loadMedia={loadMedia}
  onDirtyChange={dirty => { document.documentElement.dataset.leadDirty = String(dirty); }}
  saveRecord={async (_kind, _id, document) => ({ ...document, id: "lead-story", version: 2 })} />;
// The runner intercepts all network requests. This dummy identity only exposes the
// existing read-only Preview video control for the locked standalone-form check.
const standalone = <div className="content-studio"><ShellProvider value={{ principal, user: { uid: "fixture-editor", email: null }, userDoc: null,
  signOut() {}, getIdToken: async () => "local-evidence-only" }}><RecordForm kind="post" initial={record} loadMedia={loadMedia}
  readOnly={!params.has("editable")} canSave={params.has("editable")} onSave={() => {}} /></ShellProvider></div>;
const template = { id: "fixture-template", name: "Boardwalk story", description: "A captured story template", version: 1, mode: params.get("mode") === "layout" ? "layout" as const : "content" as const,
  retired: false, sourceId: record.id, sourceVersion: 1, section: null, counts: {}, canManage: !params.has("locked") };
const templateApi: PostTemplatesApi = {
  list: async () => ({ success: true, templates: [template] }),
  get: async () => ({ success: true, template, document: record, mediaWarning: null }),
  change: async () => ({ success: true, template, removed: false, replayed: false }),
  create: async () => ({ success: true, collection: "cmsPosts", id: "fixture-post", created: true, mintedIds: {}, document: record }),
};
const templatePage = <ShellProvider value={{ principal, user: { uid: "fixture-editor", email: null }, userDoc: null,
  signOut() {}, getIdToken: async () => "local-evidence-only" }}><RouterProvider router={createMemoryRouter([
  { path: "/post-templates/:templateId", element: <PostTemplatesPage api={templateApi} media={{ loadMedia }} /> },
], { initialEntries: ["/post-templates/fixture-template"] })} /></ShellProvider>;
createRoot(document.getElementById("lead-media-root")!).render(params.has("inspector") ? <InspectorSpecimen /> : params.has("template") ? <div className="content-studio">{templatePage}</div> : <MemoryRouter>{params.has("standalone") ? standalone : workspace}</MemoryRouter>);
