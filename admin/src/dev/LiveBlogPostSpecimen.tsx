/** Local development specimen; no CMS, authentication or network writes. */
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { EditorWorkspace, type LoadedRecord } from "../components/EditorWorkspace";
import { RecordForm } from "../components/RecordForm";
import { ControlPresentationProvider } from "../context/ControlPresentationContext";
import { ShellLayout } from "../routes/ShellLayout";
import { ShellProvider, type ShellData } from "../routes/ShellContext";
import type { MediaAssetSummary } from "../lib/functions";
import type { LiveBlogDraft, LiveBlogDraftUpdate } from "../../../packages/content-core/src/live-blog-draft";
import "../styles.css";
import "../cms-workspace.css";
import "../content-scan-flow.css";

const params = new URLSearchParams(location.search);
const state = params.get("state") ?? "draft";
const principal: ShellData["principal"] = { id: "fixture-editor", grants: [{ role: "super_admin" }] };
const shell: ShellData = { principal, user: { uid: "fixture-editor", email: null, displayName: "Example editor" },
  userDoc: { role: "super_admin", grants: principal.grants, displayName: "Example editor" }, navigationShares: [], signOut() {} };
const photo: MediaAssetSummary = { id: "entry-photo", name: "Local reporting photo", originalName: "reporting.jpg", category: "news", categories: ["news"], tags: [], description: null,
  altText: "People taking part in a community meeting", license: "Synthetic local specimen", credit: "Example newsroom", mimeType: "image/jpeg", kind: "image", sizeBytes: 2000,
  width: 800, height: 600, url: "https://njpbs.org/brand/spotlight/politics-02.jpg", lifecycle: "active", version: 1, etag: "fixture", createdAt: null, createdBy: null, updatedAt: null, updatedBy: null };
const loadMedia = async () => ({ success: true as const, records: [photo], total: 1, allCount: 1, page: 1, pageCount: 1, categoryCounts: { news: 1 }, kindCounts: { image: 1, document: 0 } });
const entry = (id: string): LiveBlogDraftUpdate => ({ id, headline: state === "long" ? "A long update headline about communities across New Jersey ".repeat(4) : "Council confirms the meeting time",
  body: { type: "doc" as const, content: [{ type: "paragraph", content: [{ type: "text", text: "Synthetic coverage for local review. The meeting begins at 7 p.m." }] }] },
  credits: [{ kind: "custom" as const, name: "Example newsroom" }], keyUpdate: true,
  ...(params.get("media") === "image" ? { media: { kind: "image", data: { assetId: photo.id, alt: "People at a community meeting", caption: "Example photo credit" } } } : {}),
  ...(params.get("media") === "video" ? { media: { kind: "embed", data: { url: "https://youtu.be/dQw4w9WgXcQ", title: "Community briefing", caption: "Produced by the newsroom" }, posterAssetId: photo.id } } : {}),
});
const liveBlog: LiveBlogDraft = { schemaVersion: 1, coverageState: "ongoing", ...(params.has("branding") ? { branding: "nj-decides-2026" } : {}), updates: state === "empty" ? [] : [entry("entry-one"), entry("entry-two")] };
function Specimen() {
  const [initial] = useState<Record<string, unknown>>(() => ({ id: "post-example", type: "post", title: "Live coverage across New Jersey", summary: "Synthetic reporting for the local Post editor specimen.", blocks: [], categories: ["New Jersey"], tags: [], credits: [{ kind: "custom", name: "Example newsroom" }], status: state === "readonly" ? "in_review" : "draft", version: 3, createdBy: "fixture-editor", unassignedDraft: true,
    ...(state === "before" ? {} : { liveBlog }),
    ...(state === "published" ? { published: { metadata: { liveBlog: { ...liveBlog, updatedAt: "2026-10-25T15:00:00.000Z", updates: liveBlog.updates.map(item => ({ ...item, publishedAt: "2026-10-25T15:00:00.000Z", updatedAt: "2026-10-25T15:00:00.000Z" })) } } } } : {}),
  }));
  const [savedVersion, setSavedVersion] = useState(3);
  const save = async (record: Record<string, unknown>) => {
    if (state === "failure") throw new Error("Synthetic save failure. Your draft is still here.");
    const version = (typeof record.version === "number" ? record.version : 3) + 1;
    const saved = structuredClone(record);
    const blog = saved.liveBlog as LiveBlogDraft | undefined;
    if (blog) blog.updates = blog.updates.map((item, index) => ({ ...item, id: item.id.startsWith("tmp-") ? `entry-local-${index}` : item.id }));
    setSavedVersion(version); return { ...saved, version };
  };
  const loadRecord = async (): Promise<LoadedRecord> => ({ status: "ready", record: initial });
  return <ControlPresentationProvider value={params.get("presentation") === "text" ? "text" : "icons"}>
    <p>Local specimen. Saved revision: <output>{savedVersion}</output></p>
      {params.has("create") ? <RecordForm kind="post" initial={initial} canSave={state !== "readonly"} readOnly={state === "readonly"} allowIncomplete
        developmentLiveBlogCreation={state === "before" && params.has("create")}
        loadMedia={loadMedia} onSave={save} /> : <EditorWorkspace principal={principal}
          surface={{ kind: "record", record: "post", id: "post-example" }} loadRecord={loadRecord} loadMedia={loadMedia} saveRecord={(_kind, record) => save(record)}
          onDirtyChange={dirty => { document.documentElement.dataset.liveBlogDirty = String(dirty); }} />}
  </ControlPresentationProvider>;
}
if (import.meta.env.DEV) {
  const router = createMemoryRouter([{ path: "/", element: <ShellLayout />, children: [{
    path: "content/*", handle: { title: "Edit post" }, element: <Specimen />,
  }] }], { initialEntries: ["/content/post/post-example/edit"] });
  createRoot(document.getElementById("live-blog-root")!).render(<ShellProvider value={shell}><RouterProvider router={router} /></ShellProvider>);
}
