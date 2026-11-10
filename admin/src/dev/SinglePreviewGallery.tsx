import { useRef, useState } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { EditorWorkspace, type PageContent } from "../components/EditorWorkspace";
import type { AdminBlock } from "../lib/block-factory";
import type { PreviewTarget } from "../lib/saved-preview-operation";
import type { RouteHandle } from "../routes/buildRoutes";
import { ShellProvider, type ShellData } from "../routes/ShellContext";
import { ShellLayout } from "../routes/ShellLayout";

interface PreviewFixture {
  saves: number;
  requests: PreviewTarget[];
  reads: string[];
  releaseSave(): void;
  releaseStatus(): void;
}
declare global { interface Window { __CMS_PREVIEW_FIXTURE__?: PreviewFixture } }
const queueId = "abcdefghijklmnopqrst";
const principal: ShellData["principal"] = { id: "gallery", grants: [{ role: "admin" }] };

/** Dev-gallery-only transport: real workspace and popup, no CMS or public writes. */
export function SinglePreviewGallery() {
  const fixture = useRef<ReturnType<typeof transport> | null>(null);
  if (!fixture.current) fixture.current = transport();
  const { state, props } = fixture.current;
  window.__CMS_PREVIEW_FIXTURE__ = state;
  const page = props.surface.kind === "page";
  const recordKind = props.surface.kind === "record" ? props.surface.record : "post";
  const recordLabel = recordKind[0].toUpperCase() + recordKind.slice(1);
  const [router] = useState(() => createMemoryRouter([
    {
      path: "/",
      element: <ShellLayout />,
      children: [{
        path: "content/*",
        element: <EditorWorkspace principal={principal} {...props} />,
        handle: {
          title: page ? "Page /pages/contact" : `${recordLabel} /${recordKind}s/preview-story`,
          description: "Preview test draft",
        } satisfies RouteHandle,
      }],
    },
  ], { initialEntries: [page ? "/content/pages/contact/edit" : `/content/${recordKind}/preview-story/edit`] }));
  const shell: ShellData = {
    principal,
    user: {
      uid: "gallery",
      email: "preview.editor@example.org",
      displayName: "Preview editor",
    },
    userDoc: {
      role: "admin",
      grants: principal.grants,
      email: "preview.editor@example.org",
      displayName: "Preview editor",
    },
    signOut: () => {},
  };
  return <ShellProvider value={shell}><RouterProvider router={router} /></ShellProvider>;
}

function transport() {
  const parameters = new URLSearchParams(window.location.search);
  const requestedKind = parameters.get("previewKind");
  const page = requestedKind === "page";
  const kind = requestedKind === "program" || requestedKind === "event" ? requestedKind : "post";
  const pagePath = page ? "/contact/" : `/${kind}s/preview-story/`;
  let release = () => {};
  let releaseStatus = () => {};
  const statusReady = parameters.get("waitStatus") === "1"
    ? new Promise<void>(resolve => { releaseStatus = resolve; })
    : Promise.resolve();
  const state: PreviewFixture = { saves: 0, requests: [], reads: [], releaseSave: () => release(), releaseStatus: () => releaseStatus() };
  let stored: Record<string, unknown> = { id: "preview-story", type: kind, title: "Preview test draft", slug: "preview-story", status: "draft", version: 7, blocks: [], credits: [],
    ...(kind === "post" ? {} : { description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Saved preview synopsis and details." }] }] },
      startsAt: "2026-10-13T18:00:00.000Z", previousSlugs: [], locale: "en" }) };
  let storedPage: PageContent = { blocks: [], metadata: { title: "Preview test draft" }, version: 7, status: "draft" };
  let accepted: PreviewTarget;
  return { state, props: {
    surface: page ? { kind: "page" as const, pageId: "contact" as const, section: "genericPage" as const }
      : { kind: "record" as const, record: kind as "post" | "program" | "event", id: "preview-story" },
    loadRecord: async () => ({ status: "ready" as const, record: structuredClone(stored) }),
    loadPage: async () => structuredClone(storedPage),
    savePage: async (_pageId: unknown, _section: unknown, blocks: AdminBlock[]) => {
      state.saves++;
      storedPage = { ...storedPage, blocks: structuredClone(blocks), version: Number(storedPage.version) + 1 };
      return structuredClone(storedPage);
    },
    savePageMetadata: async (_pageId: unknown, _section: unknown, metadata: Record<string, unknown>) => {
      state.saves++;
      storedPage = { ...storedPage, metadata: structuredClone(metadata), version: Number(storedPage.version) + 1 };
      return structuredClone(storedPage);
    },
    saveRecord: async (_kind: unknown, record: Record<string, unknown>) => {
      state.saves++;
      const next = { ...structuredClone(record), version: Number(stored.version) + 1 };
      if (parameters.get("waitSave") === "1") await new Promise<void>(resolve => { release = resolve; });
      stored = next;
      return next;
    },
    requestSavedPreview: async (target: PreviewTarget) => {
      accepted = target; state.requests.push(target);
      return { success: true as const, queueId, ...target, pageId: target.documentId, rendererSha: "a".repeat(40),
        pagePath, previewUrl: null, dispatched: false, status: "pending" as const };
    },
    loadPagePreviewStatus: async (queue: string) => {
      state.reads.push(queue);
      await statusReady;
      return { success: true as const, queueId: queue, ...accepted, pageId: accepted.documentId, rendererSha: "a".repeat(40),
        pagePath, previewUrl: `https://preview.njpbs.org/p/${queue}/`,
        status: "ready" as const, requestedAt: null, completedAt: null, expiresAt: null, error: null };
    },
  } };
}
